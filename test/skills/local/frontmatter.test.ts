import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as YAML from "yaml";
import { createFrontmatter, SKILL_NAME_PATTERN } from "../../../src/skills/local/frontmatter/index.ts";
import { firstDiff, sliceLines } from "./fixtures.ts";

// 通过 frontmatter 模块的两个入口测（判断 / 改写）；yaml 用 devDependency 里与 DSH 同版本（2.9.1）的那份。
const frontmatter = createFrontmatter(YAML);
const evaluateFrontmatter = frontmatter.evaluate;
const rewriteDisableModelInvocation = frontmatter.rewriteDisableModelInvocation;
/** 文档层（围栏、行尾）的结果也从判断入口拿。 */
const decodeDocument = (buffer: Buffer) => ({ doc: evaluateFrontmatter(buffer).doc! });

const b = (text: string) => Buffer.from(text, "utf8");

function codes(result: { diagnostics: { code: string }[] }): string[] {
  return result.diagnostics.map((d) => d.code);
}

function diag(
  result: { diagnostics: { code: string; message: string }[] },
  code: string,
): { code: string; message: string } {
  const found = result.diagnostics.find((d) => d.code === code);
  assert.ok(
    found !== undefined,
    "缺少诊断 " + code + "，实际：" + JSON.stringify(result.diagnostics.map((d) => d.code)),
  );
  return found;
}

/** 断言：除允许变化的那一行外，其余每一行的原始字节完全一致。 */
function assertOnlyLinesChanged(before: Buffer, after: Buffer, allowed: number[]): void {
  const a = sliceLines(before);
  const c = sliceLines(after);
  assert.equal(c.length, a.length, "行数不应变化");
  for (let i = 0; i < a.length; i += 1) {
    if (allowed.includes(i)) continue;
    assert.equal(after.subarray(0, 0).length, 0);
    assert.equal(c[i].text, a[i].text, "第 " + i + " 行不应变化");
  }
}

test("CRLF 文件改一行后除该行外逐字节相同", () => {
  const before = b("---\r\nname: demo\r\ndescription: hello\r\n---\r\n\r\n# body\r\n");
  const r = rewriteDisableModelInvocation(before, false);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  const after = r.content;
  assert.equal(after.toString("utf8").includes("name: demo\r\ndescription: hello\r\n"), true, "原有 CRLF 行必须保持");
  assert.equal(after.toString("utf8").includes("disable-model-invocation: true\r\n"), true, "新增行必须用 CRLF");
  // 逐字节核对：只多了一行
  const diff = firstDiff(before, after);
  assert.ok(diff >= 0);
  assert.equal(before.subarray(0, diff).equals(after.subarray(0, diff)), true);
  assert.equal(after.length, before.length + "disable-model-invocation: true\r\n".length);
});

test("LF 文件改一行后除该行外逐字节相同（已有键就地替换）", () => {
  const before = b(
    "---\nname: demo\ndescription: hello\ndisable-model-invocation: true\nlicense: MIT\n---\n\n# body\n",
  );
  const r = rewriteDisableModelInvocation(before, true);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  const after = r.content.toString("utf8");
  assert.equal(
    after,
    "---\nname: demo\ndescription: hello\ndisable-model-invocation: false\nlicense: MIT\n---\n\n# body\n",
  );
  assert.equal(after.length, before.length + 1, "true -> false 只多一个字符");
});

test("启用且键不存在时不改文件（changed=false，字节完全相同）", () => {
  const before = b("---\nname: demo\ndescription: hello\n---\n\n# body\n");
  const r = rewriteDisableModelInvocation(before, true);
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.content.equals(before), true);
});

test("文件末尾无换行时插入行仍保持「末尾无换行」", () => {
  const before = b("---\nname: demo\ndescription: hello\n---");
  const r = rewriteDisableModelInvocation(before, false);
  assert.equal(r.ok, true);
  const after = r.content.toString("utf8");
  assert.equal(after, "---\nname: demo\ndescription: hello\ndisable-model-invocation: true\n---");
  assert.equal(after.endsWith("---"), true);
});

