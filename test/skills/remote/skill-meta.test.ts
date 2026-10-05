/**
 * skill-meta.ts：读上游 SKILL.md 的 name / description（用 DSH 同一个 yaml 库）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as YAML from "yaml";
import { createSkillMetaReader } from "../../../src/skills/remote/skill-meta.ts";

const meta = createSkillMetaReader(YAML);

test("取 name / description：注释、引号、块标量与 DSH 的取值一致", () => {
  assert.deepEqual(meta("---\nname: demo # 注释\ndescription: 'it''s ok'\n---\nbody"), {
    name: "demo",
    description: "it's ok",
  });
  assert.deepEqual(meta("---\r\nname: demo\r\ndescription: >\r\n  a\r\n  b\r\n---\r\n"), {
    name: "demo",
    description: "a b",
  });
});

test("宽容：BOM 照读；没有 frontmatter、未闭合、不是映射、解析失败都返回空对象", () => {
  assert.deepEqual(meta("\uFEFF---\nname: demo\n---\n"), { name: "demo" });
  assert.deepEqual(meta("# 没有 frontmatter"), {});
  assert.deepEqual(meta("---\nname: demo\n"), {});
  assert.deepEqual(meta("---\n- a\n---\n"), {});
  assert.deepEqual(meta("---\nname: a\nname: b\n---\n"), {});
  assert.deepEqual(meta("---\nname: [a\n---\n"), {});
  assert.deepEqual(meta("---\nname: 3\ndescription: '  '\n---\n"), {}, "不是非空字符串就不算");
});
