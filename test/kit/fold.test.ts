/**
 * kit/fold.ts：可折叠分组的折叠状态（技能列表、仓库视图共用）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_FOLD, foldExpanded, foldToggle } from "../../src/kit/fold.ts";

test("不筛选：没点过的分组用默认值，点过的记住", () => {
  let state = EMPTY_FOLD;
  assert.equal(foldExpanded(state, "", "a"), true, "默认展开");
  assert.equal(foldExpanded(state, "", "b", false), false, "调用方可以给默认折叠");
  state = foldToggle(state, "", "b", false);
  assert.equal(foldExpanded(state, "", "b", false), true);
  state = foldToggle(state, "", "a");
  assert.equal(foldExpanded(state, "", "a"), false);
});

test("筛选中：默认全部展开（不看默认值），折叠只对这一次筛选有效", () => {
  let state = foldToggle(EMPTY_FOLD, "", "a");
  assert.equal(foldExpanded(state, "q1", "a"), true, "进入筛选先展开");
  assert.equal(foldExpanded(state, "q1", "b", false), true, "默认折叠的分组在筛选中也先展开");
  state = foldToggle(state, "q1", "a");
  assert.equal(foldExpanded(state, "q1", "a"), false, "筛选中可以折叠");
  assert.equal(foldExpanded(state, "q2", "a"), true, "换一种筛选又全部展开");
  assert.equal(foldExpanded(state, "", "a"), false, "清空筛选回到不筛选时的状态");
});

test("纯函数：toggle 不修改原状态", () => {
  const before = EMPTY_FOLD;
  foldToggle(before, "", "a");
  foldToggle(before, "q", "a");
  assert.equal(before.normal.size, 0);
  assert.equal(before.scoped.open.size, 0);
});