test("BOM 保留：文件字节不变，且官方会忽略该技能（loadable=false）", () => {
  const before = b("\uFEFF---\nname: demo\ndescription: hello\n---\n");
  const evaluated = evaluateFrontmatter(before);
  assert.equal(evaluated.loadable, false);
  assert.equal(evaluated.safeToToggle, false);
  assert.equal(evaluated.doc?.bom, true);
  assert.equal(codes(evaluated).includes("BOM_PRESENT"), true);
  const r = rewriteDisableModelInvocation(before, false);
  assert.equal(r.ok, false);
  assert.equal(r.content.equals(before), true, "BOM 文件绝不能被改写");
  assert.ok((r.reason ?? "").length > 0, "必须给出中文原因");
});

test("折叠块标量 > 的 description 正确解析", () => {
  const before = b(
    "---\nname: lyco\ndescription: >\n  Team skills for planning,\n  building, and shipping.\n  中文行。\nagent_created: true\n---\n",
  );
  const evaluated = evaluateFrontmatter(before);
  assert.equal(evaluated.loadable, true);
  assert.equal(evaluated.description, "Team skills for planning, building, and shipping. 中文行。\n");
  assert.equal(evaluated.name, "lyco");
  assert.equal(evaluated.data.agent_created, true);
});

test("折叠块标量：空行转成换行、>- 去掉末尾换行", () => {
  const description = (header: string, lines: string[]) =>
    evaluateFrontmatter(b("---\nname: demo\ndescription: " + header + "\n" + lines.join("\n") + "\n---\n")).description;
  assert.equal(description(">", ["  a", "", "  b"]), "a\nb\n");
  assert.equal(description(">-", ["  a", "", "  b"]), "a\nb");
  assert.equal(description("|", ["  a", "  b"]), "a\nb\n");
  assert.equal(description("|-", ["  a", "  b"]), "a\nb");
});

test("嵌套 metadata 下的同名子键不被误改", () => {
  const before = b(
    '---\nname: archify\ndescription: hi\nmetadata:\n  disable-model-invocation: false\n  version: "2.14"\n---\n',
  );
  const r = rewriteDisableModelInvocation(before, false);
  assert.equal(r.ok, true);
  const after = r.content.toString("utf8");
  assert.equal(
    after,
    '---\nname: archify\ndescription: hi\nmetadata:\n  disable-model-invocation: false\n  version: "2.14"\ndisable-model-invocation: true\n---\n',
  );
  const evaluated = evaluateFrontmatter(r.content);
  assert.equal(evaluated.modelInvocationDisabled, true);
  assert.equal(evaluated.data.metadata !== undefined, true);
});

test("extraKeys 保留：argument-hint / license / agent_created 收集且文件改写时不动它们", () => {
  const before = b(
    '---\nname: handoff\ndescription: hi\nargument-hint: "[task description]"\nlicense: MIT\nagent_created: true\n---\n',
  );
  const evaluated = evaluateFrontmatter(before);
  assert.deepEqual(evaluated.extraKeys.slice().sort(), ["agent_created", "argument-hint", "license"]);
  assert.equal(evaluated.loadable, true);
  const r = rewriteDisableModelInvocation(before, false);
  assert.equal(r.ok, true);
  const after = r.content.toString("utf8");
  assert.equal(after.includes('argument-hint: "[task description]"\n'), true);
  assert.equal(after.includes("license: MIT\n"), true);
  assert.equal(after.includes("agent_created: true\n"), true);
});

test("非法布尔：诊断 BOOLEAN_INVALID 且 loadable=false", () => {
  const evaluated = evaluateFrontmatter(b("---\nname: demo\ndescription: hi\ndisable-model-invocation: maybe\n---\n"));
  assert.equal(evaluated.loadable, false);
  const d = diag(evaluated, "BOOLEAN_INVALID");
  assert.equal(d.message.includes("maybe"), true);
  assert.equal(d.message.includes("true/false"), true);
});

test('布尔宽容度照抄官方（true/false、1/0、"true"、yes/on/no/off、大小写）', () => {
  const cases: [string, true | false | "invalid"][] = [
    ["true", true],
    ["false", false],
    ["1", true],
    ["0", false],
    ['"1"', true],
    ['"0"', false],
    ['"true"', true],
    ['"FALSE"', false],
    ["yes", true],
    ["on", true],
    ["Off", false],
    ['"no"', false],
    ["maybe", "invalid"],
    ["2", "invalid"],
  ];
  for (const [raw, expected] of cases) {
    const evaluated = evaluateFrontmatter(
      b("---\nname: demo\ndescription: hi\ndisable-model-invocation: " + raw + "\n---\n"),
    );
    if (expected === "invalid") {
      assert.equal(evaluated.loadable, false, raw + " 应判为非法");
      assert.equal(
        evaluated.diagnostics.some((d) => d.code === "BOOLEAN_INVALID"),
        true,
        raw,
      );
    } else {
      assert.equal(evaluated.loadable, true, raw + " 应判为合法");
      assert.equal(evaluated.modelInvocationDisabled, expected, raw);
    }
  }
});

