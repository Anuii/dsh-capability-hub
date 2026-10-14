/**
 * 单服务器 JSON 编辑的纯逻辑（D-C3）：视图 → JSON 文本、JSON 文本 → 对象。
 *
 * JSON 只列显式设置过的字段（默认值不落盘，D-C1），serverName 与 transport 总在；
 * env / headers 的值是遮罩占位符，原样提交即由宿主保留原值（D-C5）。
 * 字段校验不在这里：保存前用与宿主同一份规则（../rules/server.ts 的 parseServerInput，ADR-0008）。
 */

import { SERVER_FIELDS } from "../rules/server.ts";
import { isPlainObject } from "../rules/values.ts";
import { t } from "./strings.ts";
import type { ServerView } from "../contract/config.ts";

/** 视图（已遮罩）→ 编辑用的对象：只搬 setFields 里的字段 + serverName / transport，按白名单顺序。 */
export function serverJsonValues(view: ServerView): Record<string, unknown> {
  const raw = view as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of SERVER_FIELDS) {
    if (field === "serverName") out.serverName = view.serverName;
    else if (field === "transport") out.transport = view.transport;
    else if (view.setFields.includes(field) && raw[field] !== undefined) {
      out[field] = JSON.parse(JSON.stringify(raw[field])) as unknown;
    }
  }
  return out;
}

/** 视图 → JSON 文本（两格缩进）。 */
export function serverJsonText(view: ServerView): string {
  return JSON.stringify(serverJsonValues(view), null, 2);
}

/** JSON 文本 → 对象（只解析，不做业务校验）。 */
export function parseJsonServer(text: string): { values?: Record<string, unknown>; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!isPlainObject(parsed)) return { error: t("mcp.json.needObject") };
  return { values: parsed };
}
