/** mcp 工具返回给模型的文字里共用的小片段。 */

import { seconds } from "./failures.ts";
import type { DocEntry, RuntimeCore } from "./core.ts";

export const NO_SERVERS_HINT = "当前没有已启用的 MCP 服务器。请到「能力中心 → MCP 服务器」标签添加并启用一个。";

/** 实例状态 → 中文。 */
export function stateText(state: string): string {
  switch (state) {
    case "ready":
      return "就绪";
    case "connecting":
      return "连接中";
    case "failed":
      return "失败";
    case "closing":
      return "关闭中";
    default:
      return "已关闭";
  }
}

/** 「x 秒前 / 分钟前 / 小时前」。 */
export function describeTime(now: number, epochMs: number): string {
  if (!epochMs) return "—";
  const delta = Math.max(0, now - epochMs);
  if (delta < 60_000) return seconds(delta) + " 秒前";
  if (delta < 3_600_000) return Math.round(delta / 60_000) + " 分钟前";
  return Math.round(delta / 3_600_000) + " 小时前";
}

/** inputSchema 的一行摘要：name: type, opt?: type。search 与 describe 必须给出同一个字符串。 */
export function schemaSummary(schema: unknown): string {
  if (schema === null || typeof schema !== "object") return "";
  const value = schema as Record<string, unknown>;
  const properties = value.properties;
  if (properties === null || typeof properties !== "object") return "";
  const required = Array.isArray(value.required)
    ? (value.required as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  const parts: string[] = [];
  for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
    const prop = (raw ?? {}) as Record<string, unknown>;
    let type = "any";
    if (typeof prop.type === "string") type = prop.type;
    else if (Array.isArray(prop.type)) type = prop.type.map((item) => String(item)).join("|");
    else if (Array.isArray(prop.enum))
      type = "enum(" + (prop.enum as unknown[]).map((item) => String(item)).join("|") + ")";
    parts.push(name + (required.includes(name) ? "" : "?") + ": " + type);
  }
  return parts.join(", ");
}

export function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** search 结果里的一个工具。 */
export function renderToolLine(entry: DocEntry, includeSchemas: boolean): string {
  const lines = ["- " + entry.doc.qualifiedName + "  ［" + entry.doc.server + "］"];
  const description = (entry.doc.description ?? "").split("\n")[0]!.trim();
  if (description) lines.push("    " + description);
  if (includeSchemas) {
    const summary = schemaSummary(entry.tool.inputSchema);
    if (summary) lines.push("    parameters: " + summary);
  }
  if (entry.doc.keywords.length > 0) lines.push("    keywords: " + entry.doc.keywords.join(", "));
  return lines.join("\n");
}

/** 一个工具元数据都还没缓存时，提示先 connect 一次。 */
export function coldHint(core: RuntimeCore): string {
  const enabled = core.enabledServers();
  if (enabled.length === 0) return "";
  if (enabled.every((server) => !core.cache.get(server.serverName))) {
    return '\n提示：目前还没有任何工具元数据被缓存，先 mcp({ connect: "' + enabled[0]!.serverName + '" }) 拉一次。';
  }
  return "";
}

/** 「没有这个服务器，已启用的有……」 */
export function unknownServerText(core: RuntimeCore, name: string): string {
  return (
    '没有名为 "' +
    name +
    '" 的 MCP 服务器。已启用：' +
    (core
      .enabledServers()
      .map((item) => item.serverName)
      .join("，") || "（无）")
  );
}

/** 状态文字里会话的后缀：元数据探测 / 子代理 / 主会话。 */
export function sessionSuffix(core: RuntimeCore, sessionId: string): string {
  const meta = core.sessionMeta.get(sessionId);
  if (sessionId.startsWith("probe:")) return "（元数据探测）";
  if (meta?.parentSessionId !== undefined) return "（子代理，父会话 " + meta.parentSessionId + "）";
  if (meta) return "（主会话）";
  return "";
}