test("legacy 键：disableModelInvocation / modelInvocable / userInvocable 都会让技能被丢弃", () => {
  for (const [key, canonical] of [
    ["disableModelInvocation", "disable-model-invocation"],
    ["modelInvocable", "disable-model-invocation"],
    ["userInvocable", "user-invocable"],
  ]) {
    const evaluated = evaluateFrontmatter(b("---\nname: demo\ndescription: hi\n" + key + ": true\n---\n"));
    assert.equal(evaluated.loadable, false, key);
    const d = diag(evaluated, "LEGACY_KEY_PRESENT");
    assert.equal(d.message.includes(key), true);
    assert.equal(d.message.includes(canonical), true);
  }
});

test("name 校验：官方正则、缺字段、空字符串", () => {
  assert.equal(SKILL_NAME_PATTERN.test("find-skills"), true);
  assert.equal(SKILL_NAME_PATTERN.test("a"), true);
  assert.equal(SKILL_NAME_PATTERN.test("a-"), false);
  assert.equal(SKILL_NAME_PATTERN.test("a--b"), false);
  assert.equal(SKILL_NAME_PATTERN.test("-a"), false);
  assert.equal(SKILL_NAME_PATTERN.test("A-b"), false);
  assert.equal(SKILL_NAME_PATTERN.test("a_b"), false);

  const missing = evaluateFrontmatter(b("---\ndescription: hi\n---\n"));
  assert.equal(missing.loadable, false);
  diag(missing, "SKILL_NAME_MISSING");

  const bad = evaluateFrontmatter(b("---\nname: a--b\ndescription: hi\n---\n"));
  assert.equal(bad.loadable, false);
  diag(bad, "SKILL_NAME_INVALID");

  const noDesc = evaluateFrontmatter(b("---\nname: demo\n---\n"));
  assert.equal(noDesc.loadable, false);
  diag(noDesc, "SKILL_DESCRIPTION_MISSING");
});

test("没有 frontmatter / 未闭合 / 首行非裸 --- 都判不可加载且不可改写", () => {
  const noFm = evaluateFrontmatter(b("# hello\n"));
  assert.equal(noFm.loadable, false);
  diag(noFm, "FRONTMATTER_MISSING");
  assert.equal(rewriteDisableModelInvocation(b("# hello\n"), false).ok, false);

  const unclosed = evaluateFrontmatter(b("---\nname: demo\ndescription: hi\n"));
  assert.equal(unclosed.loadable, false);
  diag(unclosed, "FRONTMATTER_UNCLOSED");

  const indented = evaluateFrontmatter(b("  ---\nname: demo\n---\n"));
  assert.equal(indented.loadable, false);
  diag(indented, "FRONTMATTER_MISSING");
});

test("L2：流式集合、锚点、多文档、制表符缩进不崩且 safeToToggle=false", () => {
  const flow = evaluateFrontmatter(b("---\nname: demo\ndescription: hi\ntags: [a, b]\n---\n"));
  assert.equal(flow.loadable, true, "yaml 能解析流式集合，因此仍可加载");
  assert.equal(flow.safeToToggle, false, "但不允许改写");
  assert.equal(
    flow.diagnostics.some((d) => d.code === "YAML_L2_FEATURE"),
    true,
  );
  assert.equal(
    rewriteDisableModelInvocation(b("---\nname: demo\ndescription: hi\ntags: [a, b]\n---\n"), false).ok,
    false,
  );

  const anchor = evaluateFrontmatter(b("---\nname: demo\ndescription: &d hi\n---\n"));
  assert.equal(anchor.safeToToggle, false);

  // frontmatter 里不可能出现真正的多文档分隔（第一个裸 --- 就是闭合围栏），
  // 但 %YAML 指令会出现在区段内，必须判为不安全。
  const directive = evaluateFrontmatter(b("---\n%YAML 1.2\nname: demo\ndescription: hi\n---\n"));
  assert.equal(directive.safeToToggle, false);
  assert.equal(
    directive.diagnostics.some((d) => d.code === "YAML_UNSUPPORTED"),
    true,
  );

  const tab = evaluateFrontmatter(b("---\nname: demo\ndescription: hi\n\tbad: 1\n---\n"));
  assert.equal(tab.loadable, false, "制表符缩进会让 yaml 解析失败");
  assert.equal(tab.safeToToggle, false);

  const seq = evaluateFrontmatter(b("---\nname: demo\ndescription: hi\n- a\n---\n"));
  assert.equal(seq.safeToToggle, false);
});

