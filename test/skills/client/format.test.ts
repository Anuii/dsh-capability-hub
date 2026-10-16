/**
 * 技能页纯逻辑单测（node:test）。
 *
 * 只测 format.ts / data.ts 这些不依赖 DOM 的函数：组件本身靠 dev profile 的走查
 * （截图 + DOM 事实）验收。UI-A 起筛选口径换成 UI-DESIGN §4 的四段。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  abbreviateHomePath,
  displayName,
  dshWontLoad,
  hiddenFootView,
  homeDirFromRoots,
  isDshInstallPath,
  normalizePath,
  eolLabel,
  fileDepth,
  fileName,
  filterCounts,
  filterLabel,
  FILTERS,
  formatBytes,
  formatDateTime,
  isConflict,
  levelLabel,
  levelTone,
  matches,
  matchesFilter,
  matchesQuery,
  needsAttention,
  removeSkill,
  replaceSkill,
  rootScope,
  sortFiles,
  sortSkills,
  sortTrash,
  trashReasonLabel,
  type FilterId,
  type MatchContext,
} from "../../../src/skills/client/format.ts";
import { workspaceQuery } from "../../../src/skills/client/data.ts";
import { makeList, makeSkill, makeTrashItem, diag, root } from "./fixtures.ts";
import { errorText } from "../../../src/shared/error-text.ts";
import { errorCodeOf, fieldErrorsOf } from "../../../src/platform/client/api.ts";

/* ---------------- UI-C：路径缩写与分组顺序 ---------------- */

const HOME = "C:\\Users\\you";
const ASAR =
  "C:\\Users\\you\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-agent-preset\\skills";

test("normalizePath：正反斜杠统一、去掉末尾分隔符与空白", () => {
  assert.equal(normalizePath("C:/Users/you\\.agents\\skills\\"), "C:\\Users\\you\\.agents\\skills");
  assert.equal(normalizePath("C:\\a//b\\\\c"), "C:\\a\\b\\c");
  assert.equal(normalizePath("  C:\\a\\b  "), "C:\\a\\b");
});

test("isDshInstallPath：只认 app.asar 这一段", () => {
  assert.equal(isDshInstallPath(ASAR), true);
  assert.equal(isDshInstallPath(ASAR.replace(/\\\\/g, "/")), true, "正斜杠写法同样认得");
  assert.equal(isDshInstallPath("C:\\APP.ASAR\\x"), true, "大小写不敏感");
  assert.equal(isDshInstallPath("C:\\Users\\you\\.agents\\skills"), false);
  assert.equal(isDshInstallPath("C:\\x\\app.asarish\\y"), false, "只是前缀相同不算");
  assert.equal(isDshInstallPath(""), false);
});

test("homeDirFromRoots：从 user-agents / user-dsh 的契约路径反推家目录", () => {
  const both = [
    root("user-dsh", { path: HOME + "\\.dsh\\skills" }),
    root("user-agents", { path: HOME + "\\.agents\\skills" }),
  ];
  assert.equal(homeDirFromRoots(both), HOME);
  assert.equal(
    homeDirFromRoots([root("user-agents", { path: "C:/Users/you/.agents/skills" })]),
    "C:\\Users\\you",
    "正反斜杠混用也能反推",
  );
  assert.equal(
    homeDirFromRoots([root("user-dsh", { path: HOME.toUpperCase() + "\\.dsh\\skills" })]),
    HOME.toUpperCase(),
    "盘符大小写不敏感",
  );
  // 两条都给时取更短的那条（更靠近家目录）
  assert.equal(
    homeDirFromRoots([
      root("user-agents", { path: HOME + "\\.agents\\skills" }),
      root("user-dsh", { path: HOME + "\\.dsh\\skills" }),
    ]),
    HOME,
  );
  assert.equal(homeDirFromRoots([root("project-agents", { path: "C:\\work\\demo\\.agents\\skills" })]), undefined);
  assert.equal(homeDirFromRoots([]), undefined);
});

