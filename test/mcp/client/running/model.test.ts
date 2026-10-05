/**
 * 运行态纯逻辑单测（不碰 DOM / React / 网络）。
 *
 * 覆盖：实例状态映射与行副标题、会话过滤（当前会话 + 子会话）、排序与父子分组、实例计数。
 * 时间、时长、冷却的格式化与 MCP 页共用，测在 ../model.test.ts。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { formatClock } from "../../../../src/mcp/client/model.ts";
import {
  filterSessions,
  instanceStateText,
  instanceSubtitleText,
  instanceTone,
  sessionGroups,
  sessionIdText,
  sessionTitleText,
  shortSessionId,
  sortSessions,
  totalInstances,
} from "../../../../src/mcp/client/running/model.ts";
import { T0, makeNestedStatus, makeSession } from "./fixtures.ts";

test("instanceTone / instanceStateText：连接池的五个状态都有中文与色调", () => {
  assert.equal(instanceTone("ready"), "active");
  assert.equal(instanceTone("connecting"), "active");
  assert.equal(instanceTone("failed"), "failed");
  assert.equal(instanceTone("closing"), "idle");
  assert.equal(instanceTone("closed"), "idle");
  assert.equal(instanceTone("whatever"), "idle");
  assert.deepEqual(["ready", "connecting", "failed", "closing", "closed"].map(instanceStateText), [
    "就绪",
    "连接中",
    "失败",
    "关闭中",
    "已关闭",
  ]);
  assert.equal(instanceStateText("mystery"), "未知（mystery）");
});

test("instanceSubtitleText：状态 · PID · 启动 · 最近使用（没有 pid 时省略）", () => {
  const withPid = instanceSubtitleText({
    server: "fake",
    state: "ready",
    startedAt: T0,
    lastUsedAt: T0 + 60_000,
    pid: 35984,
  });
  assert.equal(withPid, "就绪 · PID 35984 · 启动 " + formatClock(T0) + " · 最近使用 " + formatClock(T0 + 60_000));
  const without = instanceSubtitleText({ server: "fake", state: "connecting", startedAt: T0, lastUsedAt: T0 });
  assert.equal(without.includes("PID"), false);
  assert.equal(without.startsWith("连接中 · 启动"), true);
});

test("totalInstances：会话里的实例总数", () => {
  assert.equal(totalInstances(makeNestedStatus().sessions), 2);
  assert.equal(totalInstances([]), 0);
});

test("filterSessions：关掉开关时原样返回；打开时只留当前会话与它的直接子会话", () => {
  const sessions = makeNestedStatus().sessions;
  assert.equal(filterSessions(sessions, false, "parent-session-0001").length, 3);
  assert.deepEqual(
    filterSessions(sessions, true, "parent-session-0001").map((session) => session.sessionId),
    ["parent-session-0001", "child-session-0002"],
  );
  // 子会话视角：看不到父会话，也看不到兄弟
  assert.deepEqual(
    filterSessions(sessions, true, "child-session-0002").map((session) => session.sessionId),
    ["child-session-0002"],
  );
  // 没有会话 id 时不过滤（调用方会把开关置灰）
  assert.equal(filterSessions(sessions, true, undefined).length, 3);
  assert.equal(filterSessions(sessions, true, "").length, 3);
  assert.equal(filterSessions(sessions, true, "nope").length, 0);
});

test("sortSessions：父会话排在子会话前面，且不打乱其余顺序", () => {
  const sessions = makeNestedStatus().sessions;
  assert.deepEqual(
    sortSessions(sessions).map((session) => session.sessionId),
    ["parent-session-0001", "other-session-0003", "child-session-0002"],
  );
  // 父会话不在快照里时，子会话按原顺序留着（不会被丢掉）
  const orphan = [makeSession({ sessionId: "child", parentSessionId: "gone" })];
  assert.deepEqual(
    sortSessions(orphan).map((session) => session.sessionId),
    ["child"],
  );
});

test("shortSessionId：短 id 原样，长 id 省略中间", () => {
  assert.equal(shortSessionId("abc"), "abc");
  assert.equal(shortSessionId("0123456789abcdef"), "0123456789abcdef");
  assert.equal(shortSessionId("0123456789abcdefg"), "01234567…defg");
});

test("sessionGroups：父会话带上缩进显示的子代理会话", () => {
  const groups = sessionGroups(sortSessions(makeNestedStatus().sessions));
  assert.deepEqual(
    groups.map((group) => group.parent.sessionId),
    ["parent-session-0001", "other-session-0003"],
  );
  assert.deepEqual(
    groups[0].children.map((child) => child.sessionId),
    ["child-session-0002"],
  );
  assert.deepEqual(groups[1].children, []);
  // 父会话不在快照里时，子会话自己成为根（不会被丢掉）
  const orphan = sessionGroups([makeSession({ sessionId: "child", parentSessionId: "gone" })]);
  assert.deepEqual(
    orphan.map((group) => group.parent.sessionId),
    ["child"],
  );
});

test("sessionTitleText / sessionIdText：有标题用标题，否则短 id；id 一律给完整值", () => {
  const parent = makeSession({ sessionId: "parent-session-0001", title: "主会话" });
  assert.equal(sessionTitleText(parent), "主会话");
  assert.equal(sessionIdText(parent), "parent-session-0001");
  const untitled = makeSession({ sessionId: "0123456789abcdefg" });
  assert.equal(sessionTitleText(untitled), "01234567…defg");
  assert.equal(sessionIdText(untitled), "0123456789abcdefg");
  assert.equal(sessionTitleText(makeSession({ sessionId: "short", title: "" })), "short");
});