test("L1：注释与空行被保留，不影响解析", () => {
  const before = b("---\n# 说明\nname: demo\n\ndescription: hi\n---\n");
  const evaluated = evaluateFrontmatter(before);
  assert.equal(evaluated.loadable, true);
  assert.equal(evaluated.safeToToggle, true);
  assert.equal(
    evaluated.diagnostics.some((d) => d.code === "YAML_L1_FEATURE"),
    true,
  );
  const r = rewriteDisableModelInvocation(before, false);
  assert.equal(r.ok, true);
  assert.equal(r.content.toString("utf8").includes("# 说明\nname: demo\n\ndescription: hi\n"), true);
});

test("引号标量：单引号、双引号与 \\n 转义", () => {
  const single = evaluateFrontmatter(b("---\nname: demo\ndescription: 'it''s fine: yes'\n---\n"));
  assert.equal(single.description, "it's fine: yes");
  const double = evaluateFrontmatter(b('---\nname: demo\ndescription: "line1\\nline2"\n---\n'));
  assert.equal(double.description, "line1\nline2");
  const simple = evaluateFrontmatter(b('---\nname: demo\ndescription: "Ordinary text"\n---\n'));
  assert.equal(simple.description, "Ordinary text");
});

test("whenToUse 非字符串被忽略（警告），字符串则生效", () => {
  const bad = evaluateFrontmatter(b("---\nname: demo\ndescription: hi\nwhenToUse: [1]\n---\n"));
  assert.equal(bad.loadable, true);
  assert.equal(
    bad.diagnostics.some((d) => d.code === "WHEN_TO_USE_IGNORED"),
    true,
  );
  const good = evaluateFrontmatter(b("---\nname: demo\ndescription: hi\nwhenToUse: 当用户问起时\n---\n"));
  assert.equal(good.data.whenToUse, "当用户问起时");
});

test("metadata 非对象时给 METADATA_IGNORED 警告但不影响加载", () => {
  const evaluated = evaluateFrontmatter(b("---\nname: demo\ndescription: hi\nmetadata: [1, 2]\n---\n"));
  assert.equal(evaluated.loadable, true);
  assert.equal(
    evaluated.diagnostics.some((d) => d.code === "METADATA_IGNORED"),
    true,
  );
});

test("frontmatter 行尾风格与混合行尾检测", () => {
  assert.equal(decodeDocument(b("---\nname: a\n---\n")).doc.eol, "lf");
  assert.equal(decodeDocument(b("---\r\nname: a\r\n---\r\n")).doc.eol, "crlf");
  assert.equal(decodeDocument(b("---\r\nname: a\n---\r\n")).doc.eol, "mixed");
  const mixed = evaluateFrontmatter(b("---\r\nname: demo\ndescription: hi\r\n---\r\n"));
  assert.equal(mixed.doc?.eol, "mixed");
  assert.equal(mixed.safeToToggle, false, "混合行尾不允许改写");
});

test("非 UTF-8 文件不崩且判为不可加载、不可改写", () => {
  const buffer = Buffer.from([
    0x2d, 0x2d, 0x2d, 0x0a, 0x6e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0xff, 0xfe, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a,
  ]);
  const evaluated = evaluateFrontmatter(buffer);
  assert.equal(evaluated.loadable, false);
  assert.equal(
    evaluated.diagnostics.some((d) => d.code === "NOT_UTF8"),
    true,
  );
  const r = rewriteDisableModelInvocation(buffer, false);
  assert.equal(r.ok, false);
  assert.equal(r.content.equals(buffer), true);
});

