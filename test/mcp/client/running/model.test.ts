/**
 * 运行态纯逻辑单测（不碰 DOM / React / 网络）。
 *
 * 覆盖：时间与时长格式化、冷却倒计时（含字段缺失 = 冷却已结束）、行副标题与状态点、
 * 缓存文案、实例状态映射、会话过滤（当前会话 + 子会话）、父子分组、实例计数。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  POLL_INTERVAL_MS,
  cacheDetailText,
  cacheSummaryText,
  cooldownBadgeText,
  cooldownRemainingMs,
  cooldownText,
  failureText,
  filterSessions,
  formatClock,
  formatDuration,
  formatTime,
  instanceStateText,
  instanceSubtitleText,
  instanceTone,
  isCoolingDown,
  serverInstanceCounts,
  serverRowTone,
  serverSubtitleText,
  serverSubtitleTone,
  sessionGroups,
  sessionIdText,
  sessionTitleText,
  shortSessionId,
  sortSessions,
  totalInstances,
} from "../../../../src/mcp/client/running/model.ts";
import { T0, makeNestedStatus, makeServer, makeSession } from "./fixtures.ts";

test("轮询间隔按任务书是 5 秒", () => {
  assert.equal(POLL_INTERVAL_MS, 5000);
});

test("formatTime / formatClock：epoch 毫秒 → 本地时间；非法值给空串", () => {
  assert.match(formatTime(T0), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(formatClock(T0), /^\d{2}:\d{2}$/);
  assert.equal(formatTime(undefined), "");
  assert.equal(formatTime(0), "");
  assert.equal(formatTime(Number.NaN), "");
  assert.equal(formatTime("2025"), "");
  assert.equal(formatClock(undefined), "");
  assert.equal(formatClock(0), "");
});

test("formatDuration：秒 / 分秒 / 小时分", () => {
  assert.equal(formatDuration(0), "0 秒");
  assert.equal(formatDuration(999), "0 秒");
  assert.equal(formatDuration(1000), "1 秒");
  assert.equal(formatDuration(45_000), "45 秒");
  assert.equal(formatDuration(65_000), "1 分 05 秒");
  assert.equal(formatDuration(3_600_000), "1 小时 00 分");
  assert.equal(formatDuration(3_900_000), "1 小时 05 分");
});

test("cooldownRemainingMs：没有失败 = 0；cooldownUntil 缺失 = 冷却已结束", () => {
  assert.equal(cooldownRemainingMs(undefined, T0), 0);
  assert.equal(cooldownRemainingMs({ message: "x", at: T0 }, T0), 0);
  assert.equal(cooldownRemainingMs({ message: "x", at: T0, cooldownUntil: T0 + 30_000 }, T0), 30_000);
  // 时钟回拨 / 已经过期：一律夹到 0，不出现负数
  assert.equal(cooldownRemainingMs({ message: "x", at: T0, cooldownUntil: T0 + 1000 }, T0 + 60_000), 0);
});

test("isCoolingDown / cooldownBadgeText / cooldownText：倒计时随 now 递减", () => {
  const failure = { message: "启动失败", at: T0, cooldownUntil: T0 + 90_000 };
  assert.equal(isCoolingDown(failure, T0), true);
  assert.equal(cooldownBadgeText(failure, T0), "冷却 90s");
  assert.equal(cooldownBadgeText(failure, T0 + 53_000), "冷却 37s");
  assert.equal(cooldownBadgeText(failure, T0 + 90_000), undefined);
  assert.equal(cooldownBadgeText(undefined, T0), undefined);
  assert.equal(cooldownText(failure, T0), "冷却中，剩余 1 分 30 秒");
  assert.equal(cooldownText(failure, T0 + 89_000), "冷却中，剩余 1 秒");
  assert.equal(cooldownText(failure, T0 + 90_000), undefined);
  assert.equal(cooldownText({ message: "x", at: T0 }, T0), undefined);
  assert.equal(isCoolingDown(failure, T0 + 200_000), false);
});

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

test("cacheSummaryText / cacheDetailText：工具数 + 时间；过期时追加提示；没有缓存时说明原因", () => {
  const fresh = makeServer({ cache: { toolCount: 4, updatedAt: T0, stale: false, tools: [] } });
  assert.equal(cacheSummaryText(fresh).includes("缓存 4 个工具"), true);
  assert.equal(cacheSummaryText(fresh).includes(formatClock(T0)), true);
  assert.equal(cacheSummaryText(fresh).includes("已过期"), false);
  const stale = makeServer({ cache: { toolCount: 0, updatedAt: T0, stale: true, tools: [] } });
  assert.equal(cacheSummaryText(stale).includes("缓存已过期"), true);
  assert.equal(cacheSummaryText(makeServer()), "还没有工具缓存");
  assert.equal(cacheDetailText(fresh).includes(formatTime(T0)), true);
  assert.equal(cacheDetailText(makeServer()), "还没有工具缓存");
});

test("serverSubtitleText / serverSubtitleTone：正常时是缓存与实例数，失败时是红色单行失败信息", () => {
  const ok = makeServer({ cache: { toolCount: 4, updatedAt: T0, stale: false, tools: [] } });
  assert.equal(serverSubtitleText(ok, 2), "缓存 4 个工具 · 更新于 " + formatClock(T0) + " · 2 个活跃实例");
  assert.equal(serverSubtitleText(ok, 0).includes("没有活跃实例"), true);
  assert.equal(serverSubtitleTone(ok), "default");
  const failed = makeServer({ lastFailure: { message: "启动失败：没有找到命令", at: T0 } });
  assert.equal(serverSubtitleText(failed, 0), "启动失败：没有找到命令");
  assert.equal(serverSubtitleTone(failed), "danger");
  // 冷却中也是红色副标题（琥珀由状态点与冷却标记表达）
  const cooling = makeServer({ lastFailure: { message: "启动失败", at: T0, cooldownUntil: T0 + 60_000 } });
  assert.equal(serverSubtitleTone(cooling), "danger");
});

test("serverRowTone：冷却 > 失败 > 有实例 > 空闲", () => {
  const cooling = makeServer({ lastFailure: { message: "x", at: T0, cooldownUntil: T0 + 10_000 } });
  assert.equal(serverRowTone(cooling, 3, T0), "cooling");
  assert.equal(serverRowTone(cooling, 3, T0 + 10_000), "failed");
  assert.equal(serverRowTone(makeServer({ lastFailure: { message: "x", at: T0 } }), 0, T0), "failed");
  assert.equal(serverRowTone(makeServer(), 1, T0), "active");
  assert.equal(serverRowTone(makeServer(), 0, T0), "idle");
});

test("failureText：message 原样（服务端中文）+ 本地时间", () => {
  const text = failureText({ message: "没有找到启动命令「nope」", at: T0 });
  assert.equal(text.includes("没有找到启动命令「nope」"), true);
  assert.equal(text.includes(formatTime(T0)), true);
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

test("serverInstanceCounts / totalInstances：按服务器聚合会话里的实例", () => {
  const status = makeNestedStatus();
  assert.deepEqual(serverInstanceCounts(status.sessions), { fake: 2 });
  assert.equal(totalInstances(status.sessions), 2);
  assert.deepEqual(serverInstanceCounts([]), {});
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
