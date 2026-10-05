/**
 * mcp-runtime：把「一个恒定的 mcp 工具」实现为一个懒加载的 MCP 网关。
 *
 * 对应决策：
 * - D-D1 只注册一个工具 mcp，参数 schema 恒定；描述 = 恒定前缀 + 已启用服务器清单（名字 + meta.description 摘要），
 *        不写工具数量。
 * - D-D2 动作 search / describe / call / connect / instructions / status；
 *        search、describe、instructions、status 只读缓存，**绝不起进程**（actions/read.ts）。
 * - D-D3 会话隔离：实例键 = 会话 id + 服务器名；子代理会话各持一套；会话结束全部回收。
 * - D-D4 生命周期二维（启动时机 × 回收）：lazy / lazy-keep-alive / eager / keep-alive。
 * - D-D5 idleTimeout 默认 10 分钟、0 = 不回收；关闭时结束整棵进程树。
 * - D-D6 输出护栏默认 50 KiB / 2000 行，保头部，超出落文件并告诉模型路径。
 * - D-D7 失败退避，失败以文本返回；connect 带 force 可绕过；取消不算失败（failures.ts）。
 * - D-D8 envFrom 失败拒绝启动，绝不注入空值。
 * - D-C6 新增/改配置的服务器后台自动探测一次；每次成功调用后顺带刷新。
 *
 * 结构：core.ts（共享状态与探测）→ actions/（各个动作）、status-view.ts（HTTP 视图）；
 * 本文件负责对外接口：工具描述、动作分派、会话事件、配置变化、空闲巡检与缓存监视。
 */

import { DESCRIPTION_PREFIX, describeEnabledServers, IDLE_SWEEP_INTERVAL_MS } from "./constants.ts";
import { computeConfigHash, isEntryValid } from "./atoms/metadata-cache.ts";

import { PROXY_TOOL_PARAMETERS } from "./tool-schema.ts";
import { RuntimeCore, type CoreOptions, type SessionRef } from "./core.ts";
import { handleDescribe, handleInstructions, handleSearch, renderStatus } from "./actions/read.ts";
import { handleConnect } from "./actions/connect.ts";
import { handleCall } from "./actions/call.ts";
import { runtimeStatusView } from "./status-view.ts";
import type { EffectiveMcpConfig } from "../contract/config.ts";
import type { McpRuntime, RuntimeStatus } from "../contract/runtime.ts";
import { errorText } from "../../shared/error-text.ts";

export { clipToolDescription, probeSessionId } from "./core.ts";
export type { ProbeReason, SessionRef } from "./core.ts";

export const TOOL_NAME = "mcp" as const;

export interface McpRuntimeOptions extends CoreOptions {
  sweepIntervalMs?: number;
  cacheWatchIntervalMs?: number;
  envFromRunner?: never;
}

export interface McpRuntimeInternal extends McpRuntime {
  /** 启动后台巡检与配置监听，并做一次启动探测。 */
  start(): Promise<void>;
  status(): Promise<RuntimeStatus>;
  refresh(serverName: string): Promise<{ toolCount: number }>;
  disconnect(serverName: string, sessionId?: string): Promise<{ closed: number }>;
  /** 手工触发一次空闲巡检（测试用）。 */
  sweepOnce(): Promise<number>;
  /** 等所有后台探测结束（测试用）。 */
  waitForBackgroundWork(): Promise<void>;
  /** 当前是否有后台工作（测试用）。 */
  backgroundCount(): number;
}

/** 工具描述 = 恒定前缀 + 已启用服务器清单（名字 + meta.description 摘要，配置顺序），不写工具数量（D-D1）。 */
function composeDescription(config: EffectiveMcpConfig): string {
  const enabled = (config.servers ?? []).filter((server) => !server.disabled);
  return DESCRIPTION_PREFIX + "\n\n" + describeEnabledServers(enabled);
}