test("abbreviateHomePath：家目录下缩写为 ~\\…，其余原样", () => {
  assert.equal(abbreviateHomePath(HOME + "\\.agents\\skills\\archify", HOME), "~\\.agents\\skills\\archify");
  assert.equal(abbreviateHomePath("c:\\users\\YOU\\.dsh\\skills", HOME), "~\\.dsh\\skills", "盘符大小写不敏感");
  assert.equal(abbreviateHomePath("C:/Users/you/.agents/skills/x", HOME), "~\\.agents\\skills\\x", "正反斜杠混用");
  assert.equal(abbreviateHomePath(HOME, HOME), "~");
  // 只是前缀相同、并不是子路径 → 不缩写
  assert.equal(abbreviateHomePath(HOME + "x\\y", HOME), HOME + "x\\y");
  // 家目录之外的路径一律原样返回（DSH 内置根就是这么躲过缩写的）
  assert.equal(abbreviateHomePath(ASAR, "C:\\Users\\you\\work\\project\\.dev\\home"), ASAR);
  // 家目录之下的路径照样缩写
  assert.equal(
    abbreviateHomePath(ASAR, HOME),
    "~\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-agent-preset\\skills",
  );
  assert.equal(abbreviateHomePath("C:\\other\\x", undefined), "C:\\other\\x", "推不出家目录时原样返回");
  assert.equal(abbreviateHomePath("", HOME), "");
});
test("workspace 为空时不下发 workspace 参数（宿主因此不解析项目级根，D-B2）", () => {
  assert.equal(workspaceQuery(undefined), undefined);
  assert.equal(workspaceQuery(""), undefined);
  assert.equal(workspaceQuery("  "), undefined);
  assert.deepEqual(workspaceQuery("C:\\work\\demo"), { workspace: "C:\\work\\demo" });
});

test("显示名：没有 frontmatter name 时用目录名并标注", () => {
  const named = makeSkill({ id: "user-agents:grilling", name: "grilling" });
  assert.deepEqual(displayName(named), { text: "grilling", fromDir: false, dirName: "grilling" });
  const unnamed = makeSkill({ id: "user-agents:legacy-dir", dirName: "legacy-dir" });
  assert.deepEqual(displayName(unnamed), { text: "legacy-dir", fromDir: true, dirName: "legacy-dir" });
  const empty = makeSkill({ id: "user-agents:x", name: "", dirName: "x" });
  assert.equal(displayName(empty).fromDir, true);
});

test("搜索：命中名称 / 目录名 / id / 描述，空串不过滤", () => {
  const skill = makeSkill({ id: "user-agents:code-review", name: "code-review", description: "审查代码改动" });
  assert.equal(matchesQuery(skill, ""), true);
  assert.equal(matchesQuery(skill, "  "), true);
  assert.equal(matchesQuery(skill, "CODE"), true);
  assert.equal(matchesQuery(skill, "user-agents"), true);
  assert.equal(matchesQuery(skill, "审查"), true);
  assert.equal(matchesQuery(skill, "不存在的东西"), false);
});

test("四段筛选（UI-DESIGN §4）：全部 / 模型可调用 / 模型不可调用 / 需关注", () => {
  const visible = makeSkill({ id: "a:visible", name: "visible" });
  const disabled = makeSkill({
    id: "a:disabled",
    name: "disabled",
    modelInvocationDisabled: true,
    modelVisible: false,
  });
  const broken = makeSkill({ id: "a:broken", name: "broken", loadable: false, modelVisible: false });
  const shadowed = makeSkill({ id: "a:shadowed", name: "shadowed", modelVisible: false, shadowedBy: "b:shadowed" });
  const updatable = makeSkill({ id: "a:updatable", name: "updatable" });
  const context: MatchContext = { updatable: new Set<string>(["a:updatable"]) };

  const all = [visible, disabled, broken, shadowed, updatable];
  const ids = (filter: FilterId): string[] =>
    all.filter((skill) => matchesFilter(skill, filter, context)).map((skill) => skill.id);

  assert.deepEqual(FILTERS, ["all", "enabled", "disabled", "attention"]);
  // 后两段筛的就是 disable-model-invocation（行右侧开关管的那件事），名字必须对得上
  assert.deepEqual(
    FILTERS.map((id) => filterLabel(id)),
    ["全部", "模型可调用", "模型不可调用", "需关注"],
  );
  // 0.8.0（D-B4）：不可加载与被遮蔽的默认不显示，只在「需关注」里出现。
  assert.deepEqual(ids("all"), ["a:visible", "a:disabled", "a:updatable"]);
  assert.deepEqual(ids("enabled"), ["a:visible", "a:updatable"]);
  assert.deepEqual(ids("disabled"), ["a:disabled"]);
  // 需关注 = 不可加载 + 被遮蔽 + 可更新（这三类照旧全在）
  assert.deepEqual(ids("attention"), ["a:broken", "a:shadowed", "a:updatable"]);
  assert.equal(needsAttention(visible, context), false);
  assert.equal(needsAttention(visible), false, "没有 context 时看不到「可更新」，其余两条仍然生效");
  assert.equal(needsAttention(broken), true);
  assert.equal(needsAttention(shadowed), true);
  assert.equal(matches(updatable, "upd", "attention", context), true);
  assert.equal(matches(updatable, "upd", "disabled", context), false);
});