test("布尔取值与官方一致：缺省 / true / ON / 非法", () => {
  const withValue = (value: string | undefined) =>
    evaluateFrontmatter(
      b(
        "---\nname: demo\ndescription: hi\n" +
          (value === undefined ? "" : "disable-model-invocation: " + value + "\n") +
          "---\n",
      ),
    );
  assert.equal(withValue(undefined).modelInvocationDisabled, false, "缺省 = 不禁止");
  assert.equal(withValue("true").modelInvocationDisabled, true);
  assert.equal(withValue("ON").modelInvocationDisabled, true);
  const invalid = withValue("zzz");
  assert.equal(invalid.loadable, false);
  assert.equal(
    invalid.diagnostics.some((d) => d.code === "BOOLEAN_INVALID"),
    true,
  );
});

test("重复顶层键：yaml 会报错，因此判为不可加载", () => {
  const evaluated = evaluateFrontmatter(b("---\nname: demo\nname: other\ndescription: hi\n---\n"));
  assert.equal(evaluated.loadable, false);
  assert.equal(
    evaluated.diagnostics.some((d) => d.code === "YAML_DUPLICATE_KEY"),
    true,
  );
  assert.equal(evaluated.safeToToggle, false);
});

/* ---------------- 回归：正文里的同名行绝不能被当成设置 ---------------- */

/** 取闭合围栏之后的正文原文（字节级）。 */
function bodyOf(text: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  assert.ok(m !== null, "测试数据必须有闭合围栏");
  return text.slice(m[0].length);
}

test("回归：正文（含代码块示例）里的 disable-model-invocation 行不被当成设置（LF）", () => {
  const doc = [
    "---",
    "name: demo",
    "description: d",
    "---",
    "# Demo",
    "",
    "在 frontmatter 里写：",
    "",
    "```yaml",
    "disable-model-invocation: true",
    "```",
    "",
    "也可以写 disable-model-invocation: false。",
    "",
  ].join("\n");
  const before = b(doc);
  const bodyBefore = bodyOf(doc);
  assert.equal(evaluateFrontmatter(before).modelInvocationDisabled, false, "正文不算设置");

  const off = rewriteDisableModelInvocation(before, false);
  assert.equal(off.ok, true);
  assert.equal(off.changed, true, "停用时必须真的往 frontmatter 写入键，而不是误判为已停用");
  const offText = off.content.toString("utf8");
  assert.equal(bodyOf(offText), bodyBefore, "正文字节必须完全不变");
  assert.equal(offText, doc.replace("---\n# Demo", "disable-model-invocation: true\n---\n# Demo"));
  assert.equal(evaluateFrontmatter(off.content).modelInvocationDisabled, true, "写入后应真的被判定为停用");

  const back = rewriteDisableModelInvocation(off.content, true);
  assert.equal(back.ok, true);
  const backText = back.content.toString("utf8");
  assert.equal(bodyOf(backText), bodyBefore);
  assert.equal(evaluateFrontmatter(back.content).modelInvocationDisabled, false);
});

test("回归：正文里的 disable-model-invocation 行不被改写（CRLF）", () => {
  const doc = [
    "---",
    "name: demo",
    "description: d",
    "disable-model-invocation: true",
    "---",
    "# Demo",
    "",
    "disable-model-invocation: false",
    "",
  ].join("\r\n");
  const before = b(doc);
  const bodyBefore = bodyOf(doc);

  const on = rewriteDisableModelInvocation(before, true);
  assert.equal(on.ok, true);
  assert.equal(on.changed, true);
  const onText = on.content.toString("utf8");
  assert.equal(bodyOf(onText), bodyBefore, "正文字节必须完全不变");
  assert.equal(onText.includes("\r\ndisable-model-invocation: false\r\n---\r\n".replace("\r\n---", "\r\n---")), true);
  assert.equal(on.content.length, before.length + 1, "true -> false 只多一个字符");
  assert.equal(bodyOf(onText).includes("disable-model-invocation: false"), true, "正文里的那行必须原样保留");
  assert.equal(evaluateFrontmatter(on.content).modelInvocationDisabled, false);

  const off = rewriteDisableModelInvocation(on.content, false);
  assert.equal(bodyOf(off.content.toString("utf8")), bodyBefore);
  assert.equal(evaluateFrontmatter(off.content).modelInvocationDisabled, true);
});