export function createMcpRuntime(options: McpRuntimeOptions): McpRuntimeInternal {
  const core = new RuntimeCore(options);
  const { clock, logger, cache, pool } = core;
  const sweepIntervalMs = options.sweepIntervalMs ?? IDLE_SWEEP_INTERVAL_MS;
  const cacheWatchIntervalMs = options.cacheWatchIntervalMs ?? IDLE_SWEEP_INTERVAL_MS;
  const descriptionListeners = new Set<() => void>();

  let description = composeDescription(core.config);
  let sweepTimer: unknown;
  let cacheWatchTimer: unknown;
  let unsubscribeConfig: (() => void) | undefined;
  let disposed = false;

  // ---------------------------------------------------------------- 配置变化

  function applyConfigChange(next: EffectiveMcpConfig, prev: EffectiveMcpConfig): void {
    core.config = next;
    const nextDescription = composeDescription(next);
    // 只有文本真正变化时才通知（描述字节稳定是 D-D1 的核心要求）。
    if (nextDescription !== description) {
      description = nextDescription;
      for (const listener of [...descriptionListeners]) {
        try {
          listener();
        } catch (err) {
          logger.warn("mcp-runtime 描述变化监听器抛错：" + errorText(err));
        }
      }
    }
    const before = new Map((prev.servers ?? []).map((server) => [server.serverName, server]));
    for (const server of next.servers ?? []) {
      const previous = before.get(server.serverName);
      const hashChanged = !previous || computeConfigHash(previous) !== computeConfigHash(server);
      if (server.disabled) {
        if (previous && !previous.disabled) void pool.closeServer(server.serverName).catch(() => undefined);
        continue;
      }
      if (previous?.disabled && !server.disabled) {
        // 从停用改为启用：等价于新服务器，后台探测一次。
        core.probeInBackground(server, "initial", "探测失败");
        continue;
      }
      if (hashChanged) {
        // 「怎么到达」变了 ⇒ 现有实例已经对不上，直接关掉；缓存按 configHash 自然失效。后台重探一次。
        void pool.closeServer(server.serverName).catch(() => undefined);
        core.probeInBackground(server, previous ? "config-change" : "initial", "的自动探测失败");
      }
    }
  }

  // ---------------------------------------------------------------- 定时任务

  function scheduleSweep(): void {
    sweepTimer = clock.setTimer(() => {
      if (disposed) return;
      // 巡检登记进 background：waitForBackgroundWork()（平台层与测试都用它）才真的等到这轮巡检结束。
      // 不登记的话，「推进时钟 ⇒ 空闲实例已被回收」这类断言会与还没跑完的巡检赛跑。
      core.track(sweepOnce().catch((err) => logger.warn("MCP 空闲巡检失败：" + errorText(err))));
      scheduleSweep();
    }, sweepIntervalMs);
  }

  async function sweepOnce(): Promise<number> {
    await core.ensureCacheLoaded();
    return pool.sweep(clock.now(), (serverName) => core.windowFor(serverName));
  }

  /** 缓存文件可能被另一个 DSH 进程改过：定期重新加载（后台探测会再写回去）。 */
  function scheduleCacheWatch(): void {
    cacheWatchTimer = clock.setTimer(() => {
      if (disposed) return;
      void cache.reloadIfChanged().catch(() => undefined);
      scheduleCacheWatch();
    }, cacheWatchIntervalMs);
  }

  // ---------------------------------------------------------------- 对外接口

  const runtime: McpRuntimeInternal = {
    toolName: TOOL_NAME,

    toolParameters(): unknown {
      // 返回深拷贝：调用方（平台层）可能往 schema 里加东西，不能污染模块常量。
      return JSON.parse(JSON.stringify(PROXY_TOOL_PARAMETERS)) as unknown;
    },

    toolDescription(): string {
      return description;
    },

    onDescriptionChange(cb: () => void): () => void {
      descriptionListeners.add(cb);
      return () => {
        descriptionListeners.delete(cb);
      };
    },

    async execute(args: unknown, call): Promise<string> {
      const session: SessionRef = {
        sessionId: call?.sessionId ?? "default",
        ...(call?.parentSessionId !== undefined ? { parentSessionId: call.parentSessionId } : {}),
      };
      const signal = call?.signal ?? new AbortController().signal;
      try {
        const title = core.sessionMeta.get(session.sessionId)?.title;
        core.sessionMeta.set(session.sessionId, {
          ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
          ...(title !== undefined ? { title } : {}),
        });
        await core.ensureCacheLoaded();
        const params = (unwrapGatewayEnvelope(args) ?? {}) as Record<string, unknown>;
        if (params.search !== undefined) return handleSearch(core, params);
        if (params.describe !== undefined) return handleDescribe(core, params);
        if (params.instructions !== undefined) return handleInstructions(core, params);
        if (params.connect !== undefined) return await handleConnect(core, params, session, signal);
        if (params.tool !== undefined) return await handleCall(core, params, session, signal);
        return renderStatus(core);
      } catch (err) {
        logger.error("mcp 工具执行失败：" + errorText(err));
        return "mcp 工具执行失败：" + errorText(err);
      }
    },

    sessionStarted(info): void {
      try {
        core.sessionMeta.set(info.sessionId, {
          ...(info.parentSessionId !== undefined ? { parentSessionId: info.parentSessionId } : {}),
          ...(info.title !== undefined ? { title: info.title } : {}),
        });
        for (const server of core.enabledServers()) {
          if (server.lifecycle === "eager" || server.lifecycle === "keep-alive") {
            // fire-and-forget，绝不 await：agent/created 是串行派发的，慢活会阻塞会话创建（F1-Q5）。
            core.startResident(server, info);
          }
        }
      } catch (err) {
        logger.warn("MCP 会话启动处理失败：" + errorText(err));
      }
    },

    async sessionEnded(sessionId: string): Promise<void> {
      core.sessionMeta.delete(sessionId);
      const closed = await pool.closeSession(sessionId);
      if (closed > 0) logger.debug("会话 " + sessionId + " 结束，已回收 " + closed + " 个 MCP 服务器实例");
    },

    async dispose(): Promise<void> {
      disposed = true;
      if (sweepTimer !== undefined) clock.clearTimer(sweepTimer);
      if (cacheWatchTimer !== undefined) clock.clearTimer(cacheWatchTimer);
      unsubscribeConfig?.();
      unsubscribeConfig = undefined;
      descriptionListeners.clear();
      await pool.closeAll();
      await Promise.allSettled([...core.background]);
      await core.spill.cleanup();
    },

    async start(): Promise<void> {
      await core.ensureCacheLoaded();
      core.config = core.readConfig();
      description = composeDescription(core.config);
      scheduleSweep();
      scheduleCacheWatch();
      for (const server of core.enabledServers()) {
        if (isEntryValid(cache.get(server.serverName), server, clock.now())) continue;
        core.probeInBackground(server, "startup", "的启动探测失败");
      }
    },

    status: () => runtimeStatusView(core),

    async refresh(serverName: string): Promise<{ toolCount: number }> {
      const server = core.findServer(serverName);
      if (!server) throw new Error('没有名为 "' + serverName + '" 的 MCP 服务器');
      if (server.disabled) throw new Error('服务器 "' + serverName + '" 已停用，无法刷新缓存');
      const entry = await core.probe(server, "manual");
      return { toolCount: entry.tools.length };
    },

    async disconnect(serverName: string, sessionId?: string): Promise<{ closed: number }> {
      if (!core.findServer(serverName)) throw new Error('没有名为 "' + serverName + '" 的 MCP 服务器');
      return { closed: await pool.closeServer(serverName, sessionId) };
    },

    sweepOnce,

    async waitForBackgroundWork(): Promise<void> {
      for (;;) {
        const pending = [...core.background, ...core.probes.values()];
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
        if (core.background.size === 0 && core.probes.size === 0) return;
      }
    },

    backgroundCount(): number {
      return core.background.size + core.probes.size;
    },
  };

  // 配置监听在**构造时**就挂上（而不是在 start() 里）：描述与设置解析不能依赖
  // 「平台层是否调过 start()」。start() 只负责后台工作（空闲巡检、启动探测）。
  unsubscribeConfig = options.config.onChange((next, prev) => {
    try {
      applyConfigChange(next, prev);
    } catch (err) {
      logger.warn("MCP 配置变化处理失败：" + errorText(err));
    }
  });

  return runtime;
}

/**
 * 网关名信封解包（F3-Q1「必须复刻的坑」）。
 *
 * DSH 可能把工具名为 mcp 的调用参数包成 { tool: "mcp", args: <真实参数> }。
 * 若不解包，{ search: "x" } 会被读成「调用一个叫 mcp 的 MCP 工具」，插件看起来装好了、实际完全不可用。
 * 判据（照抄参考实现）：candidate.tool === 'mcp' 且 args 是对象且参数只有 tool/args 两个键。
 * 该机制在 DSH 0.2.0-rc.2 宿主侧**未被证实**（F3 附 B 第 1 条），但防御成本极低、收益极高。
 */
export function unwrapGatewayEnvelope(args: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  const candidate = args as Record<string, unknown>;
  if (Object.keys(candidate).length !== 2) return args;
  if (candidate.tool !== TOOL_NAME) return args;
  const inner = candidate.args;
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return args;
  return inner;
}
