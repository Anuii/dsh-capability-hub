/**
 * MCP 页的**列表与展示**逻辑：一行服务器怎么显示（摘要、副标题）、筛选与计数、排序。
 * 纯函数，不碰 DOM / React / 网络（见 test/mcp/client/view-model.test.ts）。文案走 strings.ts 的 t()。
 *
 * 0.9.0 起页面上没有运行状态：行上没有状态点、状态文字与「N 个工具」，筛选里也没有「有错误」。
 * 服务器是否连上只看宿主 GET health 的 mcpServers（要重试就重启 DSH）。
 */

import { t } from "./strings.ts";
import type { ServerView } from "../contract/config.ts";

/* ---------------- 展示格式化 ---------------- */

/** 启动摘要：stdio = command + args，http = url。 */
export function serverSummaryText(values: Record<string, unknown>): string {
  const transport = values.transport === "streamable-http" ? "streamable-http" : "stdio";
  if (transport === "streamable-http") {
    const url = typeof values.url === "string" ? values.url : "";
    return url === "" ? t("mcp.row.noUrl") : url;
  }
  const command = typeof values.command === "string" ? values.command : "";
  const args = Array.isArray(values.args) ? values.args.filter((item): item is string => typeof item === "string") : [];
  if (command === "" && args.length === 0) return t("mcp.row.noCommand");
  return [command, ...args].filter((part) => part !== "").join(" ");
}

/** 视图里的服务器摘要（完整版：抽屉副标题、悬停提示用）。 */
export function viewSummaryText(view: ServerView): string {
  return serverSummaryText(view as unknown as Record<string, unknown>);
}

/** 像本机路径的参数（含反斜杠，或以盘符 / 斜杠 / ./ / ../ / ~ 开头）；@scope/pkg 这类包名不算。 */
export function isPathLike(part: string): boolean {
  return part.includes("\\") || /^([A-Za-z]:|\/|\.{1,2}\/|~)/.test(part);
}

/** 路径只留文件名；可执行文件再去掉 .exe / .cmd / .bat。 */
export function shortPart(part: string, executable = false): string {
  let out = part;
  if (isPathLike(part)) {
    const base =
      part
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() ?? "";
    if (base !== "") out = base;
  }
  return executable ? out.replace(/\.(exe|cmd|bat)$/i, "") : out;
}

/**
 * 列表行里的紧凑摘要：stdio = 程序名 + 参数（路径只留文件名），http = 地址原样。
 * 例：D:\\Program Files\\nodejs\\node.exe C:\\x\\server.mjs → node server.mjs。完整命令走悬停提示与详情。
 */
export function compactSummaryText(values: Record<string, unknown>): string {
  if (values.transport === "streamable-http") return serverSummaryText(values);
  const command = typeof values.command === "string" ? values.command : "";
  const args = Array.isArray(values.args) ? values.args.filter((item): item is string => typeof item === "string") : [];
  if (command === "" && args.length === 0) return t("mcp.row.noCommand");
  return [shortPart(command, true), ...args.map((arg) => shortPart(arg))].filter((part) => part !== "").join(" ");
}

export function transportLabel(value: unknown): string {
  return value === "streamable-http" ? "streamable-http" : "stdio";
}

export function scopeLabel(value: unknown): string {
  return value === "session" ? t("mcp.scope.session") : t("mcp.scope.global");
}

/* ---------------- 排序 ---------------- */

/** 拖动排序：把 from 位置的项挪到 to 位置。 */
export function reorderNames(names: readonly string[], from: number, to: number): string[] {
  const next = [...names];
  if (from < 0 || from >= next.length) return next;
  const clamped = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  next.splice(clamped, 0, item);
  return next;
}

/* ---------------- 列表：筛选、副标题 ---------------- */

/**
 * 列表筛选的三个分段（UI-DESIGN §5）。
 * 0.9.0 起没有「有错误」：它靠运行状态判断，而运行状态已经不在界面上。
 */
export type ServerFilterId = "all" | "enabled" | "disabled";

export const SERVER_FILTERS: readonly ServerFilterId[] = ["all", "enabled", "disabled"];

export function filterLabel(id: ServerFilterId): string {
  switch (id) {
    case "enabled":
      return t("mcp.filter.enabled");
    case "disabled":
      return t("mcp.filter.disabled");
    default:
      return t("mcp.filter.all");
  }
}

/** 一台服务器是否属于某个分段（只看配置里的 disabled，与连接状态无关）。 */
export function matchesFilter(view: ServerView, filter: ServerFilterId): boolean {
  switch (filter) {
    case "enabled":
      return !view.disabled;
    case "disabled":
      return view.disabled;
    default:
      return true;
  }
}

/** 搜索：服务器名、命令 / 地址、描述（大小写不敏感）。 */
export function matchesQuery(view: ServerView, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") return true;
  const haystack = [view.serverName, viewSummaryText(view), view.meta?.description ?? ""].join(" ").toLowerCase();
  return haystack.includes(text);
}

/** 分段上的计数（工具栏用）。 */
export function serverFilterCounts(servers: readonly ServerView[]): Record<ServerFilterId, number> {
  const counts: Record<ServerFilterId, number> = { all: 0, enabled: 0, disabled: 0 };
  for (const view of servers) {
    counts.all += 1;
    for (const id of SERVER_FILTERS) {
      if (id === "all") continue;
      if (matchesFilter(view, id)) counts[id] += 1;
    }
  }
  return counts;
}

/** 搜索 + 筛选之后的服务器（保持配置顺序）。 */
export function visibleServers(servers: readonly ServerView[], query: string, filter: ServerFilterId): ServerView[] {
  return servers.filter((view) => matchesQuery(view, query) && matchesFilter(view, filter));
}

/** 行副标题：紧凑的命令 / 地址（0.9.0 起不再追加「N 个工具」「按会话」这类运行信息）。 */
export function rowSubtitleText(view: ServerView): string {
  return compactSummaryText(view as unknown as Record<string, unknown>);
}

/** 行副标题的悬停提示：完整命令 / 地址。 */
export function rowSubtitleTitle(view: ServerView): string {
  return viewSummaryText(view);
}
