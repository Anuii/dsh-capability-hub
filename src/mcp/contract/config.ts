/**
 * MCP 配置（mcp-config）的契约（ADR-0002）：只有类型。
 *
 * 用在两条 seam 上：
 *   - HTTP：GET mcp/config、POST mcp/servers/* 等的请求 / 响应形状，客户端（src/mcp/client）直接用；
 *   - 进程内：外壳把 McpConfigSource 从配置模块交给运行时模块。
 */

import type { FieldError } from "../../platform/contract/host.ts";

export type { FieldError };

export type Transport = "stdio" | "streamable-http";
export type Lifecycle = "lazy" | "lazy-keep-alive" | "eager" | "keep-alive";

/** 元信息（D-C4）：description 也会写进 mcp 工具的描述（第一行、最多 160 字，D-D1）；tags / homepage 只用于界面展示。 */
export interface McpServerMeta {
  description?: string;
  tags?: string[];
  homepage?: string;
}

/**
 * 落盘形态的服务器：只含用户显式设置且不等于默认值的字段，未出现的字段一律取默认值。
 * upsert 的请求体、只读导入与粘贴 JSON 的结果都是这个形状。
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

/** 从粘贴的 JSON、预设模板或只读导入里解析出来的服务器：一定有名字。 */
export type ParsedServer = RawMcpServer & { serverName: string };

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
  /** 元信息：运行时只读 description（写进 mcp 工具描述），其余仅展示 */
  meta?: McpServerMeta;
}

export interface EffectiveMcpConfig {
  settings: McpSettings;
  servers: EffectiveServer[];
}

/** 配置模块实现、外壳注入运行时模块：读取当前生效配置并订阅变化。 */
export interface McpConfigSource {
  get(): EffectiveMcpConfig;
  onChange(listener: (next: EffectiveMcpConfig, prev: EffectiveMcpConfig) => void): () => void;
}

/** 各字段默认值提示（null = 无默认值 / 不设置；idleTimeout 的 null 表示继承全局）。 */
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

/** 界面视图：已遮罩的生效服务器（env / headers 的值是 "***hidden***"）+ 显式设置过的字段 + 默认值提示。 */
export interface ServerView extends EffectiveServer {
  setFields: string[];
  defaults: ServerDefaultsHint;
}

/** GET mcp/config 的 data。 */
export interface ConfigPayload {
  settings: McpSettings;
  /** 落盘里显式存在的全局设置项。 */
  settingsSet: string[];
  servers: ServerView[];
  warnings: string[];
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

/** POST mcp/check-command 的 data（只查 PATH，不执行）。 */
export interface CommandCheckResult {
  found: boolean;
  resolvedPath?: string;
}

/** POST mcp/parse-json 的 data。 */
export interface ParseResult {
  servers: ParsedServer[];
  warnings: string[];
}

/** 预设模板。 */
export interface McpPreset {
  id: string;
  title: string;
  description: string;
  server: ParsedServer;
}

/** GET mcp/presets 的一项：宿主顺手做了 PATH 检查（只查不执行）。 */
export interface PresetView extends McpPreset {
  commandFound?: boolean;
  resolvedPath?: string;
}

export interface PresetsPayload {
  presets: PresetView[];
}

/** 只读导入来源（Claude Code / Codex）。servers 的值已遮罩。 */
export interface ImportSourceView {
  id: "claude-code" | "codex";
  label: string;
  path: string;
  found: boolean;
  servers: ParsedServer[];
  warnings: string[];
  /** 服务器名 → 来源（"全局" 或项目路径）；id=codex 时恒为 "全局" */
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

export interface ImportApplyResult {
  imported: string[];
  skipped: SkippedServer[];
}

/** POST mcp/import/apply 的 data。 */
export interface ImportApplyResponse extends ImportApplyResult {
  servers: ServerView[];
  warnings: string[];
}
