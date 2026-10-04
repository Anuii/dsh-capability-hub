/**
 * 宿主 mcp-config / mcp-runtime 契约的**客户端镜像**（PLAN §3.5 / §3.7 的 HTTP 形状）。
 *
 * 为什么不 import 宿主类型：宿主半与浏览器半是两份产物，客户端不应该把 Node 侧模块
 * 拉进 bundle（PLAN §2：功能模块之间不得互相 import）。这里按响应逐字段复制，
 * 源头是 src/host/mcp-config/{types,schema,module}.ts 与 src/host/mcp-runtime/contract.ts ——
 * 改契约时两处一起改。
 */

export type Transport = "stdio" | "streamable-http";
export type Lifecycle = "lazy" | "lazy-keep-alive" | "eager" | "keep-alive";

/** 仅展示用的元信息（D-C4）。 */
export interface McpServerMeta {
  description?: string;
  tags?: string[];
  homepage?: string;
}

/** 各字段默认值提示（来自 ServerView.defaults；null = 无默认值/不设置）。 */
export interface ServerDefaultsHint {
  command: null;
  args: string[];
  cwd: null;
  env: Record<string, string>;
  envFrom: Record<string, string>;
  allowEmpty: string[];
  envFromTimeoutMs: number;
  url: null;
  headers: Record<string, string>;
  toolCallTimeoutMs: number;
  lifecycle: Lifecycle;
  idleTimeout: null;
  includeTools: null;
  excludeTools: null;
  searchKeywords: Record<string, string[]>;
  disabled: boolean;
  debug: boolean;
  meta: McpServerMeta;
}

/**
 * GET mcp/config 的 servers[]（= 已遮罩的生效服务器 + 显式设置过的字段 + 默认值提示）。
 * env / headers 的值一律是 "***hidden***"。
 */
export interface ServerView {
  serverName: string;
  transport: Transport;
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
  lifecycle: Lifecycle;
  /** 已解析：服务器值 ?? 全局值 */
  idleTimeoutMin: number;
  includeTools?: string[];
  excludeTools?: string[];
  searchKeywords: Record<string, string[]>;
  disabled: boolean;
  debug: boolean;
  meta?: McpServerMeta;
  /** 用户显式设置过的字段名（界面用来区分「已设置」与「默认值」）。 */
  setFields: string[];
  defaults: ServerDefaultsHint;
}

/** 输出护栏的生效值。 */
export interface OutputGuard {
  enabled: boolean;
  maxBytes: number;
  maxLines: number;
}

/** 全局设置的生效值。 */
export interface McpSettings {
  idleTimeoutMin: number;
  outputGuard: OutputGuard;
  failureBackoffMs: number;
}

/** GET mcp/config 的 data。 */
export interface ConfigPayload {
  settings: McpSettings;
  /** 落盘里显式存在的全局设置项。 */
  settingsSet: string[];
  servers: ServerView[];
  warnings: string[];
}

/** 服务端 VALIDATION 的一条字段错误。 */
export interface FieldError {
  path: string;
  message: string;
}

/** POST mcp/servers/upsert 的 data。 */
export interface UpsertResult {
  server: ServerView;
  warnings: string[];
}

/** POST mcp/validate 的 data。 */
export interface ValidateResult {
  errors: FieldError[];
  server?: unknown;
}

/** POST mcp/servers/reveal 的 data（env / headers 是明文）。 */
export interface RevealResult {
  server: ServerView;
}

/** POST mcp/check-command 的 data。 */
export interface CommandCheckResult {
  found: boolean;
  resolvedPath?: string;
}

/** GET mcp/runtime 的 servers[].cache（tools 目前宿主不返回，留着向前兼容）。 */
export interface RuntimeCacheView {
  toolCount: number;
  updatedAt: number;
  stale: boolean;
  tools?: Array<{ name: string; description?: string }>;
}

/** GET mcp/runtime 的 servers[]。 */
export interface RuntimeServerView {
  name: string;
  disabled: boolean;
  cache?: RuntimeCacheView;
  lastFailure?: RuntimeFailureView;
}

/** GET mcp/runtime 的 servers[].lastFailure（cooldownUntil 只在冷却未结束时出现）。 */
export interface RuntimeFailureView {
  message: string;
  at: number;
  cooldownUntil?: number;
}

/** GET mcp/runtime 的 sessions[]（MCP 页只用来数活跃实例）。 */
export interface RuntimeSessionLite {
  sessionId?: string;
  instances: Array<{ server: string }>;
}

/** GET mcp/runtime 的 data（本标签只读 servers 与实例计数，会话展示归运行态标签）。 */
export interface RuntimeStatus {
  servers: RuntimeServerView[];
  sessions?: RuntimeSessionLite[];
}

/* ------------------------------------------------------------------ *
 * T4b-2：粘贴 JSON / 预设模板 / 只读导入（D-C2）的契约镜像
 * 源头：src/host/mcp-config/intake.ts 与 src/host/mcp-config/module.ts
 * ------------------------------------------------------------------ */

/**
 * 宿主 mapServerFields() 产出的「落盘形态」服务器（parse-json / presets / import 三处共用）。
 * 只有这些字段会被识别，其余键在 warnings 里点名后被忽略。
 */
export interface RawParsedServer {
  serverName: string;
  transport?: Transport;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  lifecycle?: Lifecycle;
  disabled?: boolean;
  debug?: boolean;
}

/** POST mcp/parse-json { text } → { servers, warnings }。 */
export interface ParseJsonResult {
  servers: RawParsedServer[];
  warnings: string[];
}

/** GET mcp/presets → presets[]（commandFound / resolvedPath 是宿主顺手做的 PATH 检查，只查不执行）。 */
export interface McpPreset {
  id: string;
  title: string;
  description: string;
  server: RawParsedServer;
  commandFound?: boolean;
  resolvedPath?: string;
}

export interface PresetsPayload {
  presets: McpPreset[];
}

/** 只读导入来源（Claude Code / Codex）。servers 的值已遮罩。 */
export interface ImportSourceView {
  id: "claude-code" | "codex";
  label: string;
  path: string;
  found: boolean;
  servers: RawParsedServer[];
  warnings: string[];
  origins: Record<string, string>;
}

export interface ImportSourcesPayload {
  sources: ImportSourceView[];
}

/** 导入时被跳过的服务器及原因。 */
export interface SkippedServer {
  name: string;
  reason: string;
}

/** POST mcp/import/apply { sourceId, names } 的 data。 */
export interface ImportApplyResult {
  imported: string[];
  skipped: SkippedServer[];
  servers: ServerView[];
  warnings: string[];
}