test("DSH 不会加载的技能：不可加载或被遮蔽；搜索也翻不出来（只在「需关注」里）", () => {
  const visible = makeSkill({ id: "a:visible", name: "visible" });
  const broken = makeSkill({ id: "a:broken", name: "broken-skill", loadable: false, modelVisible: false });
  const shadowed = makeSkill({ id: "a:shadowed", name: "shadowed-skill", shadowedBy: "b:shadowed" });
  const updatable = makeSkill({ id: "a:updatable", name: "updatable" });

  assert.equal(dshWontLoad(visible), false);
  assert.equal(dshWontLoad(broken), true);
  assert.equal(dshWontLoad(shadowed), true);
  assert.equal(dshWontLoad(updatable), false, "可更新只是「需关注」，DSH 照样会加载它");

  // 搜索命中名字，但前三段不显示它（搜索与筛选是「与」的关系，不是绕过筛选）
  for (const filter of ["all", "enabled", "disabled"] as const) {
    assert.equal(matches(broken, "broken-skill", filter), false, filter + " 里不该出现不可加载的技能");
    assert.equal(matches(shadowed, "shadowed", filter), false, filter + " 里不该出现被遮蔽的技能");
  }
  assert.equal(matches(broken, "broken-skill", "attention"), true, "「需关注」里照旧能搜到");
  assert.equal(matches(shadowed, "shadowed", "attention"), true);
  // 搜索词为空时同理
  assert.equal(matchesFilter(broken, "all"), false);
  assert.equal(matchesFilter(broken, "attention"), true);
});

test("列表脚注视图模型：有被隐藏的技能且不在「需关注」时提示数量，否则不显示", () => {
  const visible = makeSkill({ id: "a:visible", name: "visible" });
  const broken = makeSkill({ id: "a:broken", name: "broken-skill", loadable: false, modelVisible: false });
  const shadowed = makeSkill({ id: "a:shadowed", name: "shadowed-skill", shadowedBy: "b:shadowed" });
  const skills = [visible, broken, shadowed];

  for (const filter of ["all", "enabled", "disabled"] as const) {
    assert.deepEqual(hiddenFootView(skills, "", filter), { count: 2, visible: true }, filter);
  }
  // 已经在「需关注」里：这些技能本来就显示，不再提示
  assert.deepEqual(hiddenFootView(skills, "", "attention"), { count: 2, visible: false });
  // 一个都没被隐藏：不显示这句
  assert.deepEqual(hiddenFootView([visible], "", "all"), { count: 0, visible: false });
  assert.deepEqual(hiddenFootView([], "", "all"), { count: 0, visible: false });
  // 计数跟着搜索词走：点「查看」只切筛选、不动搜索词，所以行数与这句话对得上
  assert.deepEqual(hiddenFootView(skills, "broken", "all"), { count: 1, visible: true });
  assert.deepEqual(hiddenFootView(skills, "visible", "all"), { count: 0, visible: false });
  assert.deepEqual(hiddenFootView(skills, "SHADOWED", "enabled"), { count: 1, visible: true }, "大小写不敏感");
});

test("分段计数", () => {
  const skills = [
    makeSkill({ id: "a:1", name: "1" }),
    makeSkill({ id: "a:2", name: "2", modelInvocationDisabled: true, modelVisible: false }),
    makeSkill({ id: "a:3", name: "3", loadable: false, modelVisible: false }),
  ];
  // 0.8.0（D-B4）：前三段只数 DSH 会加载的，不可加载的 a:3 只进「需关注」
  assert.deepEqual(filterCounts(skills), { all: 2, enabled: 1, disabled: 1, attention: 1 });
  assert.deepEqual(filterCounts(skills, { updatable: new Set<string>(["a:1"]) }), {
    all: 2,
    enabled: 1,
    disabled: 1,
    attention: 2,
  });
});

test("格式化：字节 / 时间 / 行尾 / 回收站原因", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 * 1024 * 3), "3.0 MB");

  const stamp = formatDateTime("2026-10-04T12:34:00.000Z");
  assert.match(stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatDateTime("不是时间"), "不是时间");

  assert.equal(eolLabel("lf"), "LF");
  assert.equal(eolLabel("crlf"), "CRLF");
  assert.equal(eolLabel("mixed"), "混合");
  assert.equal(trashReasonLabel("delete"), "删除");
  assert.equal(trashReasonLabel("update"), "更新");
  assert.equal(trashReasonLabel("replace"), "替换");
});

