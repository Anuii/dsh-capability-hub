/**
 * MCP 运行时（mcp-runtime）的契约（ADR-0002）：只有类型。
 *
 * 0.7.0 起运行时不再自己连 MCP 服务器，而是把配置里的服务器挂载成 DSH 官方
 * @deepseek-ai/dsh-mcp-client 的插件实例（ADR-0010）。
 *
 * 0.9.0 起只有进程内 seam：外壳把官方插件模块、插件根作用域与工具注册表交给运行时，
 * 并在 agent 创建时转告它。**不再有 HTTP 接口**（页面上没有运行状态、也没有「重新连接」），
 * 挂载状态只经外壳进 GET health 的 mcpServers 与 boot.json；要重试就重启 DSH。
 */

/** 官方 dsh-mcp-client 模块（外壳动态 import 后注入）：Config 校验并补齐配置，整个模块作为插件挂载。 */
export interface McpClientPlugin {
  Config(input: Record<string, unknown>): unknown;
}

/**
 * 能挂插件的作用域：插件根 ctx（全局一份）或 agent.ctx（按会话）。
 * plugin() 返回 cordis 的 Fiber：可以 await（激活完成；官方插件激活失败时 reject），可以 dispose()。
 */
export interface PluginScope {
  plugin(plugin: unknown, config: unknown): unknown;
}

/** 工具注册表里的一项（只取 health 诊断要的字段）。 */
export interface RegisteredTool {
  name: string;
  description?: string;
}

export type ServerScope = "global" | "session";

/**
 * 一台服务器的状态：
 *   connecting 正在连接；connected 已连接且有工具；disconnected 挂着但当前没有工具（断线重连中，或重连已放弃）；
 *   failed 连接失败（error 是原因）；disabled 已停用；session 按会话挂载（sessions = 当前挂着的 agent 数）。
 */
export type ServerState = "connecting" | "connected" | "disconnected" | "failed" | "disabled" | "session";

export interface RuntimeServerView {
  name: string;
  scope: ServerScope;
  state: ServerState;
  /** 模型看到的工具（全局服务器才有；按名字排序，描述只取第一行） */
  tools: RegisteredTool[];
  /** 按会话的服务器：当前挂着它的 agent 数 */
  sessions: number;
  error?: string;
  /** 进入当前状态的时间（毫秒时间戳） */
  since?: number;
}

/** 全部服务器的挂载状态（外壳取它填 health 的 mcpServers 与 boot.json）。 */
export interface RuntimeStatus {
  servers: RuntimeServerView[];
}

/** 运行时模块的进程内接口（外壳用）。 */
export interface McpRuntime {
  /** 挂载全部已启用的全局服务器（后台进行，不阻塞）。 */
  start(): void;
  /** 一个 agent（会话或子代理）创建了：把按会话的服务器挂到它的作用域上。不得阻塞。 */
  agentCreated(sessionId: string, scope: PluginScope): void;
  /** agent 释放了（它作用域里的挂载由 DSH 一起回收，这里只记账）。 */
  agentDisposed(sessionId: string): void;
  /** 挂载状态快照：外壳拿它填 health 的 mcpServers 与 boot.json（页面不读）。 */
  status(): RuntimeStatus;
  dispose(): Promise<void>;
}
