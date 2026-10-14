/**
 * 落盘文件 → 生效配置的归一化，以及给界面的服务器视图。
 * 字段白名单、默认值与校验在 ../rules/（宿主与界面共用，ADR-0008）。
 *
 * 旧配置兼容：0.7.0 废弃的字段（lifecycle、idleTimeout、debug、includeTools、excludeTools、searchKeywords、
 * meta.tags、meta.homepage）与全局 settings 读到时直接丢掉——之后任何一次保存写回的文件里就不再有它们。
 */

import {
  DEFAULT_ENV_FROM_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEPRECATED_FIELDS,
  DEPRECATED_META_FIELDS,
  SERVER_FIELDS,
} from "../rules/server.ts";
import { isNatural, isPlainObject } from "../rules/values.ts";
import type {
  EffectiveMcpConfig,
  EffectiveServer,
  RawMcpConfigFile,
  RawMcpServer,
  ServerView,
} from "../contract/config.ts";

/** 去掉落盘服务器里的废弃字段（不做校验）。 */
export function withoutDeprecated(raw: Record<string, unknown>): RawMcpServer {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key in DEPRECATED_FIELDS) continue;
    if (key === "meta" && isPlainObject(value)) {
      const meta: Record<string, unknown> = {};
      for (const [metaKey, metaValue] of Object.entries(value)) {
        if (!(metaKey in DEPRECATED_META_FIELDS)) meta[metaKey] = metaValue;
      }
      if (Object.keys(meta).length > 0) out.meta = meta;
      continue;
    }
    out[key] = value;
  }
  return out as RawMcpServer;
}

/** 归一化落盘文件里的服务器（不做校验，只做形状修正）。 */
export function toEffectiveServer(raw: RawMcpServer): EffectiveServer {
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
    scope: raw.scope === "session" ? "session" : "global",
    disabled: raw.disabled === true,
    meta:
      isPlainObject(raw.meta) && typeof raw.meta.description === "string" ? { description: raw.meta.description } : {},
  };
}

/** 落盘文件 → 生效配置。 */
export function toEffectiveConfig(file: RawMcpConfigFile): EffectiveMcpConfig {
  const servers = (Array.isArray(file.servers) ? file.servers : [])
    .filter((s) => isPlainObject(s))
    .map((s) => toEffectiveServer(s));
  return { servers };
}

/** 服务器上「显式设置过」的字段名（JSON 编辑只列这些）。 */
export function setFieldsOf(raw: RawMcpServer | undefined): string[] {
  if (!isPlainObject(raw)) return [];
  return SERVER_FIELDS.filter((field) => (raw as Record<string, unknown>)[field] !== undefined);
}

/** 生成界面视图（server 已由调用方遮罩）。 */
export function serverView(effective: EffectiveServer, raw: RawMcpServer | undefined): ServerView {
  return { ...effective, setFields: setFieldsOf(raw) };
}

/** 空配置。 */
export function emptyRawConfig(): RawMcpConfigFile {
  return { version: 1, servers: [] };
}
