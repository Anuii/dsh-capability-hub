/**
 * MCP 页的**列表与展示**逻辑：一行服务器怎么显示（摘要、状态点、副标题、缓存）、筛选与计数、排序、时间与时长。
 * 纯函数，不碰 DOM / React / 网络（见 test/mcp/client/view-model.test.ts）。文案走 strings.ts 的 t()。
 */

import { t } from "./strings.ts";
import type { ServerView } from "../contract/config.ts";
import type { RuntimeFailureView, RuntimeServerView, RuntimeStatus } from "../contract/runtime.ts";

/* ---------------- 展示格式化 ---------------- */

/** 列表行里的启动摘要：stdio = command + args，http = url。 */
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
 * 例：D:\\Program Files\\nodejs\\node.exe C:\\x\\server.mjs → node server.mjs；
 *     npx -y @modelcontextprotocol/server-fetch 保持不变。完整命令走悬停提示与详情。
 */
export function compactSummaryText(values: Record<string, unknown>): string {
  if (values.transport === "streamable-http") return serverSummaryText(values);
  const command = typeof values.command === "string" ? values.command : "";
  const args = Array.isArray(values.args) ? values.args.filter((item): item is string => typeof item === "string") : [];
  if (command === "" && args.length === 0) return t("mcp.row.noCommand");
  return [shortPart(command, true), ...args.map((arg) => shortPart(arg))].filter((part) => part !== "").join(" ");
}

export function lifecycleLabel(value: unknown): string {
  switch (value) {
    case "lazy-keep-alive":
      return t("mcp.lifecycle.lazy-keep-alive");
    case "eager":
      return t("mcp.lifecycle.eager");
    case "keep-alive":
      return t("mcp.lifecycle.keep-alive");
    default:
      return t("mcp.lifecycle.lazy");
  }
}

export function transportLabel(value: unknown): string {
  return value === "streamable-http" ? "streamable-http" : "stdio";
}

/** 时间戳（毫秒）→ 本地「YYYY-MM-DD HH:mm」。 */
export function formatTimestamp(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (input: number): string => String(input).padStart(2, "0");
  return (
    String(date.getFullYear()) +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
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

/* ---------------- 列表：筛选、状态点、副标题、缓存摘要 ---------------- */

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

/** 缓存里拿到的运行态（可能是 undefined：还没探测过 / 运行态接口失败）。 */
export type RuntimeRow = RuntimeServerView | undefined;

/** 一行是不是「有错误」（最近失败记录还在）。 */
export function isFailing(row: RuntimeRow): boolean {
  return row?.lastFailure !== undefined;
}

/** 一行是不是「冷却中」（有失败且冷却还没结束）。 */
export function isCooling(row: RuntimeRow, now: number): boolean {
  return cooldownRemainingMs(row?.lastFailure, now) > 0;
}

export function matchesFilter(view: ServerView, row: RuntimeRow, filter: ServerFilterId): boolean {
  switch (filter) {
    case "enabled":
      return !view.disabled;
    case "disabled":
      return view.disabled;
    case "failing":
      return isFailing(row);
    default:
      return true;
  }
}

/** 搜索：服务器名、命令 / 地址、描述与标签（大小写不敏感）。 */
export function matchesQuery(view: ServerView, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") return true;
  const meta = view.meta ?? {};
  const haystack = [view.serverName, viewSummaryText(view), meta.description ?? "", (meta.tags ?? []).join(" ")]
    .join(" ")
    .toLowerCase();
  return haystack.includes(text);
}

/** 运行态快照 → 名字到行的映射（列表与筛选共用）。 */
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

/** 活跃实例数（MCP 页从运行态的会话里数，用来决定状态点是否用强调色）。 */
export function activeInstanceCount(runtime: RuntimeStatus | undefined, name: string): number {
  let count = 0;
  for (const session of runtime?.sessions ?? []) {
    for (const instance of session.instances) {
      if (instance.server === name) count += 1;
    }
  }
  return count;
}

/** 状态点：冷却中（琥珀）> 最近失败（红）> 有活跃实例（强调色）> 空闲（灰）。 */
export function serverStatusTone(
  row: RuntimeRow,
  instances: number,
  now: number,
): "idle" | "active" | "failed" | "cooling" {
  if (isCooling(row, now)) return "cooling";
  if (isFailing(row)) return "failed";
  if (instances > 0) return "active";
  return "idle";
}

/** 状态点的无障碍名（没有合适文案时返回 undefined，不渲染 title）。 */
export function statusTitle(tone: "idle" | "active" | "failed" | "cooling"): string | undefined {
  switch (tone) {
    case "active":
      return t("mcp.row.stateActive");
    case "failed":
      return t("mcp.row.stateFailed");
    case "cooling":
      return t("mcp.row.stateCooling");
    default:
      return undefined;
  }
}

/** 冷却剩余毫秒（没有冷却 = 0）。 */
export function cooldownRemainingMs(failure: RuntimeFailureView | undefined, now: number): number {
  if (failure === undefined || typeof failure.cooldownUntil !== "number") return 0;
  return Math.max(0, failure.cooldownUntil - now);
}

/** 毫秒 → 中文时长（秒 / 分秒）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "0 秒";
  const total = Math.floor(ms / 1000);
  if (total < 60) return String(total) + " 秒";
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return String(minutes) + " 分 " + String(seconds).padStart(2, "0") + " 秒";
  const hours = Math.floor(minutes / 60);
  return String(hours) + " 小时 " + String(minutes % 60).padStart(2, "0") + " 分";
}

/** 时间戳 → 本地「HH:mm」（行里的「更新于 23:50」）。 */
export function formatClock(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
}

/** 行副标题：紧凑的命令 / 地址，有缓存时接「 · 4 个工具」（UI-DESIGN §3）。 */
export function rowSubtitleText(view: ServerView, row: RuntimeRow): string {
  const base = compactSummaryText(view as unknown as Record<string, unknown>);
  if (row?.cache === undefined) return base;
  return base + " " + t("mcp.row.tools", { count: row.cache.toolCount });
}

/** 行副标题的悬停提示：完整命令 / 地址。 */
export function rowSubtitleTitle(view: ServerView): string {
  return viewSummaryText(view);
}

/** 抽屉「工具」小节的一行：缓存数量与更新时间。 */
export function cacheLineText(row: RuntimeRow): string {
  if (row?.cache === undefined) return t("mcp.detail.noCache");
  const parts = [t("mcp.detail.cache", { count: row.cache.toolCount, time: formatTimestamp(row.cache.updatedAt) })];
  if (row.cache.stale) parts.push(t("mcp.detail.cacheStale"));
  return parts.join(" · ");
}

/** 抽屉里列的工具名：模型看到的名字（mcp__<服务器>__<工具>）；老宿主没给时退回原名。 */
export function cachedToolNames(row: RuntimeRow): string[] {
  const tools = row?.cache?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) =>
      typeof tool?.exposedAs === "string" && tool.exposedAs !== ""
        ? tool.exposedAs
        : typeof tool?.name === "string"
          ? tool.name
          : "",
    )
    .filter((name) => name !== "");
}
