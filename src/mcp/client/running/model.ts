/**
 * 「运行中」区域的**纯逻辑**：实例状态与行文案、会话过滤 / 排序 / 分组、实例计数。
 * 不碰 DOM、不碰 React、不发请求，node:test 直接测（见 test/mcp/client/running/model.test.ts）。
 * 文案一律走 strings.ts 的 t()；时间格式化与 MCP 页共用 ../model.ts 的 formatClock。
 */

import { t } from "./strings.ts";
import { formatClock } from "../model.ts";
import type { RuntimeInstanceView, RuntimeSessionView } from "../../contract/runtime.ts";

/** 状态点的语义色调（与 kit 的 StatusTone 同形，这里不 import React 侧模块）。 */
export type RuntimeTone = "idle" | "active" | "failed" | "cooling";

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
  return sessions.filter(
    (session) => session.sessionId === currentSessionId || session.parentSessionId === currentSessionId,
  );
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
  const roots = sessions.filter(
    (session) => session.parentSessionId === undefined || !ids.has(session.parentSessionId),
  );
  const childs = sessions.filter(
    (session) => session.parentSessionId !== undefined && ids.has(session.parentSessionId),
  );
  return roots.map((parent) => ({
    parent,
    children: childs.filter((child) => child.parentSessionId === parent.sessionId),
  }));
}
