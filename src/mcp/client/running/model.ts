/**
 * 运行态标签的**纯逻辑**（UI-B 版）：时间与时长格式化、冷却倒计时、行文案、会话分组、
 * 实例计数。不碰 DOM、不碰 React、不发请求，node:test 直接测（见 test/mcp/client/running/model.test.ts）。
 *
 * 文案一律走 strings.ts 的 t()，所以测试断言的是界面上真正会出现的字。
 * 时间来源（cooldownUntil / updatedAt / startedAt / lastUsedAt）都是 epoch 毫秒，与浏览器同机同钟，
 * 所以倒计时直接用 `cooldownUntil - now`，但一律夹到 >= 0，避免时钟回拨出现负值。
 */

import { t } from "./strings.ts";
import type { RuntimeFailureView, RuntimeInstanceView, RuntimeServerView, RuntimeSessionView } from "./types.ts";

/** 自动刷新间隔（任务书：可见时每 5 秒一次）。 */
export const POLL_INTERVAL_MS = 5000;

/** 状态点的语义色调（与 kit 的 StatusTone 同形，这里不 import React 侧模块）。 */
export type RuntimeTone = "idle" | "active" | "failed" | "cooling";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** epoch 毫秒 → 本地「YYYY-MM-DD HH:mm:ss」；非法值返回空串。 */
export function formatTime(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return (
    String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
    " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds())
  );
}

/** epoch 毫秒 → 本地「HH:mm」（行里的「更新于 23:50」）。 */
export function formatClock(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return pad(date.getHours()) + ":" + pad(date.getMinutes());
}

/** 毫秒 → 中文时长（秒 / 分秒 / 小时分）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "0 秒";
  const total = Math.floor(ms / 1000);
  if (total < 60) return String(total) + " 秒";
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return String(minutes) + " 分 " + pad(seconds) + " 秒";
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return String(hours) + " 小时 " + pad(minutes) + " 分";
}

/** 冷却剩余毫秒（没有冷却 = 0）。cooldownUntil 缺失即「冷却已结束」。 */
export function cooldownRemainingMs(failure: RuntimeFailureView | undefined, now: number): number {
  if (failure === undefined || typeof failure.cooldownUntil !== "number") return 0;
  return Math.max(0, failure.cooldownUntil - now);
}

export function isCoolingDown(failure: RuntimeFailureView | undefined, now: number): boolean {
  return cooldownRemainingMs(failure, now) > 0;
}

/** 行上的冷却标记文案（「冷却 47s」）；没有冷却时 undefined。 */
export function cooldownBadgeText(failure: RuntimeFailureView | undefined, now: number): string | undefined {
  const remaining = cooldownRemainingMs(failure, now);
  if (remaining <= 0) return undefined;
  return t("runtime.row.cooldownBadge", { seconds: String(Math.ceil(remaining / 1000)) });
}

/** 抽屉里的冷却倒计时文案（「冷却中，剩余 1 分 30 秒」）；没有冷却时 undefined。 */
export function cooldownText(failure: RuntimeFailureView | undefined, now: number): string | undefined {
  const remaining = cooldownRemainingMs(failure, now);
  if (remaining <= 0) return undefined;
  return t("runtime.row.cooldown", { remaining: formatDuration(remaining) });
}

/** 实例状态 → 状态点色调（连接池的取值见 atoms/connection.ts）。 */
export function instanceTone(state: string): RuntimeTone {
  switch (state) {
    case "ready":
    case "connecting":
      return "active";
    case "failed":
      return "failed";
    default:
      return "idle";
  }
}

export function instanceStateText(state: string): string {
  switch (state) {
    case "ready":
      return t("runtime.state.ready");
    case "connecting":
      return t("runtime.state.connecting");
    case "failed":
      return t("runtime.state.failed");
    case "closing":
      return t("runtime.state.closing");
    case "closed":
      return t("runtime.state.closed");
    default:
      return t("runtime.state.unknown", { state });
  }
}

/** 每个服务器名 → 活跃实例数（服务器行显示用，数据来自会话区，两处不会互相矛盾）。 */
export function serverInstanceCounts(sessions: readonly RuntimeSessionView[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const session of sessions) {
    for (const instance of session.instances) {
      counts[instance.server] = (counts[instance.server] ?? 0) + 1;
    }
  }
  return counts;
}

export function totalInstances(sessions: readonly RuntimeSessionView[]): number {
  return sessions.reduce((sum, session) => sum + session.instances.length, 0);
}

/**
 * 「只看当前会话」= 当前会话本身 + 它的直接子会话（D-D3：子代理会话各自一套实例）。
 * currentSessionId 取不到时不做任何过滤（调用方应同时把开关置灰）。
 */
export function filterSessions(
  sessions: readonly RuntimeSessionView[],
  onlyCurrent: boolean,
  currentSessionId: string | undefined,
): RuntimeSessionView[] {
  if (!onlyCurrent || currentSessionId === undefined || currentSessionId === "") return [...sessions];
  return sessions.filter((session) => session.sessionId === currentSessionId || session.parentSessionId === currentSessionId);
}

