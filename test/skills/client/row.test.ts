/**
 * row.ts：「一行技能长什么样」——通过 skillRowView / skillToggle / accessLines 这三个入口测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { accessLines, skillRowView, skillToggle } from "../../../src/skills/client/row.ts";
import { diag, makeSkill } from "./fixtures.ts";

test("整行：标题、副标题、目录标签、标记", () => {
  const view = skillRowView(makeSkill({ id: "user-agents:a", name: "alpha", description: "做点事" }), {
    dirTag: { text: ".agents", title: "C:\\x\\.agents\\skills" },
  });
  assert.equal(view.title, "alpha");
  assert.equal(view.subtitle, "做点事");
  assert.deepEqual(view.tag, { text: ".agents", title: "C:\\x\\.agents\\skills" });
  assert.deepEqual(view.badges, []);

  const bare = skillRowView(makeSkill({ id: "user-agents:d", dirName: "d-dir" }));
  assert.equal(bare.title, "d-dir", "没有 name 时用目录名");
  assert.equal(bare.subtitle, "", "没有描述也给空串，行高保持一致");
  assert.equal(bare.tag, undefined, "不传目录标签就不显示");
  assert.deepEqual(
    bare.badges.map((badge) => badge.key),
    ["noName"],
  );
});

test("开关（D-B3）：只读技能没有开关；不能安全改写时禁用并给原因；在途时禁用", () => {
  const ok = skillToggle(makeSkill({ id: "a:on", name: "on" }), false);
  assert.deepEqual(ok, { checked: true, disabled: false, label: "停用「on」" });
  assert.equal(
    skillToggle(makeSkill({ id: "a:off", name: "off", modelInvocationDisabled: true }), false)?.label,
    "启用「off」",
  );
  assert.equal(skillToggle(makeSkill({ id: "a:noname", dirName: "dir-only" }), false)?.label, "停用「dir-only」");
  assert.equal(skillToggle(makeSkill({ id: "a:on", name: "on" }), true)?.disabled, true, "启停在途");

  const readonly = makeSkill({ id: "custom-0:ro", rootId: "custom-0", writable: false });
  assert.equal(skillToggle(readonly, false), undefined, "只读技能不放开关");
  assert.equal(skillRowView(readonly).toggle, undefined);

  const unsafe = makeSkill({
    id: "user-agents:bom",
    format: { eol: "lf", bom: true, safeToToggle: false },
    diagnostics: [diag("error", "BOM_PRESENT", "文件以 UTF-8 BOM 开头。")],
  });
  assert.deepEqual(skillToggle(unsafe, false), {
    checked: true,
    disabled: true,
    label: "停用「bom」",
    title: "文件格式不支持安全改写（只能手工改）：文件以 UTF-8 BOM 开头。",
  });
  const unsafeNoDiag = makeSkill({ id: "user-agents:x", format: { eol: "mixed", bom: false, safeToToggle: false } });
  assert.equal(skillToggle(unsafeNoDiag, false)?.title, "文件格式不支持安全改写（只能手工改）");
});

test("调用权限（D-B17）：与 DSH 口径一致，四种组合各有一段文字，默认值调淡，悬停说明来源", () => {
  const both = skillRowView(makeSkill({ id: "a:x" })).access;
  assert.equal(both.text, "模型、用户");
  assert.equal(both.muted, true, "默认的「模型、用户」调淡");
  assert.match(both.title, /模型调用：允许/);
  assert.match(both.title, /用户调用：允许（未设置 user-invocable，默认允许）/);

  const modelOnly = skillRowView(makeSkill({ id: "a:x", userInvocable: false })).access;
  assert.equal(modelOnly.text, "仅模型");
  assert.equal(modelOnly.muted, false, "例外才醒目");
  assert.match(modelOnly.title, /用户调用：禁止（user-invocable: false）/);

  const userOnly = skillRowView(makeSkill({ id: "a:x", modelInvocationDisabled: true, userInvocable: true })).access;
  assert.equal(userOnly.text, "仅用户");
  assert.match(userOnly.title, /模型调用：禁止（disable-model-invocation: true/);
  assert.match(userOnly.title, /用户调用：允许（user-invocable: true）/);

  assert.equal(
    skillRowView(makeSkill({ id: "a:x", modelInvocationDisabled: true, userInvocable: false })).access.text,
    "不可调用",
  );

  const readonly = makeSkill({ id: "custom-1:x", writable: false });
  assert.match(skillRowView(readonly).access.title, /模型调用：允许（只读目录/, "只读技能不说「右侧开关可关闭」");
  assert.match(accessLines(readonly).model, /^允许（只读目录/);
  assert.equal(accessLines(makeSkill({ id: "a:x" })).user, "允许（未设置 user-invocable，默认允许）");
});