test("回归：只有正文出现该行时，启用动作完全不改文件", () => {
  const doc = "---\nname: demo\ndescription: d\n---\n\ndisable-model-invocation: true\n";
  const before = b(doc);
  const r = rewriteDisableModelInvocation(before, true);
  assert.equal(r.ok, true);
  assert.equal(r.changed, false, "frontmatter 里没有该键，启用是空操作");
  assert.equal(r.content.equals(before), true);
});

test("回归：键名前缀相同（disable-model-invocation-x）不会被误认", () => {
  const doc = "---\nname: demo\ndescription: d\n---\n\ndisable-model-invocation-x: true\n";
  const r = rewriteDisableModelInvocation(b(doc), false);
  assert.equal(r.changed, true);
  assert.equal(bodyOf(r.content.toString("utf8")).includes("disable-model-invocation-x: true"), true);
});

test("回归：缩进的同名子键（metadata 下）与正文同名行同时存在时只改顶层", () => {
  const doc =
    "---\nname: demo\ndescription: d\nmetadata:\n  disable-model-invocation: true\n---\n\ndisable-model-invocation: true\n";
  const r = rewriteDisableModelInvocation(b(doc), false);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  const out = r.content.toString("utf8");
  assert.equal(
    out,
    "---\nname: demo\ndescription: d\nmetadata:\n  disable-model-invocation: true\ndisable-model-invocation: true\n---\n\ndisable-model-invocation: true\n",
  );
  assert.equal(bodyOf(out), "\ndisable-model-invocation: true\n");
  assert.equal(evaluateFrontmatter(r.content).modelInvocationDisabled, true);
});

test("不变式：解析出的键只来自 frontmatter 区段，正文里任何内容都不参与", () => {
  const cases = [
    "---\nname: demo\ndescription: d\n---\n\n```yaml\nname: evil\ndescription: evil\ndisable-model-invocation: true\n---\n```\n",
    "---\nname: demo\ndescription: d\n---\n\n---\nname: evil\ndisable-model-invocation: true\n---\n",
    "---\nname: demo\ndescription: d\n---\n\nSome text\n\n---\n\nname: evil\n",
    "---\nname: demo\ndescription: >\n  folded\n  text\ndisable-model-invocation: false\n---\n\ndisable-model-invocation: true\n",
    "---\nname: demo\ndescription: d\nmetadata:\n  name: nested\n---\n\nname: body-name\ndisable-model-invocation: true\n",
    "---\nname: demo\ndescription: d\ntags:\n  - name: evil\n---\n\n- name: evil\n",
  ];
  for (const doc of cases) {
    const buf = b(doc);
    const { doc: decoded } = decodeDocument(buf);
    const evaluated = evaluateFrontmatter(buf);
    // 独立地从 block 里推导顶层键（0 缩进、形如 key: ...）
    const expected = decoded.block
      .map((l) => /^([A-Za-z][A-Za-z0-9_-]*):/.exec(l.text)?.[1])
      .filter((k): k is string => k !== undefined);
    assert.deepEqual(evaluated.order, expected, "解析出的键必须恰好来自 frontmatter 区段：" + JSON.stringify(doc));
    assert.equal(evaluated.name, "demo", "name 不能被正文污染：" + JSON.stringify(doc));
  }
});

test("块标量内的裸 --- 会像官方一样提前截断 frontmatter，后续内容属于正文", () => {
  const doc = "---\nname: demo\ndescription: >\n  a\n---\n  b\ndisable-model-invocation: true\n";
  const { doc: decoded } = decodeDocument(b(doc));
  // 行序：0 --- / 1 name / 2 description: > / 3 内容 / 4 --- / 5 后续正文
  assert.equal(decoded.closeIndex, 4, "闭合围栏取第一个行首裸 ---（官方同样如此）");
  const evaluated = evaluateFrontmatter(b(doc));
  assert.equal(evaluated.description, "a\n");
  assert.equal(evaluated.modelInvocationDisabled, false, "被截断到正文里的键不算设置");
  const r = rewriteDisableModelInvocation(b(doc), false);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(
    r.content.toString("utf8").includes("\n  b\ndisable-model-invocation: true\n"),
    true,
    "正文必须原样保留",
  );
});