/** 父会话排在子会话前面（其余保持服务端给的顺序，稳定排序）。 */
export function sortSessions(sessions: readonly RuntimeSessionView[]): RuntimeSessionView[] {
  const ids = new Set(sessions.map((session) => session.sessionId));
  const roots: RuntimeSessionView[] = [];
  const children: RuntimeSessionView[] = [];
  for (const session of sessions) {
    const hasKnownParent = session.parentSessionId !== undefined && ids.has(session.parentSessionId);
    (hasKnownParent ? children : roots).push(session);
  }
  return [...roots, ...children];
}

/** 会话 id 太长时省略中间（界面上只用于展示，不参与任何匹配）。 */
export function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 16) return sessionId;
  return sessionId.slice(0, 8) + "…" + sessionId.slice(-4);
}

/** 服务器行副标题：缓存与实例数；有失败时整行换成失败信息（红色单行）。 */
export function serverSubtitleText(server: RuntimeServerView, instances: number): string {
  if (server.lastFailure !== undefined) return server.lastFailure.message;
  const parts = [cacheSummaryText(server)];
  parts.push(instances === 0 ? t("runtime.row.instancesNone") : t("runtime.row.instances", { count: instances }));
  return parts.join(" · ");
}

/**
 * 副标题的语义色：**有失败就是红**（UI-DESIGN §6「有失败时副标题为红色的单行失败信息」）；
 * 「还在冷却」这件事由琥珀色的状态点与「冷却 47s」标记表达，不再重复染色。
 */
export function serverSubtitleTone(server: RuntimeServerView): "default" | "danger" {
  return server.lastFailure === undefined ? "default" : "danger";
}

/** 服务器行的状态点：冷却（琥珀）> 失败（红）> 有实例（强调）> 空闲（灰）。 */
export function serverRowTone(server: RuntimeServerView, instances: number, now: number): RuntimeTone {
  if (isCoolingDown(server.lastFailure, now)) return "cooling";
  if (server.lastFailure !== undefined) return "failed";
  if (instances > 0) return "active";
  return "idle";
}

/** 「缓存 4 个工具 · 更新于 23:50」；没有缓存时说明原因。 */
export function cacheSummaryText(server: RuntimeServerView): string {
  const cache = server.cache;
  if (cache === undefined) return t("runtime.row.noCache");
  const parts = [t("runtime.row.cache", { count: cache.toolCount, time: formatClock(cache.updatedAt) })];
  if (cache.stale) parts.push(t("runtime.row.stale"));
  return parts.join(" · ");
}

/** 抽屉里的完整缓存信息（带日期）。 */
export function cacheDetailText(server: RuntimeServerView): string {
  const cache = server.cache;
  if (cache === undefined) return t("runtime.row.noCache");
  const parts = [t("runtime.drawer.cache", { count: cache.toolCount, time: formatTime(cache.updatedAt) })];
  if (cache.stale) parts.push(t("runtime.row.stale"));
  return parts.join(" · ");
}

/** 失败信息（服务端中文原文 + 本地时间）。 */
export function failureText(failure: RuntimeFailureView): string {
  return t("runtime.drawer.failure", { message: failure.message, time: formatTime(failure.at) });
}

/** 实例行副标题：「就绪 · PID 35984 · 启动 23:51 · 最近使用 23:51」。 */
export function instanceSubtitleText(instance: RuntimeInstanceView): string {
  const parts = [instanceStateText(instance.state)];
  if (instance.pid !== undefined) parts.push(t("runtime.instance.pid", { pid: instance.pid }));
  parts.push(t("runtime.instance.started", { time: formatClock(instance.startedAt) }));
  parts.push(t("runtime.instance.lastUsed", { time: formatClock(instance.lastUsedAt) }));
  return parts.join(" · ");
}

/** 会话小标题：有标题用标题，否则用短 id。 */
export function sessionTitleText(session: RuntimeSessionView): string {
  const title = session.title;
  return title === undefined || title === "" ? shortSessionId(session.sessionId) : title;
}

/** 会话小标题右侧的等宽完整 id（列表分组自带 title 提示）。 */
export function sessionIdText(session: RuntimeSessionView): string {
  return session.sessionId;
}

/** 一个会话分组：父会话 + 缩进显示的子代理会话。 */
export interface SessionGroupView {
  parent: RuntimeSessionView;
  children: RuntimeSessionView[];
}

/** 把（已经过滤过的）会话按父子关系收成若干组，父会话按原顺序。 */
export function sessionGroups(sessions: readonly RuntimeSessionView[]): SessionGroupView[] {
  const ids = new Set(sessions.map((session) => session.sessionId));
  const roots = sessions.filter((session) => session.parentSessionId === undefined || !ids.has(session.parentSessionId));
  const childs = sessions.filter((session) => session.parentSessionId !== undefined && ids.has(session.parentSessionId));
  return roots.map((parent) => ({
    parent,
    children: childs.filter((child) => child.parentSessionId === parent.sessionId),
  }));
}

/** 统一取错误文案（ApiError 的 message 就是服务端给的中文）。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
