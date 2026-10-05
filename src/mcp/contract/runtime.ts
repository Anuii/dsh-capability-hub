/**
 * MCP 懒加载运行时（mcp-runtime）的契约（ADR-0002）：只有类型。
 *
 * 用在两条 seam 上：
 *   - HTTP：GET mcp/runtime、POST mcp/runtime/refresh · disconnect 的响应形状，客户端直接用；
 *   - 进程内：外壳把 McpSdk 注入运行时模块，并通过 McpRuntime 注册 mcp 工具、转发会话事件。
 */

/**
 * 外壳从 DSH 自带的 @modelcontextprotocol/client 与 /stdio 加载后注入。
 * getDefaultEnvironment 未注入时，运行时用内置的同名白名单实现。
 */
export interface McpSdk {
  // SDK 没有可用的类型声明（宿主外置），运行时按构造函数使用。
  // deno-lint-ignore no-explicit-any
  Client: any;
  // deno-lint-ignore no-explicit-any
  StdioClientTransport: any;
  // deno-lint-ignore no-explicit-any
  StreamableHTTPClientTransport: any;
  getDefaultEnvironment?: () => Record<string, string>;
}

/** 一次工具调用的执行上下文。 */
export interface McpCallContext {
  sessionId: string;
  parentSessionId?: string;
  signal: AbortSignal;
}

/** 会话开始信息。 */
export interface McpSessionInfo {
  sessionId: string;
  parentSessionId?: string;
  title?: string;
}

/** 运行时模块的进程内接口（外壳用它注册 mcp 工具）。 */
export interface McpRuntime {
  readonly toolName: "mcp";
  /** 工具参数的原始 JSON Schema（恒定，不随配置变化；顶层 type: "object"）。 */
  toolParameters(): unknown;
  /** 恒定前缀 + 已启用服务器名（配置顺序），不写工具数量。 */
  toolDescription(): string;
  /** 描述变化回调；返回解绑函数。 */
  onDescriptionChange(cb: () => void): () => void;
  /** 永不 reject；失败以文本返回。 */
  execute(args: unknown, call: McpCallContext): Promise<string>;
  /** 不得阻塞。 */
  sessionStarted(info: McpSessionInfo): void;
  sessionEnded(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

/** 连接池里的一个实例（state：ready / connecting / failed / closing / closed）。 */
export interface RuntimeInstanceView {
  server: string;
  state: string;
  startedAt: number;
  lastUsedAt: number;
  pid?: number;
}

export interface RuntimeSessionView {
  sessionId: string;
  parentSessionId?: string;
  title?: string;
  instances: RuntimeInstanceView[];
}

/**
 * 工具缓存。tools 已按 includeTools / excludeTools 过滤、按名称排序，description 只取第一行且最多 160 字，
 * 不含 inputSchema；toolCount 与 tools.length 恒等。
 */
export interface RuntimeCacheView {
  toolCount: number;
  updatedAt: number;
  /** 缓存过期或与当前配置不匹配 */
  stale: boolean;
  tools: { name: string; description?: string }[];
}

/** 最近一次失败；cooldownUntil 只在冷却未结束时出现。 */
export interface RuntimeFailureView {
  message: string;
  at: number;
  cooldownUntil?: number;
}

export interface RuntimeServerView {
  name: string;
  disabled: boolean;
  cache?: RuntimeCacheView;
  lastFailure?: RuntimeFailureView;
}

/** GET mcp/runtime 的 data。 */
export interface RuntimeStatus {
  servers: RuntimeServerView[];
  sessions: RuntimeSessionView[];
}

/** POST mcp/runtime/refresh 的 data。 */
export interface RuntimeRefreshResult {
  toolCount: number;
}

/** POST mcp/runtime/disconnect 的 data。 */
export interface RuntimeDisconnectResult {
  closed: number;
}
