/**
 * 「运行中」区域折叠判定的单测（D-E1 / UI-DESIGN §4）。
 *
 * 规则：没有活跃实例自动收起；用户手动折叠 / 展开后按用户的选择；
 * 只有 0 ↔ 非 0 的跃迁才让自动规则重新接管。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RUNNING_REGION_INITIAL,
  runningInstanceCount,
  runningPreviewStatus,
  runningRegionExpanded,
  runningRegionNext,
  runningRegionToggle,
} from "../../../../src/mcp/client/running/region.ts";
import { T0, makeServer, makeSession, makeStatus } from "./fixtures.ts";

test("没有活跃实例时自动收起，有活跃实例时默认展开", () => {
  assert.equal(runningRegionExpanded(RUNNING_REGION_INITIAL), false);
  const empty = runningRegionNext(RUNNING_REGION_INITIAL, 0);
  assert.equal(runningRegionExpanded(empty), false);
  const three = runningRegionNext(empty, 3);
  assert.equal(runningRegionExpanded(three), true);
});

test("用户手动折叠后，实例数在非 0 区间变化时仍保持折叠", () => {
  let state = runningRegionNext(RUNNING_REGION_INITIAL, 3);
  assert.equal(runningRegionExpanded(state), true);
  state = runningRegionToggle(state);
  assert.equal(runningRegionExpanded(state), false);
  state = runningRegionNext(state, 4);
  assert.equal(runningRegionExpanded(state), false);
  state = runningRegionNext(state, 1);
  assert.equal(runningRegionExpanded(state), false);
});

test("用户手动展开后，实例数在非 0 区间变化时仍保持展开", () => {
  let state = runningRegionNext(RUNNING_REGION_INITIAL, 0);
  state = runningRegionToggle(state);
  assert.equal(runningRegionExpanded(state), true);
  state = runningRegionNext(state, 2);
  assert.equal(runningRegionExpanded(state), true);
  state = runningRegionNext(state, 5);
  assert.equal(runningRegionExpanded(state), true);
});

test("0 ↔ 非 0 的跃迁让自动规则重新接管（手动选择被丢掉）", () => {
  // 有实例时手动收起 → 实例清零：手动选择作废，自动规则说「收起」
  let state = runningRegionToggle(runningRegionNext(RUNNING_REGION_INITIAL, 2));
  assert.equal(runningRegionExpanded(state), false);
  state = runningRegionNext(state, 0);
  assert.equal(state.manual, undefined);
  assert.equal(runningRegionExpanded(state), false);
  // 再回到非 0 → 自动展开
  state = runningRegionNext(state, 1);
  assert.equal(runningRegionExpanded(state), true);

  // 没有实例时手动展开 → 出现实例：手动选择作废，自动规则说「展开」
  let other = runningRegionToggle(runningRegionNext(RUNNING_REGION_INITIAL, 0));
  assert.equal(runningRegionExpanded(other), true);
  other = runningRegionNext(other, 3);
  assert.equal(other.manual, undefined);
  assert.equal(runningRegionExpanded(other), true);

  // 有实例时手动收起 → 清零 → 出现实例 → 自动展开
  let third = runningRegionNext(RUNNING_REGION_INITIAL, 1);
  third = runningRegionToggle(third);
  assert.equal(runningRegionExpanded(third), false);
  third = runningRegionNext(third, 0);
  third = runningRegionNext(third, 2);
  assert.equal(runningRegionExpanded(third), true);
});

test("实例数没变时状态对象原样返回（不触发无谓重渲染）", () => {
  const state = runningRegionNext(RUNNING_REGION_INITIAL, 2);
  assert.equal(runningRegionNext(state, 2), state);
  const manual = runningRegionToggle(state);
  assert.equal(runningRegionNext(manual, 2), manual);
});

test("runningInstanceCount 数所有会话的实例，数据没到时算 0", () => {
  assert.equal(runningInstanceCount(undefined), 0);
  assert.equal(runningInstanceCount(makeStatus([], [])), 0);
  const status = makeStatus(
    [makeServer({ name: "fetch" }), makeServer({ name: "time" })],
    [
      makeSession({
        sessionId: "parent-0001",
        instances: [
          { server: "fetch", state: "ready", startedAt: T0, lastUsedAt: T0 },
          { server: "time", state: "ready", startedAt: T0, lastUsedAt: T0 },
        ],
      }),
      makeSession({
        sessionId: "child-0002",
        parentSessionId: "parent-0001",
        instances: [{ server: "fetch", state: "connecting", startedAt: T0, lastUsedAt: T0 }],
      }),
    ],
  );
  assert.equal(runningInstanceCount(status), 3);
});

test("预览样例：两个会话（一个子代理）、共 3 个实例、服务器名是 fetch / time", () => {
  const status = runningPreviewStatus(T0);
  assert.equal(status.sessions.length, 2);
  assert.equal(runningInstanceCount(status), 3);
  assert.deepEqual(status.sessions.map((session) => session.sessionId), ["preview-parent-0001", "preview-child-0002"]);
  assert.equal(status.sessions[1].parentSessionId, "preview-parent-0001");
  assert.deepEqual(
    status.sessions.flatMap((session) => session.instances.map((instance) => instance.server)),
    ["fetch", "time", "fetch"],
  );
});
