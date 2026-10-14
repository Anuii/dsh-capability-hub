/**
 * MCP 运行时（ADR-0010）：把配置里的服务器挂载成 DSH 官方 @deepseek-ai/dsh-mcp-client 的插件实例。
 *
 * 本插件只管「挂在哪、什么时候挂、挂什么配置」，连接、工具注册、图片、MCP 资源、断线重连、
 * 服务器用法说明进提示词都由官方插件负责：
 *   - scope=global（默认）：挂在插件根作用域，插件启动或启用时连接，所有会话与子代理共用一个进程；
 *   - scope=session：每个 agent（会话或子代理）创建时挂在它的 agent.ctx 上，随 agent 一起释放；
 *   - envFrom 先由本插件执行命令解析成 env，失败就不挂，状态里写原因（绝不注入空值，D-D8）；
 *   - 配置变化按「挂载指纹」只重挂变了的服务器；停用、删除即卸下。
 *
 * 全局挂载用 failOnStartupError: true，这样首次连接失败时能拿到原因（状态显示「连接失败：…」，
 * 由使用者点「重新连接」）；连上之后的断线由官方插件自动重连。按会话的挂载不让失败冒泡到 agent。
 */

import { resolveEnvFrom, type EnvFromRunner } from "./atoms/env-from.ts";
import { conflict, notFound } from "../../shared/errors.ts";
import { errorText } from "../../shared/error-text.ts";
import type { EffectiveMcpConfig, EffectiveServer, McpConfigSource } from "../contract/config.ts";
import type {
  McpClientPlugin,
  McpRuntime,
  PluginScope,
  RegisteredTool,
  RuntimeServerView,
  RuntimeStatus,
} from "../contract/runtime.ts";
import type { HubLogger } from "../../platform/contract/host.ts";

/** 不设超时（toolCallTimeoutMs ≤ 0）时交给官方插件的值：一天。 */
const NO_TIMEOUT_MS = 24 * 3600 * 1000;
/** 描述只取第一行、最多这么多字（界面列表用）。 */
const TOOL_DESCRIPTION_MAX = 160;

export interface McpRuntimeOptions {
  config: McpConfigSource;
  /** 官方 dsh-mcp-client 模块 */
  client: McpClientPlugin;
  /** 插件根作用域：全局一份的服务器挂在这里 */
  root: PluginScope;
  /** 读插件根作用域里已注册的工具（DSH 的 ctx.tools.schemas()） */
  listTools(): RegisteredTool[];
  logger: HubLogger;
  /** envFrom 的命令执行器（测试替换） */
  envFromRunner?: EnvFromRunner;
  now?(): number;
}

export interface McpRuntimeInternal extends McpRuntime {
  /** 卸下再挂上（全局：重连这一个；按会话：在每个现存 agent 上重挂）。 */
  reconnect(name: string): Promise<RuntimeServerView>;
  /** 等所有进行中的挂载与卸载结束（测试与 dispose 用）。 */
  settle(): Promise<void>;
}

/** cordis Fiber 的最小面。 */
interface FiberLike {
  dispose?(): unknown;
  then?(onFulfilled: (value: unknown) => unknown, onRejected: (error: unknown) => unknown): unknown;
}

interface GlobalMount {
  fingerprint: string;
  fiber?: FiberLike;
  state: "connecting" | "connected" | "failed";
  error?: string;
  since: number;
  /** 挂载代次：配置连改两次时，旧的那次结果晚到不能覆盖新的 */
  generation: number;
}

interface AgentMounts {
  scope: PluginScope;
  /** 服务器名 → 指纹与 fiber */
  mounts: Map<string, { fingerprint: string; fiber?: FiberLike }>;
}

/** 影响挂载的字段：变了就要重挂（描述、顺序不算）。 */
export function mountFingerprint(server: EffectiveServer): string {
  return JSON.stringify([
    server.transport,
    server.command ?? "",
    server.args,
    server.cwd ?? "",
    server.env,
    server.envFrom,
    server.allowEmpty,
    server.envFromTimeoutMs,
    server.url ?? "",
    server.headers,
    server.toolCallTimeoutMs,
    server.scope,
  ]);
}