test("局部更新：启停替换单行、删除摘掉单行", () => {
  const roots = [root("user-agents")];
  const before = makeSkill({ id: "user-agents:a", name: "a", modelVisible: true });
  const other = makeSkill({ id: "user-agents:b", name: "b" });
  const list = makeList(roots, [before, other]);

  const after = makeSkill({ id: "user-agents:a", name: "a", modelInvocationDisabled: true, modelVisible: false });
  const updated = replaceSkill(list, after);
  assert.equal(updated.skills.length, 2);
  assert.equal(updated.skills.find((skill) => skill.id === "user-agents:a")?.modelVisible, false);
  assert.equal(
    updated.skills.find((skill) => skill.id === "user-agents:b"),
    other,
  );

  const appended = replaceSkill(list, makeSkill({ id: "user-agents:c", name: "c" }));
  assert.equal(appended.skills.length, 3);

  const removed = removeSkill(list, "user-agents:a");
  assert.deepEqual(
    removed.skills.map((skill) => skill.id),
    ["user-agents:b"],
  );
});

test("文件清单：目录在前、按层级与名字排序、深度与文件名", () => {
  const files = [
    { path: "references/guide.md", size: 100, isDir: false },
    { path: "SKILL.md", size: 2048, isDir: false },
    { path: "assets", size: 0, isDir: true },
    { path: "assets/logo.png", size: 4096, isDir: false },
  ];
  assert.deepEqual(
    sortFiles(files).map((file) => file.path),
    ["assets", "SKILL.md", "assets/logo.png", "references/guide.md"],
  );
  assert.equal(fileDepth("SKILL.md"), 0);
  assert.equal(fileDepth("a/b/c.md"), 2);
  assert.equal(fileName("a/b/c.md"), "c.md");
  assert.equal(fileName("SKILL.md"), "SKILL.md");
});

test("回收站排序：时间倒序，坏时间排最后", () => {
  const items = [
    makeTrashItem({ trashId: "t1", deletedAt: "2026-10-01T00:00:00.000Z" }),
    makeTrashItem({ trashId: "t3", deletedAt: "2026-10-03T00:00:00.000Z" }),
    makeTrashItem({ trashId: "t2", deletedAt: "坏时间" }),
  ];
  assert.deepEqual(
    sortTrash(items).map((item) => item.trashId),
    ["t3", "t1", "t2"],
  );
});

test("错误映射：message / code / 逐字段 details / 冲突判定", () => {
  class FakeApiError extends Error {
    code: string;
    details: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
    }
  }
  const plain = new Error("普通错误");
  assert.equal(errorText(plain), "普通错误");
  assert.equal(errorCodeOf(plain), undefined);
  assert.deepEqual(fieldErrorsOf(plain), []);
  assert.equal(isConflict(plain), false);

  const validation = new FakeApiError("VALIDATION", "参数不合法", [
    { path: "id", message: "id 不能为空" },
    { field: "enabled", message: "enabled 必须是布尔值" },
    { path: "ignore" },
    "不是对象",
  ]);
  assert.equal(errorCodeOf(validation), "VALIDATION");
  assert.equal(errorText(validation), "参数不合法");
  assert.deepEqual(fieldErrorsOf(validation), [
    { path: "id", message: "id 不能为空" },
    { path: "enabled", message: "enabled 必须是布尔值" },
  ]);

  const conflict = new FakeApiError("CONFLICT", "原路径已存在同名的目录/文件");
  assert.equal(isConflict(conflict), true);
  assert.equal(isConflict(new Error("读取失败：原路径已存在同名的目录/文件")), false, "只认错误码，不猜文案");
});

test("技能目录的范围", () => {
  assert.equal(rootScope("project-dsh"), "project");
  assert.equal(rootScope("project-agents"), "project");
  assert.equal(rootScope("user-dsh"), "user");
  assert.equal(rootScope("user-agents"), "user");
  assert.equal(rootScope("custom-0"), "custom");
  assert.equal(rootScope("bundled"), "bundled");
});

test("排序：按显示名，没有 name 时用目录名", () => {
  const skills = [
    makeSkill({ id: "user-agents:zeta", name: "zeta", rootId: "user-agents" }),
    makeSkill({ id: "user-dsh:beta", name: "beta", rootId: "user-dsh" }),
    makeSkill({ id: "user-dsh:alpha", name: "alpha", rootId: "user-dsh" }),
    makeSkill({ id: "ghost-root:only", dirName: "only", rootId: "ghost-root" }),
  ];
  assert.deepEqual(
    sortSkills(skills).map((skill) => displayName(skill).text),
    ["alpha", "beta", "only", "zeta"],
  );
});

test("诊断级别的文案与色调", () => {
  assert.equal(levelTone("error"), "danger");
  assert.equal(levelTone("warning"), "warn");
  assert.equal(levelTone("info"), "neutral");
  assert.equal(levelLabel("error"), "错误");
  assert.equal(levelLabel("warning"), "警告");
  assert.equal(levelLabel("info"), "提示");
});
