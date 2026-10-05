/**
 * mcp-runtime 的对外契约（PLAN §3.6）。
 *
 * 本文件按结构类型重声明依赖模块的接口，**不 import 任何其他模块的实现**（PLAN §2：
 * 功能模块互不 import，只通过注入的接口协作）。T3a 实现的 McpConfigSource 只要结构对得上即可。
 */

/** PLAN §3.5 transport / lifecycle。 */
export type McpTransport = 'stdio' | 'streamable-http';
export type McpLifecycle = 'lazy' | 'lazy-keep-alive' | 'eager' | 'keep-alive';

/** PLAN §3.5 EffectiveServer（已解析默认值）。 */
export interface EffectiveServer {
  serverName: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  envFrom: Record<string, string>;
  allowEmpty: string[];
  envFromTimeoutMs: number;
  url?: string;
  headers: Record<string, string>;
  toolCallTimeoutMs: number;
  lifecycle: McpLifecycle;
  idleTimeoutMin: number;
  includeTools?: string[];
  excludeTools?: string[];
  searchKeywords: Record<string, string[]>;
  disabled: boolean;
  debug: boolean;
}

/** PLAN §3.5 EffectiveMcpConfig。 */
export interface EffectiveMcpConfig {
  settings: {
    idleTimeoutMin: number;
    outputGuard: { enabled: boolean; maxBytes: number; maxLines: number };
    failureBackoffMs: number;
  };
  servers: EffectiveServer[];
}

/** PLAN §3.5 McpConfigSource（T3a 实现）。 */
export interface McpConfigSource {
  get(): EffectiveMcpConfig;
  onChange(listener: (next: EffectiveMcpConfig, prev: EffectiveMcpConfig) => void): () => void;
}

/**
 * PLAN §3.6 McpSdk。平台层从 DSH 自带 @modelcontextprotocol/client 与 /stdio 加载后注入。
 *
 * 相对 PLAN 的写法有一处**加法**（不改动已有字段）：额外声明可选字段
 * `getDefaultEnvironment`。@modelcontextprotocol/client/stdio 本来就导出它（F1-Q2），
 * 平台层顺手一并注入即可；未注入时 mcp-runtime 使用内置的同名白名单实现。
 */
export interface McpSdk {
  Client: any;
  StdioClientTransport: any;
  StreamableHTTPClientTransport: any;
  getDefaultEnvironment?: () => Record<string, string>;
}

/** PLAN §3.6 McpRuntime。 */
export interface McpRuntime {
  readonly toolName: 'mcp';
  toolParameters(): unknown;
  toolDescription(): string;
  onDescriptionChange(cb: () => void): () => void;
  execute(args: unknown, call: { sessionId: string; parentSessionId?: string; signal: AbortSignal }): Promise<string>;
  sessionStarted(info: { sessionId: string; parentSessionId?: string; title?: string }): void;
  sessionEnded(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

/** 运行态快照（PLAN §3.7 GET mcp/runtime 的返回形状）。 */
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

export interface RuntimeServerView {
  name: string;
  disabled: boolean;
  /**
   * 缓存视图（PLAN §3.7）。
   *
   * \`tools\`（FIX-9）：给 UI 详情抽屉「工具」小节用的工具名清单 ——
   * **已按配置的 includeTools / excludeTools 过滤**（与 search 同一套规则、同一份读侧过滤），按名称排序；
   * \`description\` 只取第一行且最多 160 个字符；**不含 inputSchema**（那是 describe 的职责，
   * 塞进每 5 秒一次的轮询里纯属浪费）。\`toolCount\` 与 \`tools.length\` 恒等。
   */
  cache?: {
    toolCount: number;
    updatedAt: number;
    stale: boolean;
    tools: { name: string; description?: string }[];
  };
  lastFailure?: { message: string; at: number; cooldownUntil?: number };
}

export interface RuntimeStatus {
  servers: RuntimeServerView[];
  sessions: RuntimeSessionView[];
}