/** 生效服务器 + 解析好的 env → 官方插件的配置输入。 */
export function clientConfigInput(
  server: EffectiveServer,
  env: Record<string, string>,
  failOnStartupError: boolean,
): Record<string, unknown> {
  const toolCallTimeoutMs = server.toolCallTimeoutMs > 0 ? server.toolCallTimeoutMs : NO_TIMEOUT_MS;
  if (server.transport === "streamable-http") {
    return {
      transport: "streamable-http",
      serverName: server.serverName,
      url: server.url ?? "",
      headers: { ...server.headers },
      toolCallTimeoutMs,
      failOnStartupError,
    };
  }
  return {
    transport: "stdio",
    serverName: server.serverName,
    command: server.command ?? "",
    args: [...server.args],
    env,
    ...(server.cwd === undefined || server.cwd === "" ? {} : { cwd: server.cwd }),
    toolCallTimeoutMs,
    failOnStartupError,
  };
}

/** 模型看到的工具名前缀（官方插件的命名：mcp__<服务器>__<工具>；服务器名 ≤32 字，前缀不会被截断）。 */
export function toolPrefix(serverName: string): string {
  return "mcp__" + serverName + "__";
}

function firstLine(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const line = (text.split(/\r\n|\r|\n/, 1)[0] ?? "").trim();
  if (line === "") return undefined;
  if (line.length <= TOOL_DESCRIPTION_MAX) return line;
  const clipped = line.slice(0, TOOL_DESCRIPTION_MAX);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
}

function fiberOf(value: unknown): FiberLike | undefined {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (value as FiberLike)
    : undefined;
}

/** 等 fiber 激活完成：可 await 就 await，不可就当作已完成。 */
async function activated(fiber: FiberLike | undefined): Promise<void> {
  if (fiber === undefined || typeof fiber.then !== "function") return;
  await new Promise<void>((resolve, reject) => {
    fiber.then!(
      () => resolve(),
      (error) => reject(error),
    );
  });
}

/** 官方插件激活失败时的原因：错误本身多半是「initial connection … failed」，真正的原因在 cause 里。 */
function failureText(error: unknown): string {
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  return cause === undefined ? errorText(error) : errorText(cause);
}