/* ---------------- 行尾注释（与官方 yaml 2.9.1 一致；对拍见 yaml-parity.mjs） ---------------- */

test("行尾注释：纯标量里的「空白 + #」是注释，与官方 yaml 的取值一致", () => {
  const doc = "---\nname: demo # c\ndescription: hello # note\ndisable-model-invocation: true # 停用\n---\n\n# body\n";
  const r = evaluateFrontmatter(b(doc));
  assert.equal(r.name, "demo", "name 不能包含行尾注释");
  assert.equal(r.description, "hello");
  assert.equal(r.modelInvocationDisabled, true, "true # 停用 必须解析成布尔 true");
  assert.equal(r.loadable, true, "带行尾注释不是缺陷，DSH 官方一样能加载");
  assert.equal(codes(r).includes("BOOLEAN_INVALID"), false);
  assert.deepEqual(r.order, ["name", "description", "disable-model-invocation"]);
});

test("行尾注释：CRLF 文件同样处理，且不影响取值", () => {
  const doc = "---\r\nname: demo # c\r\ndescription: hello # note\r\nuser-invocable: false # 隐藏\r\n---\r\n";
  const r = evaluateFrontmatter(b(doc));
  assert.equal(r.name, "demo");
  assert.equal(r.description, "hello");
  assert.equal(r.userInvocable, false);
  assert.equal(r.loadable, true);
  assert.equal(r.doc?.eol, "crlf");
});

test("行尾注释：a#b 的 # 前面没有空白，属于正文", () => {
  const r = evaluateFrontmatter(b("---\nname: demo\ndescription: a#b#c\n---\n"));
  assert.equal(r.description, "a#b#c");
  // true#x 整体是字符串，官方同样判非法布尔并丢弃该技能
  const bad = evaluateFrontmatter(b("---\nname: demo\ndescription: hello\ndisable-model-invocation: true#x\n---\n"));
  assert.equal(bad.loadable, false);
  assert.equal(codes(bad).includes("BOOLEAN_INVALID"), true);
});

test("行尾注释：引号内的 # 是正文，引号外的「空白 + #」才是注释", () => {
  const dbl = '---\nname: demo\ndescription: "a # b" # 真注释\n---\n';
  assert.equal(evaluateFrontmatter(b(dbl)).description, "a # b");
  const sgl = "---\nname: demo\ndescription: 'a # b' # 注释\n---\n";
  assert.equal(evaluateFrontmatter(b(sgl)).description, "a # b");
  const esc = "---\nname: demo\ndescription: 'it''s # here' # 注释\n---\n";
  assert.equal(evaluateFrontmatter(b(esc)).description, "it's # here");
  // 引号标量结束后即使没有空白也不是注释（a#b 规则的镜像）
  const trailing = '---\nname: demo\ndescription: "hello"    # 多个空格\n---\n';
  assert.equal(evaluateFrontmatter(b(trailing)).description, "hello");
});

test("行尾注释：整行注释被忽略，不会变成键，也不影响 loadable", () => {
  const doc = "---\n# 顶部注释\nname: demo\n\n# 中间注释\ndescription: hello # 行尾注释\n# 尾部注释\n---\n\n# body\n";
  const r = evaluateFrontmatter(b(doc));
  assert.equal(r.loadable, true);
  assert.deepEqual(r.order, ["name", "description"]);
  assert.deepEqual(r.extraKeys, [], "注释不能变成未知键");
});

test("行尾注释：块标量（| 与 >）内容里的 # 是正文", () => {
  const lit = "---\nname: demo\ndescription: |\n  第一行 # 不是注释\n  第二行\n---\n";
  assert.equal(evaluateFrontmatter(b(lit)).description, "第一行 # 不是注释\n第二行\n");
  const folded = "---\nname: demo\ndescription: >\n  第一行 # 不是注释\n  第二行\n---\n";
  assert.equal(evaluateFrontmatter(b(folded)).description, "第一行 # 不是注释 第二行\n");
  const header = "---\nname: demo\ndescription: | # 头注释\n  内容 # 正文\n---\n";
  assert.equal(evaluateFrontmatter(b(header)).description, "内容 # 正文\n", "块标量头后面的注释不影响内容");
});

