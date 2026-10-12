/**
 * MCP 运行时（mcp-runtime）的契约（ADR-0002）：只有类型。
 *
 * 用在两条 seam 上：
 *   - HTTP：GET mcp/runtime、POST mcp/runtime/refresh · disconnect 的响应形状，客户端直接用；
 *   - 进程内：外壳把 McpSdk 注入运行时模块，再把运行时给出的每个 MCP 工具直接注册成 DSH 工具（D-D1），
 *     把服务器说明放进系统提示词，并转发会话事件。
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

/** 一个直接注册给模型的 MCP 工具（D-D1）。 */
export interface McpToolSpec {
  /** 模型看到的名字：mcp__<服务器>__<工具>（有不合规字符或超过 64 字时规范化并加哈希，与 DSH 官方 MCP 客户端同一算法） */
  name: string;
  server: string;
  /** MCP 服务器上的原名（调用时用它） */
  tool: string;
  description: string;
  /** 转换成 DSH 子集之后的 inputSchema（根是 type: "object"） */
  parameters: unknown;
}

/** 运行时模块的进程内接口。 */
export interface McpRuntime {
  /**
   * 现在应当注册的工具：已启用服务器的、按 includeTools / excludeTools 过滤后的、来自工具缓存的工具。
   * 顺序稳定（服务器按配置顺序，工具按名字），内容不变时逐字节相同。
   */
  tools(): McpToolSpec[];
  /** 工具集合或某个定义变了时回调（内容相同不通知）；返回解绑函数。 */
  onToolsChange(cb: () => void): () => void;
  /** 系统提示词里「MCP 服务器」一段的文字（服务器说明 + 服务器自带的用法说明）；没有可用服务器时为空串。 */
  promptText(): string;
  /** 调用一个已注册的工具；失败时抛错，message 是给模型看的说明或服务器原文。 */
  call(name: string, args: unknown, call: McpCallContext): Promise<string>;
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
  /** exposedAs = 模型看到的工具名（mcp__<服务器>__<工具>） */
  tools: { name: string; description?: string; exposedAs?: string }[];
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
