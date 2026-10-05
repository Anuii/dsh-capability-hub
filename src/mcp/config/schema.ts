/**
 * 落盘文件 → 生效配置的归一化，以及给界面的服务器视图。
 * 字段白名单、默认值与校验在 ../rules/（宿主与界面共用，ADR-0008）。
 */

import {
  DEFAULT_ENV_FROM_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  LIFECYCLES,
  SERVER_FIELDS,
  serverDefaultsHint,
} from "../rules/server.ts";
import { effectiveSettings } from "../rules/settings.ts";
import { isNatural, isPlainObject } from "../rules/values.ts";
import type {
  EffectiveMcpConfig,
  EffectiveServer,
  Lifecycle,
  McpServerMeta,
  RawMcpConfigFile,
  RawMcpServer,
  ServerView,
} from "../contract/config.ts";

/** 归一化落盘文件里的服务器（不做校验，只做形状修正）。 */
export function toEffectiveServer(raw: RawMcpServer, globalIdleTimeoutMin: number): EffectiveServer {
  return {
    serverName: typeof raw.serverName === "string" ? raw.serverName : "",
    transport: raw.transport === "streamable-http" ? "streamable-http" : "stdio",
    command: raw.command,
    args: Array.isArray(raw.args) ? [...raw.args] : [],
    cwd: raw.cwd,
    env: isPlainObject(raw.env) ? { ...(raw.env as Record<string, string>) } : {},
    envFrom: isPlainObject(raw.envFrom) ? { ...(raw.envFrom as Record<string, string>) } : {},
    allowEmpty: Array.isArray(raw.allowEmpty) ? [...raw.allowEmpty] : [],
    envFromTimeoutMs: isNatural(raw.envFromTimeoutMs) ? raw.envFromTimeoutMs : DEFAULT_ENV_FROM_TIMEOUT_MS,
    url: raw.url,
    headers: isPlainObject(raw.headers) ? { ...(raw.headers as Record<string, string>) } : {},
    toolCallTimeoutMs:
      typeof raw.toolCallTimeoutMs === "number" && Number.isFinite(raw.toolCallTimeoutMs)
        ? raw.toolCallTimeoutMs
        : DEFAULT_TOOL_CALL_TIMEOUT_MS,
    lifecycle: (LIFECYCLES as string[]).includes(raw.lifecycle as string) ? (raw.lifecycle as Lifecycle) : "lazy",
    idleTimeoutMin: isNatural(raw.idleTimeout) ? raw.idleTimeout : globalIdleTimeoutMin,
    includeTools: Array.isArray(raw.includeTools) ? [...raw.includeTools] : undefined,
    excludeTools: Array.isArray(raw.excludeTools) ? [...raw.excludeTools] : undefined,
    searchKeywords: isPlainObject(raw.searchKeywords) ? { ...(raw.searchKeywords as Record<string, string[]>) } : {},
    disabled: raw.disabled === true,
    debug: raw.debug === true,
    meta: isPlainObject(raw.meta) ? { ...(raw.meta as McpServerMeta) } : {},
  };
}

/** 落盘文件 → 生效配置。 */
export function toEffectiveConfig(file: RawMcpConfigFile): EffectiveMcpConfig {
  const settings = effectiveSettings(file.settings);
  const servers = (Array.isArray(file.servers) ? file.servers : [])
    .filter((s) => isPlainObject(s))
    .map((s) => toEffectiveServer(s as RawMcpServer, settings.idleTimeoutMin));
  return { settings, servers };
}

/** 服务器上「显式设置过」的字段名（界面用来区分默认值与用户值）。 */
export function setFieldsOf(raw: RawMcpServer | undefined): string[] {
  if (!isPlainObject(raw)) return [];
  return SERVER_FIELDS.filter((field) => (raw as Record<string, unknown>)[field] !== undefined);
}

/** 生成界面视图（server 已由调用方遮罩）。 */
export function serverView(effective: EffectiveServer, raw: RawMcpServer | undefined): ServerView {
  return {
    ...effective,
    setFields: setFieldsOf(raw),
    defaults: serverDefaultsHint(),
  };
}

/** 空配置。 */
export function emptyRawConfig(): RawMcpConfigFile {
  return { version: 1, settings: {}, servers: [] };
}
