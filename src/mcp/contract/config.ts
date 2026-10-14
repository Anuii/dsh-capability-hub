/**
 * MCP 配置（mcp-config）的契约（ADR-0002）：只有类型。
 *
 * 用在两条 seam 上：
 *   - HTTP：GET mcp/config、POST mcp/servers/* 等的请求 / 响应形状，客户端（src/mcp/client）直接用；
 *   - 进程内：外壳把 McpConfigSource 从配置模块交给运行时模块。
 */

import type { FieldError } from "../../platform/contract/host.ts";
import type { ServerScope } from "./runtime.ts";

export type { FieldError, ServerScope };

export type Transport = "stdio" | "streamable-http";

/** 元信息（D-C4）：0.7.0 起只剩 description，只在界面上显示与搜索，不写给模型。 */
export interface McpServerMeta {
  description?: string;
}

/**
 * 落盘形态的服务器：只含用户显式设置且不等于默认值的字段，未出现的字段一律取默认值。
 * upsert 的请求体与粘贴 JSON 的结果都是这个形状。
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
  /** 进程挂在哪：缺省 = 全局一份；"session" = 每个会话（含子代理）各一份 */
  scope?: ServerScope;
  disabled?: boolean;
  meta?: McpServerMeta;
}

/** 从粘贴的 JSON 里解析出来的服务器：一定有名字。 */
export type ParsedServer = RawMcpServer & { serverName: string };

/** 解析后的服务器（默认值已补齐）。 */
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
  scope: ServerScope;
  disabled: boolean;
  meta?: McpServerMeta;
}

export interface EffectiveMcpConfig {
  servers: EffectiveServer[];
}

/** 配置模块实现、外壳注入运行时模块：读取当前生效配置并订阅变化。 */
export interface McpConfigSource {
  get(): EffectiveMcpConfig;
  onChange(listener: (next: EffectiveMcpConfig, prev: EffectiveMcpConfig) => void): () => void;
}

/** 界面视图：已遮罩的生效服务器（env / headers 的值是 "***hidden***"）+ 显式设置过的字段。 */
export interface ServerView extends EffectiveServer {
  setFields: string[];
}

/** GET mcp/config 的 data。 */
export interface ConfigPayload {
  servers: ServerView[];
  warnings: string[];
}

/** POST mcp/servers/upsert 的 data。 */
export interface UpsertResult {
  server: ServerView;
  warnings: string[];
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

/** hubHome/mcp/config.json 的内容（磁盘格式：0.7.0 起不再写 settings；旧文件里的 settings 与废弃字段读到时忽略）。 */
export interface RawMcpConfigFile {
  version: 1;
  servers: RawMcpServer[];
}
