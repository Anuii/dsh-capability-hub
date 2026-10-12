/**
 * mcp-runtime：把已配置的 MCP 服务器的每个工具直接交给 DSH 注册（D-D1），并在调用时按需起进程。
 *
 * 对应决策：
 * - D-D1 每个已启用服务器的每个可见工具注册成 DSH 工具 mcp__<服务器>__<工具>（来自工具缓存，
 *        参数 schema 转成 DSH 子集）；服务器说明与服务器自带的用法说明进系统提示词。
 * - D-D3 会话隔离：实例键 = 会话 id + 服务器名；子代理会话各持一套；会话结束全部回收。
 * - D-D4 生命周期二维（启动时机 × 回收）：lazy / lazy-keep-alive / eager / keep-alive。
 * - D-D5 idleTimeout 默认 10 分钟、0 = 不回收；关闭时结束整棵进程树。
 * - D-D6 输出护栏默认 50 KiB / 2000 行，保头部，超出落文件并告诉模型路径。
 * - D-D7 失败退避；取消不算失败（failures.ts）。
 * - D-D8 envFrom 失败拒绝启动，绝不注入空值。
 * - D-C6 新增/改配置的服务器后台自动探测一次（拉清单 → 工具随之注册）；每次成功调用后顺带刷新。
 *
 * 结构：core.ts（共享状态与探测）→ tool-specs.ts（工具清单与提示词）、actions/call.ts（调用）、
 * status-view.ts（HTTP 视图）；本文件负责对外接口、工具集合变化通知、会话事件、配置变化与定时任务。
 */

import { IDLE_SWEEP_INTERVAL_MS } from "./constants.ts";
import { computeConfigHash, isEntryValid } from "./atoms/metadata-cache.ts";
import { RuntimeCore, type CoreOptions, type SessionRef } from "./core.ts";
import { buildPromptText, buildToolSpecs } from "./tool-specs.ts";
import { callTool } from "./actions/call.ts";
import { runtimeStatusView } from "./status-view.ts";
import type { EffectiveMcpConfig } from "../contract/config.ts";
import type { McpRuntime, McpToolSpec, RuntimeStatus } from "../contract/runtime.ts";
import { errorText } from "../../shared/error-text.ts";
import { conflict, notFound, upstream } from "../../shared/errors.ts";

export { clipToolDescription, probeSessionId } from "./core.ts";
export type { ProbeReason, SessionRef } from "./core.ts";

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

export function createMcpRuntime(options: McpRuntimeOptions): McpRuntimeInternal {
  const core = new RuntimeCore(options);
  const { clock, logger, cache, pool } = core;
  const sweepIntervalMs = options.sweepIntervalMs ?? IDLE_SWEEP_INTERVAL_MS;
  const cacheWatchIntervalMs = options.cacheWatchIntervalMs ?? IDLE_SWEEP_INTERVAL_MS;
  const toolListeners = new Set<() => void>();

  let specs: McpToolSpec[] = buildToolSpecs(core);
  let fingerprint = JSON.stringify(specs);
  let sweepTimer: unknown;
  let cacheWatchTimer: unknown;
  let unsubscribeConfig: (() => void) | undefined;
  let disposed = false;

  // ---------------------------------------------------------------- 工具集合

  /** 重新计算要注册的工具；内容真的变了才通知（注册集合稳定，提示词前缀缓存才不失效）。 */
  function checkTools(): void {
    const next = buildToolSpecs(core);
    const nextFingerprint = JSON.stringify(next);
    if (nextFingerprint === fingerprint) return;
    specs = next;
    fingerprint = nextFingerprint;
    for (const listener of [...toolListeners]) {
      try {
        listener();
      } catch (err) {
        logger.warn("mcp-runtime 工具变化监听器抛错：" + errorText(err));
      }
    }
  }
  core.cacheListeners.add(checkTools);

  // ---------------------------------------------------------------- 配置变化

  function applyConfigChange(next: EffectiveMcpConfig, prev: EffectiveMcpConfig): void {
    core.config = next;
    checkTools();
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
      void core.ensureCacheLoaded().catch(() => undefined);
      scheduleCacheWatch();
    }, cacheWatchIntervalMs);
  }

  // ---------------------------------------------------------------- 对外接口

  const runtime: McpRuntimeInternal = {
    tools: () => specs,

    onToolsChange(cb: () => void): () => void {
      toolListeners.add(cb);
      return () => {
        toolListeners.delete(cb);
      };
    },

    promptText: () => buildPromptText(core, specs),

    async call(name: string, args: unknown, call): Promise<string> {
      const session: SessionRef = {
        sessionId: call.sessionId,
        ...(call.parentSessionId !== undefined ? { parentSessionId: call.parentSessionId } : {}),
      };
      const title = core.sessionMeta.get(session.sessionId)?.title;
      core.sessionMeta.set(session.sessionId, {
        ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
        ...(title !== undefined ? { title } : {}),
      });
      const spec = specs.find((item) => item.name === name);
      if (spec === undefined) {
        throw new Error("工具 " + name + " 已不存在：它所在的 MCP 服务器可能已停用、删除，或工具清单刚刚变了。");
      }
      return callTool(core, spec, args, session, call.signal);
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
      toolListeners.clear();
      core.cacheListeners.delete(checkTools);
      await pool.closeAll();
      await Promise.allSettled([...core.background]);
      await core.spill.cleanup();
    },

    async start(): Promise<void> {
      core.config = core.readConfig();
      await core.ensureCacheLoaded();
      checkTools();
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
      if (!server) throw notFound('没有名为 "' + serverName + '" 的 MCP 服务器');
      if (server.disabled) throw conflict('服务器 "' + serverName + '" 已停用，无法刷新缓存');
      try {
        const entry = await core.probe(server, "manual");
        return { toolCount: entry.tools.length };
      } catch (err) {
        // MCP 服务器连不上 / 拉清单失败：它是这次请求的上游
        throw upstream(errorText(err));
      }
    },

    async disconnect(serverName: string, sessionId?: string): Promise<{ closed: number }> {
      if (!core.findServer(serverName)) throw notFound('没有名为 "' + serverName + '" 的 MCP 服务器');
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

  // 配置监听在**构造时**就挂上（而不是在 start() 里）：工具集合与设置解析不能依赖
  // 「平台层是否调过 start()」。start() 只负责后台工作（读缓存、空闲巡检、启动探测）。
  unsubscribeConfig = options.config.onChange((next, prev) => {
    try {
      applyConfigChange(next, prev);
    } catch (err) {
      logger.warn("MCP 配置变化处理失败：" + errorText(err));
    }
  });

  return runtime;
}
