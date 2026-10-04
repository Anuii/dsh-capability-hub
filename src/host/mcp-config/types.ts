/**
 * mcp-config 的类型定义（PLAN §3.1 HubContext/HubModule、§3.5 MCP 配置模型）。
 *
 * 按 PLAN §2「功能模块之间不得互相 import；需要的类型在自己目录内按本契约结构化定义」，
 * 这里按契约逐字段结构化定义，不 import T0 或其他模块的类型。
 */

export type Transport = 'stdio' | 'streamable-http';
export type Lifecycle = 'lazy' | 'lazy-keep-alive' | 'eager' | 'keep-alive';

// —— 平台契约（PLAN §3.1） ——

export interface HubLogger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export interface HubContext {
  homeDir: string;
  dshHome: string;
  hubHome: string;
  profileName: string;
  logger: HubLogger;
  customSkillDirs: string[];
  bundledSkillDir?: string;
}

export type RouteRequest = { query: Record<string, string>; body: unknown; signal: AbortSignal };
export type RouteHandler = (req: RouteRequest) => Promise<unknown>;

export interface HubModule {
  routes: Record<string, RouteHandler>;
  dispose?(): void | Promise<void>;
}

/** 校验错误（PLAN §3.1：VALIDATION 的 details = FieldError[]）。path 为字段路径，message 为中文。 */
export interface FieldError {
  path: string;
  message: string;
}

// —— MCP 配置模型（PLAN §3.5） ——

export interface McpServerMeta {
  description?: string;
  tags?: string[];
  homepage?: string;
}

/**
 * 落盘的服务器对象：只含用户显式设置且不等于默认值的字段。
 * 未出现的字段一律取默认值（见 schema.ts 的 DEFAULTS）。
 */
export interface RawMcpServer {
  serverName?: string;
  transport?: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  envFrom?: Record<string, string>;
  allowEmpty?: string[];
  envFromTimeoutMs?: number;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  toolCallTimeoutMs?: number;
  lifecycle?: Lifecycle;
  idleTimeout?: number;
  includeTools?: string[];
  excludeTools?: string[];
  searchKeywords?: Record<string, string[]>;
  disabled?: boolean;
  debug?: boolean;
  meta?: McpServerMeta;
}

export interface OutputGuard {
  enabled: boolean;
  maxBytes: number;
  maxLines: number;
}

/** 输出护栏的输入形态：true/false 或部分对象（缺的子字段取默认）。 */
export type OutputGuardInput = boolean | { enabled?: boolean; maxBytes?: number; maxLines?: number };

/** 落盘的全局设置：只含非默认项。 */
export interface RawMcpSettings {
  idleTimeout?: number;
  outputGuard?: OutputGuardInput;
  failureBackoffMs?: number;
}

/** hubHome/mcp/config.json 的内容。 */
export interface RawMcpConfigFile {
  version: 1;
  settings: RawMcpSettings;
  servers: RawMcpServer[];
}

/** 解析后的服务器（默认值已补齐、idleTimeout 已解析）。 */
export interface EffectiveServer {
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
  /**
   * 仅展示用（D-C4：描述/标签/主页）。契约未列出该字段，因此声明为可选，
   * 保证与 mcp-runtime 的结构类型（不含 meta）双向兼容。
   */
  meta?: McpServerMeta;
}

export interface EffectiveMcpConfig {
  settings: { idleTimeoutMin: number; outputGuard: OutputGuard; failureBackoffMs: number };
  servers: EffectiveServer[];
}

export interface McpConfigSource {
  get(): EffectiveMcpConfig;
  onChange(listener: (next: EffectiveMcpConfig, prev: EffectiveMcpConfig) => void): () => void;
}

/** 各字段默认值提示（null = 无默认值/不设置；idleTimeout 的 null 表示继承全局）。 */
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

/** 界面视图：已遮罩的 EffectiveServer + 显式设置过的字段 + 默认值提示。 */
export interface ServerView extends EffectiveServer {
  setFields: string[];
  defaults: ServerDefaultsHint;
}

export interface ImportSourceView {
  id: 'claude-code' | 'codex';
  label: string;
  path: string;
  found: boolean;
  /** 已遮罩的服务器（可直接被 upsert 接受，不含额外键） */
  servers: RawMcpServer[];
  warnings: string[];
  /** 服务器名 → 来源（"全局" 或项目路径）；id=codex 时恒为 "全局"。增补字段，UI 可忽略。 */
  origins: Record<string, string>;
}

export interface ParseResult {
  servers: RawMcpServer[];
  warnings: string[];
}

export interface CommandCheckResult {
  found: boolean;
  resolvedPath?: string;
}

/** 命令检查的可注入环境（check-command.ts 的选项）。 */
export interface CommandCheckOptions {
  cwd?: string;
  pathEnv?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
}

export interface McpPreset {
  id: string;
  title: string;
  description: string;
  server: RawMcpServer;
}

export interface ImportApplyResult {
  imported: string[];
  skipped: { name: string; reason: string }[];
}

/** 工厂返回值（PLAN §3.5）。 */
export interface McpConfigModule extends HubModule {
  source: McpConfigSource;
}
