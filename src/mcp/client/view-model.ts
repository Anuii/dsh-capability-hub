/**
 * MCP 页的**列表与展示**逻辑：一行服务器怎么显示（摘要、状态点、副标题、状态文字）、筛选与计数、排序。
 * 纯函数，不碰 DOM / React / 网络（见 test/mcp/client/view-model.test.ts）。文案走 strings.ts 的 t()。
 *
 * 0.7.0 起服务器由 DSH 官方 MCP 插件连接（ADR-0010），运行状态只有「挂没挂上、注册了哪些工具」。
 */

import { t } from "./strings.ts";
import type { ServerView } from "../contract/config.ts";
import type { RuntimeServerView, RuntimeStatus } from "../contract/runtime.ts";

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

/* ---------------- 列表：筛选、状态点、副标题 ---------------- */

/** 列表筛选的四个分段（UI-DESIGN §5）。 */
export type ServerFilterId = "all" | "enabled" | "disabled" | "failing";

export const SERVER_FILTERS: readonly ServerFilterId[] = ["all", "enabled", "disabled", "failing"];

export function filterLabel(id: ServerFilterId): string {
  switch (id) {
    case "enabled":
      return t("mcp.filter.enabled");
    case "disabled":
      return t("mcp.filter.disabled");
    case "failing":
      return t("mcp.filter.failing");
    default:
      return t("mcp.filter.all");
  }
}

/** 运行状态里的一行（可能是 undefined：运行状态还没读到 / 接口失败）。 */
export type RuntimeRow = RuntimeServerView | undefined;

/** 一行是不是「有错误」：连接失败，或挂着但没有工具（断线）。 */
export function isFailing(row: RuntimeRow): boolean {
  return row?.state === "failed" || row?.state === "disconnected";
}

export function matchesFilter(view: ServerView, row: RuntimeRow, filter: ServerFilterId): boolean {
  switch (filter) {
    case "enabled":
      return !view.disabled;
    case "disabled":
      return view.disabled;
    case "failing":
      return !view.disabled && isFailing(row);
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

/** 运行状态 → 名字到行的映射（列表与筛选共用）。 */
export function runtimeIndex(runtime: RuntimeStatus | undefined): Map<string, RuntimeServerView> {
  const map = new Map<string, RuntimeServerView>();
  for (const row of runtime?.servers ?? []) map.set(row.name, row);
  return map;
}

/** 分段上的计数（工具栏用）。 */
export function serverFilterCounts(
  servers: readonly ServerView[],
  rows: ReadonlyMap<string, RuntimeServerView>,
): Record<ServerFilterId, number> {
  const counts: Record<ServerFilterId, number> = { all: 0, enabled: 0, disabled: 0, failing: 0 };
  for (const view of servers) {
    counts.all += 1;
    for (const id of SERVER_FILTERS) {
      if (id === "all") continue;
      if (matchesFilter(view, rows.get(view.serverName), id)) counts[id] += 1;
    }
  }
  return counts;
}

/** 搜索 + 筛选之后的服务器（保持配置顺序）。 */
export function visibleServers(
  servers: readonly ServerView[],
  rows: ReadonlyMap<string, RuntimeServerView>,
  query: string,
  filter: ServerFilterId,
): ServerView[] {
  return servers.filter((view) => matchesQuery(view, query) && matchesFilter(view, rows.get(view.serverName), filter));
}

/** 状态点（kit 的四种色调）：连接中 = 琥珀，有错误 = 红，已连接 / 有会话挂着 = 强调色，其余 = 灰。 */
export function serverStatusTone(view: ServerView, row: RuntimeRow): "idle" | "active" | "failed" | "cooling" {
  if (view.disabled || row === undefined) return "idle";
  switch (row.state) {
    case "connecting":
      return "cooling";
    case "failed":
    case "disconnected":
      return "failed";
    case "connected":
      return "active";
    case "session":
      return row.sessions > 0 ? "active" : "idle";
    default:
      return "idle";
  }
}

/** 状态点的悬停文字（灰色不需要说明时 undefined）。 */
export function statusTitle(tone: "idle" | "active" | "failed" | "cooling"): string | undefined {
  switch (tone) {
    case "active":
      return t("mcp.row.stateActive");
    case "failed":
      return t("mcp.row.stateFailed");
    case "cooling":
      return t("mcp.row.stateConnecting");
    default:
      return undefined;
  }
}

/** 行副标题：紧凑的命令 / 地址，后面接一小段状态（「4 个工具」「按会话」）。 */
export function rowSubtitleText(view: ServerView, row: RuntimeRow): string {
  const base = compactSummaryText(view as unknown as Record<string, unknown>);
  if (view.disabled || row === undefined) return base;
  if (row.state === "session") return base + " " + t("mcp.row.session");
  if (row.state === "connected") return base + " " + t("mcp.row.tools", { count: row.tools.length });
  return base;
}

/** 行副标题的悬停提示：完整命令 / 地址。 */
export function rowSubtitleTitle(view: ServerView): string {
  return viewSummaryText(view);
}

/** 抽屉「工具」小节的状态文字。 */
export function stateText(view: ServerView, row: RuntimeRow): string {
  if (view.disabled) return t("mcp.state.disabled");
  if (row === undefined) return t("mcp.state.unknown");
  switch (row.state) {
    case "connecting":
      return t("mcp.state.connecting");
    case "connected":
      return t("mcp.state.connected", { count: row.tools.length });
    case "disconnected":
      return t("mcp.state.disconnected");
    case "failed":
      return t("mcp.state.failed", { message: row.error ?? t("mcp.state.noReason") });
    case "session":
      return t("mcp.state.session", { count: row.sessions });
    default:
      return t("mcp.state.unknown");
  }
}
