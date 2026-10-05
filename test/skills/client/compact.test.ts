/**
 * 列表口径的纯逻辑单测（UI-A 重做后）：
 *   平铺技能判定、一行最多几个标记、标记的优先级、详细程度（最多 2 个由 kit 截断）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clampBadges, MAX_ROW_BADGES } from "../../../src/kit/pure.ts";
import { isFlatSkill, rowBadges, sortSkills } from "../../../src/skills/client/format.ts";
import { diag, makeSkill } from "./fixtures.ts";

test("平铺技能：dirName 以 .md 结尾（大小写不敏感）", () => {
  assert.equal(isFlatSkill({ dirName: "zz-flat.md" }), true);
  assert.equal(isFlatSkill({ dirName: "zz-flat.MD" }), true);
  assert.equal(isFlatSkill({ dirName: "zz-flat.md.bak" }), false);
  assert.equal(isFlatSkill({ dirName: "grilling" }), false);
  assert.equal(isFlatSkill({ dirName: "markdown" }), false);
});

test("正常数据下一行没有任何标记（「只在需要时出现」）", () => {
  assert.deepEqual(rowBadges(makeSkill({ id: "user-agents:ok", name: "ok" })), []);
});

test("一行只用三种标记 + 无名称兜底，顺序即优先级", () => {
  const flatNamed = makeSkill({ id: "user-agents:a", name: "a" });
  assert.deepEqual(rowBadges(flatNamed, { updatable: new Set(["user-agents:a"]) }).map((badge) => [badge.key, badge.tone]), [
    ["updatable", "accent"],
  ]);

  const broken = makeSkill({ id: "user-agents:b", name: "b", loadable: false, modelVisible: false, diagnostics: [diag("error", "BOM_PRESENT")] });
  assert.deepEqual(rowBadges(broken).map((badge) => [badge.key, badge.label, badge.tone]), [
    ["notLoadable", "不可加载", "danger"],
  ]);

  const shadowed = makeSkill({ id: "user-agents:c", name: "c", modelVisible: false, shadowedBy: "user-dsh:c" });
  const shadowedBadges = rowBadges(shadowed);
  assert.deepEqual(shadowedBadges.map((badge) => [badge.key, badge.label, badge.tone]), [["shadowed", "被遮蔽", "neutral"]]);
  assert.equal(shadowedBadges[0]!.title, "被更高优先级的 user-dsh:c 遮蔽");

  const unnamed = makeSkill({ id: "user-agents:d", dirName: "d-dir" });
  assert.deepEqual(rowBadges(unnamed).map((badge) => badge.key), ["noName"]);

  // 同时命中四个时：前两个胜出（kit 的 clampBadges 负责截断）
  const everything = makeSkill({ id: "user-agents:e", dirName: "e-dir", loadable: false, shadowedBy: "x:e" });
  const all = rowBadges(everything, { updatable: new Set(["user-agents:e"]) });
  assert.deepEqual(all.map((badge) => badge.key), ["notLoadable", "updatable", "shadowed", "noName"]);
  assert.deepEqual(clampBadges(all).map((badge) => badge.key), ["notLoadable", "updatable"]);
  assert.equal(MAX_ROW_BADGES, 2);
});

test("排序仍是按显示名（重做没有改排序语义）", () => {
  const list = [makeSkill({ id: "user-agents:b", name: "Beta" }), makeSkill({ id: "user-agents:a", name: "alpha" })];
  assert.deepEqual(
    sortSkills(list).map((skill) => skill.id),
    ["user-agents:a", "user-agents:b"],
  );
});