test("启停往返：带行尾注释的布尔值只改该行取值，其余字节逐字节相同（LF）", () => {
  const before = b(
    "---\nname: demo # 名字\ndescription: hello # 说明\ndisable-model-invocation: true # 停用\nlicense: MIT # 许可\n---\n\n# body\n",
  );
  const on = rewriteDisableModelInvocation(before, true);
  assert.equal(on.ok, true);
  assert.equal(on.changed, true);
  assert.equal(
    on.content.toString("utf8"),
    "---\nname: demo # 名字\ndescription: hello # 说明\ndisable-model-invocation: false # 停用\nlicense: MIT # 许可\n---\n\n# body\n",
    "注释必须原样保留，只把 true 换成 false",
  );
  assert.equal(on.content.length, before.length + 1, "true -> false 只多一个字符");
  const beforeLines = sliceLines(before);
  const afterLines = sliceLines(on.content);
  assert.equal(afterLines.length, beforeLines.length);
  for (let i = 0; i < beforeLines.length; i += 1) {
    if (i === 3) continue;
    assert.equal(afterLines[i].text, beforeLines[i].text, "第 " + i + " 行必须逐字不变");
  }
  assert.equal(afterLines[3].text, "disable-model-invocation: false # 停用");
  // 往返：再停用一次必须逐字节回到原文件
  const back = rewriteDisableModelInvocation(on.content, false);
  assert.equal(back.ok, true);
  assert.equal(back.changed, true);
  assert.equal(back.content.equals(before), true, "往返后必须逐字节回到原样");
});

test("启停往返：CRLF + 行尾注释，除该行取值外逐字节相同", () => {
  const before = b(
    "---\r\nname: demo\r\ndescription: hello\r\ndisable-model-invocation: false # 已启用\r\n---\r\n\r\n# body\r\n",
  );
  const off = rewriteDisableModelInvocation(before, false);
  assert.equal(off.ok, true);
  assert.equal(
    off.content.toString("utf8"),
    "---\r\nname: demo\r\ndescription: hello\r\ndisable-model-invocation: true # 已启用\r\n---\r\n\r\n# body\r\n",
  );
  assert.equal(off.content.length, before.length - 1, "false -> true 少一个字符");
  const back = rewriteDisableModelInvocation(off.content, true);
  assert.equal(back.content.equals(before), true, "往返后逐字节回到原样（含 CRLF 与注释）");
});

test("启停：注释前的空白与行尾空白原样保留", () => {
  const before = b("---\nname: demo\ndescription: d\ndisable-model-invocation:   true   # 注释\n---\n");
  const on = rewriteDisableModelInvocation(before, true);
  assert.equal(on.ok, true);
  assert.equal(
    on.content.toString("utf8"),
    "---\nname: demo\ndescription: d\ndisable-model-invocation:   false   # 注释\n---\n",
  );
});

test("启停：键后面只有注释（值为 null）时拒绝改写并给中文原因", () => {
  const before = b("---\nname: demo\ndescription: d\ndisable-model-invocation: # 只有注释\n---\n");
  const r = rewriteDisableModelInvocation(before, true);
  assert.equal(r.ok, false);
  assert.equal(r.content.equals(before), true, "拒绝改写时不得改动任何字节");
  assert.equal(/非\u6cd5/.test(r.reason ?? ""), true, "原因必须是中文说明：" + String(r.reason));
});

test("启停：文件里全是注释与空行时，插入新行的行为不受影响", () => {
  const before = b("---\n# 只有注释\nname: demo\ndescription: d # 说明\n---\n\n# body\n");
  const off = rewriteDisableModelInvocation(before, false);
  assert.equal(off.ok, true);
  assert.equal(
    off.content.toString("utf8"),
    "---\n# 只有注释\nname: demo\ndescription: d # 说明\ndisable-model-invocation: true\n---\n\n# body\n",
  );
  // 键已经存在后再启用：只把该行的值改回 false（注释与其余行不动）
  const on = rewriteDisableModelInvocation(off.content, true);
  assert.equal(
    on.content.toString("utf8"),
    "---\n# 只有注释\nname: demo\ndescription: d # 说明\ndisable-model-invocation: false\n---\n\n# body\n",
  );
  // 键从未存在时启用：不动文件（插入逻辑只在停用时触发，行为未变）
  const fresh = rewriteDisableModelInvocation(before, true);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.changed, false, "启用且键不存在时不动文件");
  assert.equal(fresh.content.equals(before), true);
});