export function createMcpRuntime(options: McpRuntimeOptions): McpRuntimeInternal {
  const { config, client, root, logger } = options;
  const now = options.now ?? (() => Date.now());
  const globals = new Map<string, GlobalMount>();
  const agents = new Map<string, AgentMounts>();
  /** 按会话服务器解析好的 env：指纹 → 值（配置变了指纹就变，自然失效；重新连接时清掉） */
  const sessionEnv = new Map<string, Promise<{ env?: Record<string, string>; error?: string }>>();
  const pending = new Set<Promise<unknown>>();
  /** 正在卸下的全局挂载：同名服务器重挂前要等它卸完（官方插件按作用域占用 serverName，旧的没卸完新的会撞名） */
  const unmounting = new Map<string, Promise<void>>();
  let current: EffectiveMcpConfig = config.get();
  let started = false;
  let disposed = false;
  let generation = 0;

  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };

  const dispose = async (fiber: FiberLike | undefined, label: string): Promise<void> => {
    if (fiber === undefined || typeof fiber.dispose !== "function") return;
    try {
      await fiber.dispose();
    } catch (error) {
      logger.warn("卸下 MCP 服务器 " + label + " 时出错：" + errorText(error));
    }
  };

  /** 解析 envFrom（没有就直接返回 env）。 */
  const resolveEnv = async (server: EffectiveServer): Promise<{ env?: Record<string, string>; error?: string }> => {
    if (Object.keys(server.envFrom).length === 0) return { env: { ...server.env } };
    const result = await resolveEnvFrom({
      envFrom: server.envFrom,
      allowEmpty: server.allowEmpty,
      timeoutMs: server.envFromTimeoutMs,
      ...(options.envFromRunner === undefined ? {} : { runner: options.envFromRunner }),
    });
    if (result.failures.length > 0) {
      return { error: "envFrom 取值失败：" + result.failures.map((failure) => failure.message).join("；") };
    }
    return { env: { ...server.env, ...result.values } };
  };

  // ---------------------------------------------------------------- 全局一份

  const mountGlobal = (server: EffectiveServer): Promise<void> => {
    const fingerprint = mountFingerprint(server);
    const gen = ++generation;
    const entry: GlobalMount = { fingerprint, state: "connecting", since: now(), generation: gen };
    globals.set(server.serverName, entry);
    const run = async (): Promise<void> => {
      await unmounting.get(server.serverName);
      const resolved = await resolveEnv(server);
      if (globals.get(server.serverName) !== entry || disposed) return;
      if (resolved.env === undefined) {
        Object.assign(entry, { state: "failed", error: resolved.error, since: now() });
        logger.warn("MCP 服务器 " + server.serverName + " 没有挂载：" + resolved.error);
        return;
      }
      let fiber: FiberLike | undefined;
      try {
        fiber = fiberOf(root.plugin(client, client.Config(clientConfigInput(server, resolved.env, true))));
        entry.fiber = fiber;
        await activated(fiber);
        if (globals.get(server.serverName) !== entry) return;
        Object.assign(entry, { state: "connected", error: undefined, since: now() });
      } catch (error) {
        const message = failureText(error);
        logger.warn("MCP 服务器 " + server.serverName + " 连接失败：" + message);
        await dispose(fiber, server.serverName);
        if (globals.get(server.serverName) !== entry) return;
        Object.assign(entry, { state: "failed", error: message, fiber: undefined, since: now() });
      }
    };
    return track(run());
  };

  const unmountGlobal = (name: string): Promise<void> => {
    const entry = globals.get(name);
    globals.delete(name);
    const previous = unmounting.get(name) ?? Promise.resolve();
    const job: Promise<void> = previous.then(() => dispose(entry?.fiber, name));
    unmounting.set(name, job);
    void job.then(() => {
      if (unmounting.get(name) === job) unmounting.delete(name);
    });
    return track(job);
  };

  // ---------------------------------------------------------------- 按会话

  const sessionEnvOf = (server: EffectiveServer): Promise<{ env?: Record<string, string>; error?: string }> => {
    const key = server.serverName + "\u0000" + mountFingerprint(server);
    let cached = sessionEnv.get(key);
    if (cached === undefined) {
      cached = resolveEnv(server);
      sessionEnv.set(key, cached);
    }
    return cached;
  };

  const mountOnAgent = (sessionId: string, record: AgentMounts, server: EffectiveServer): Promise<void> => {
    const slot = { fingerprint: mountFingerprint(server) } as { fingerprint: string; fiber?: FiberLike };
    record.mounts.set(server.serverName, slot);
    const run = async (): Promise<void> => {
      const resolved = await sessionEnvOf(server);
      if (record.mounts.get(server.serverName) !== slot || agents.get(sessionId) !== record || disposed) return;
      if (resolved.env === undefined) {
        logger.warn("MCP 服务器 " + server.serverName + " 没有挂到会话 " + sessionId + "：" + resolved.error);
        return;
      }
      try {
        slot.fiber = fiberOf(
          record.scope.plugin(client, client.Config(clientConfigInput(server, resolved.env, false))),
        );
        await activated(slot.fiber);
      } catch (error) {
        logger.warn("MCP 服务器 " + server.serverName + " 挂到会话 " + sessionId + " 失败：" + failureText(error));
      }
    };
    return track(run());
  };

  const sessionServers = (): EffectiveServer[] =>
    current.servers.filter((server) => !server.disabled && server.scope === "session" && server.serverName !== "");
  const globalServers = (): EffectiveServer[] =>
    current.servers.filter((server) => !server.disabled && server.scope === "global" && server.serverName !== "");

  /** 让全局挂载与每个 agent 的挂载对齐当前配置。 */
  const reconcile = (): void => {
    if (!started || disposed) return;
    const wantGlobal = new Map(globalServers().map((server) => [server.serverName, server]));
    for (const name of [...globals.keys()]) {
      const want = wantGlobal.get(name);
      if (want === undefined || mountFingerprint(want) !== globals.get(name)!.fingerprint) void unmountGlobal(name);
    }
    for (const [name, server] of wantGlobal) {
      if (!globals.has(name)) void mountGlobal(server);
    }
    const wantSession = new Map(sessionServers().map((server) => [server.serverName, server]));
    for (const [sessionId, record] of agents) {
      for (const [name, server] of wantSession) {
        const slot = record.mounts.get(name);
        if (slot !== undefined && slot.fingerprint === mountFingerprint(server)) continue;
        if (slot === undefined) {
          void mountOnAgent(sessionId, record, server);
          continue;
        }
        // 配置变了：先卸旧的再挂新的（同一作用域里同名会撞）
        record.mounts.delete(name);
        void track(
          dispose(slot.fiber, name + "@" + sessionId).then(() => {
            if (agents.get(sessionId) === record && !record.mounts.has(name) && !disposed) {
              return mountOnAgent(sessionId, record, server);
            }
            return undefined;
          }),
        );
      }
      for (const [name, slot] of [...record.mounts]) {
        if (wantSession.has(name)) continue;
        record.mounts.delete(name);
        void track(dispose(slot.fiber, name + "@" + sessionId));
      }
    }
  };

  const unsubscribe = config.onChange((next) => {
    current = next;
    reconcile();
  });

  // ---------------------------------------------------------------- 状态

  const viewOf = (server: EffectiveServer, tools: RegisteredTool[]): RuntimeServerView => {
    const base = { name: server.serverName, scope: server.scope, tools: [] as RegisteredTool[], sessions: 0 };
    if (server.disabled) return { ...base, state: "disabled" };
    if (server.scope === "session") {
      let sessions = 0;
      for (const record of agents.values()) if (record.mounts.has(server.serverName)) sessions += 1;
      return { ...base, state: "session", sessions };
    }
    const entry = globals.get(server.serverName);
    if (entry === undefined) return { ...base, state: "connecting" };
    const prefix = toolPrefix(server.serverName);
    const mine = tools
      .filter((tool) => tool.name.startsWith(prefix))
      .map((tool) => {
        const description = firstLine(tool.description);
        return description === undefined ? { name: tool.name } : { name: tool.name, description };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const view: RuntimeServerView = { ...base, state: entry.state, tools: mine, since: entry.since };
    if (entry.error !== undefined) view.error = entry.error;
    // 挂着但一个工具都没有：断线后官方插件在重连（或已放弃）
    if (entry.state === "connected" && mine.length === 0) view.state = "disconnected";
    return view;
  };

  const readTools = (): RegisteredTool[] => {
    try {
      return options.listTools();
    } catch (error) {
      logger.warn("读取已注册的工具失败：" + errorText(error));
      return [];
    }
  };

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      current = config.get();
      reconcile();
    },

    agentCreated(sessionId: string, scope: PluginScope): void {
      if (disposed || agents.has(sessionId)) return;
      const record: AgentMounts = { scope, mounts: new Map() };
      agents.set(sessionId, record);
      for (const server of sessionServers()) void mountOnAgent(sessionId, record, server);
    },

    agentDisposed(sessionId: string): void {
      // 挂在 agent.ctx 上的插件随作用域一起回收，这里只记账
      agents.delete(sessionId);
    },

    status(): RuntimeStatus {
      const tools = readTools();
      return {
        servers: current.servers.filter((server) => server.serverName !== "").map((server) => viewOf(server, tools)),
      };
    },

    async reconnect(name: string): Promise<RuntimeServerView> {
      const server = current.servers.find((item) => item.serverName === name);
      if (server === undefined) throw notFound("找不到服务器「" + name + "」。");
      if (server.disabled) throw conflict("服务器「" + name + "」已停用，先启用再重新连接。");
      if (server.scope === "session") {
        for (const key of [...sessionEnv.keys()]) if (key.startsWith(name + "\u0000")) sessionEnv.delete(key);
        const jobs: Promise<void>[] = [];
        for (const [sessionId, record] of agents) {
          const slot = record.mounts.get(name);
          record.mounts.delete(name);
          jobs.push(dispose(slot?.fiber, name + "@" + sessionId).then(() => mountOnAgent(sessionId, record, server)));
        }
        await Promise.all(jobs);
      } else {
        await unmountGlobal(name);
        await mountGlobal(server);
      }
      return viewOf(server, readTools());
    },

    async settle(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      const jobs: Promise<void>[] = [];
      for (const [name, entry] of globals) jobs.push(dispose(entry.fiber, name));
      globals.clear();
      for (const [sessionId, record] of agents) {
        for (const [name, slot] of record.mounts) jobs.push(dispose(slot.fiber, name + "@" + sessionId));
      }
      agents.clear();
      await Promise.all(jobs);
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
