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
  diagnosticCounts,
  displayName,
  homeDirFromRoots,
  isDshInstallPath,
  normalizePath,
  orderRoots,
  rootGroupTitle,
  eolLabel,
  errorCode,
  errorMessage,
  fieldErrors,
  fileDepth,
  fileName,
  filterCounts,
  filterLabel,
  FILTERS,
  formatBytes,
  formatDateTime,
  groupByRoot,
  hasProblems,
  invocationAccess,
  invocationLabel,
  invocationTitle,
  isConflict,
  isProjectRoot,
  levelLabel,
  levelTone,
  matches,
  matchesFilter,
  matchesQuery,
  needsAttention,
  relativeToWorkspace,
  removeSkill,
  replaceSkill,
  rootMetaPath,
  rootPathTitle,
  rootRank,
  rootScope,
  rootScopeLabel,
  sortFiles,
  sortSkills,
  sortTrash,
  toggleBlockReason,
  toggleLabel,
  trashReasonLabel,
  type FilterId,
  type MatchContext,
} from "../../src/client/skills/format.ts";
import { workspaceQuery } from "../../src/client/skills/data.ts";
import { makeList, makeSkill, makeTrashItem, diag, root } from "./fixtures.ts";

test("根的范围与标题（UI-DESIGN §4：标题只有范围，路径单独一行）", () => {
  assert.equal(rootScope("project-dsh"), "project");
  assert.equal(rootScope("project-agents"), "project");
  assert.equal(rootScope("user-dsh"), "user");
  assert.equal(rootScope("user-agents"), "user");
  assert.equal(rootScope("custom-0"), "custom");
  assert.equal(rootScope("bundled"), "bundled");
  assert.equal(rootScopeLabel("custom-2"), "自定义根");
  assert.equal(rootScopeLabel("bundled"), "内置技能");
  assert.equal(rootScopeLabel("user-agents"), "用户级");
  assert.equal(isProjectRoot("project-dsh"), true);
  assert.equal(isProjectRoot("user-agents"), false);
});

test("分组 meta：项目级显示工作区下的相对路径，其余显示绝对路径", () => {
  assert.equal(relativeToWorkspace("C:\\work\\demo", "C:\\work\\demo\\.agents\\skills"), ".agents/skills");
  assert.equal(relativeToWorkspace("C:\\work\\demo", "C:\\work\\Demo\\.dsh"), ".dsh", "Windows 盘符/目录大小写不敏感");
  assert.equal(relativeToWorkspace("C:\\work\\demo\\", "C:\\work\\demo"), ".");
  assert.equal(relativeToWorkspace("C:\\work\\demo", "C:\\other\\x"), undefined);
  assert.equal(relativeToWorkspace(undefined, "C:\\other\\x"), undefined);
  assert.equal(relativeToWorkspace("   ", "C:\\other\\x"), undefined);

  const project = root("project-agents", { path: "C:\\work\\demo\\.agents\\skills" });
  assert.equal(rootMetaPath(project, "C:\\work\\demo"), ".agents/skills");
  assert.equal(rootMetaPath(project, undefined), "C:\\work\\demo\\.agents\\skills");
  const user = root("user-agents", { path: "C:\\home\\.agents\\skills" });
  assert.equal(rootMetaPath(user, "C:\\work\\demo"), "C:\\home\\.agents\\skills");
});


/* ---------------- UI-C：路径缩写与分组顺序 ---------------- */

const HOME = "C:\\Users\\you";
const ASAR = "C:\\Users\\you\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-agent-preset\\skills";

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
  const both = [root("user-dsh", { path: HOME + "\\.dsh\\skills" }), root("user-agents", { path: HOME + "\\.agents\\skills" })];
  assert.equal(homeDirFromRoots(both), HOME);
  assert.equal(homeDirFromRoots([root("user-agents", { path: "C:/Users/you/.agents/skills" })]), "C:\\Users\\you", "正反斜杠混用也能反推");
  assert.equal(homeDirFromRoots([root("user-dsh", { path: HOME.toUpperCase() + "\\.dsh\\skills" })]), HOME.toUpperCase(), "盘符大小写不敏感");
  // 两条都给时取更短的那条（更靠近家目录）
  assert.equal(homeDirFromRoots([root("user-agents", { path: HOME + "\\.agents\\skills" }), root("user-dsh", { path: HOME + "\\.dsh\\skills" })]), HOME);
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
  assert.equal(abbreviateHomePath(ASAR, HOME), "~\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-agent-preset\\skills");
  assert.equal(abbreviateHomePath("C:\\other\\x", undefined), "C:\\other\\x", "推不出家目录时原样返回");
  assert.equal(abbreviateHomePath("", HOME), "");
});

test("分组标题：DSH 安装目录里的自定义根叫「DSH 内置」，其余照旧", () => {
  assert.equal(rootGroupTitle(root("custom-0", { path: ASAR })), "DSH 内置");
  assert.equal(rootGroupTitle(root("custom-1", { path: "D:\\my\\skills" })), "自定义根");
  assert.equal(rootGroupTitle(root("bundled", { path: ASAR })), "内置技能");
  assert.equal(rootGroupTitle(root("user-agents", { path: HOME + "\\.agents\\skills" })), "用户级");
});

test("分组 meta：家目录下缩写成 ~\\…，DSH 内置根不显示路径（完整路径走 title）", () => {
  const user = root("user-agents", { path: HOME + "\\.agents\\skills" });
  assert.equal(rootMetaPath(user, undefined, HOME), "~\\.agents\\skills");
  assert.equal(rootMetaPath(user, undefined), HOME + "\\.agents\\skills", "没有家目录时退回绝对路径");
  assert.equal(rootPathTitle(user), HOME + "\\.agents\\skills");
  const builtin = root("custom-0", { path: ASAR });
  assert.equal(rootMetaPath(builtin, undefined, HOME), undefined);
  assert.equal(rootPathTitle(builtin), ASAR, "完整路径仍然通过 title 提示给出去");
  const project = root("project-agents", { path: "C:\\work\\demo\\.agents\\skills" });
  assert.equal(rootMetaPath(project, "C:\\work\\demo", HOME), ".agents/skills");
});

test("分组顺序：项目级 → 用户级 → 只读根；同档保持接口给的顺序", () => {
  const roots = [
    root("custom-0", { path: ASAR, precedence: 300 }),
    root("user-dsh", { path: HOME + "\\.dsh\\skills", precedence: 400 }),
    root("user-agents", { path: HOME + "\\.agents\\skills", precedence: 500 }),
    root("bundled", { path: ASAR, precedence: 600 }),
    root("project-dsh", { path: "C:\\work\\demo\\.dsh\\skills", precedence: 100 }),
    root("project-agents", { path: "C:\\work\\demo\\.agents\\skills", precedence: 200 }),
  ];
  assert.deepEqual(orderRoots(roots).map((item) => item.rootId), [
    "project-dsh",
    "project-agents",
    "user-dsh",
    "user-agents",
    "custom-0",
    "bundled",
  ]);
  assert.equal(rootRank("project-dsh"), 0);
  assert.equal(rootRank("user-agents"), 1);
  assert.equal(rootRank("custom-0"), 2);
  assert.equal(rootRank("bundled"), 2);
  assert.equal(rootRank("ghost-root"), 2);
  // 不修改入参
  assert.equal(roots[0]!.rootId, "custom-0");
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

test("排序与分组：组内按名称、根顺序不变、未知根兜底", () => {
  const roots = [root("user-dsh", { precedence: 400 }), root("user-agents", { precedence: 500, exists: false })];
  const skills = [
    makeSkill({ id: "user-agents:zeta", name: "zeta", rootId: "user-agents" }),
    makeSkill({ id: "user-dsh:beta", name: "beta", rootId: "user-dsh" }),
    makeSkill({ id: "user-dsh:alpha", name: "alpha", rootId: "user-dsh" }),
    makeSkill({ id: "ghost-root:only", name: "only", rootId: "ghost-root" }),
  ];
  const sorted = sortSkills(skills).map((skill) => displayName(skill).text);
  assert.deepEqual(sorted, ["alpha", "beta", "only", "zeta"]);

  const groups = groupByRoot(roots, skills);
  assert.deepEqual(groups.map((group) => group.root.rootId), ["user-dsh", "user-agents", "ghost-root"]);
  assert.deepEqual(groups[0]!.skills.map((skill) => skill.name), ["alpha", "beta"]);
  assert.equal(groups[1]!.missing, true);
  assert.equal(groups[2]!.missing, false);
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

test("四段筛选（UI-DESIGN §4）：全部 / 已启用 / 已停用 / 需关注", () => {
  const visible = makeSkill({ id: "a:visible", name: "visible" });
  const disabled = makeSkill({ id: "a:disabled", name: "disabled", modelInvocationDisabled: true, modelVisible: false });
  const broken = makeSkill({ id: "a:broken", name: "broken", loadable: false, modelVisible: false });
  const shadowed = makeSkill({ id: "a:shadowed", name: "shadowed", modelVisible: false, shadowedBy: "b:shadowed" });
  const updatable = makeSkill({ id: "a:updatable", name: "updatable" });
  const context: MatchContext = { updatable: new Set<string>(["a:updatable"]) };

  const all = [visible, disabled, broken, shadowed, updatable];
  const ids = (filter: FilterId): string[] => all.filter((skill) => matchesFilter(skill, filter, context)).map((skill) => skill.id);

  assert.deepEqual(FILTERS, ["all", "enabled", "disabled", "attention"]);
  assert.equal(filterLabel("enabled"), "已启用");
  assert.equal(filterLabel("attention"), "需关注");
  assert.deepEqual(ids("all"), ["a:visible", "a:disabled", "a:broken", "a:shadowed", "a:updatable"]);
  assert.deepEqual(ids("enabled"), ["a:visible", "a:broken", "a:shadowed", "a:updatable"]);
  assert.deepEqual(ids("disabled"), ["a:disabled"]);
  // 需关注 = 不可加载 + 被遮蔽 + 可更新
  assert.deepEqual(ids("attention"), ["a:broken", "a:shadowed", "a:updatable"]);
  assert.equal(needsAttention(visible, context), false);
  assert.equal(needsAttention(visible), false, "没有 context 时看不到「可更新」，其余两条仍然生效");
  assert.equal(needsAttention(broken), true);
  assert.equal(needsAttention(shadowed), true);
  assert.equal(matches(updatable, "upd", "attention", context), true);
  assert.equal(matches(updatable, "upd", "disabled", context), false);
});

test("分段计数", () => {
  const skills = [
    makeSkill({ id: "a:1", name: "1" }),
    makeSkill({ id: "a:2", name: "2", modelInvocationDisabled: true, modelVisible: false }),
    makeSkill({ id: "a:3", name: "3", loadable: false, modelVisible: false }),
  ];
  assert.deepEqual(filterCounts(skills), { all: 3, enabled: 2, disabled: 1, attention: 1 });
  assert.deepEqual(filterCounts(skills, { updatable: new Set<string>(["a:1"]) }), { all: 3, enabled: 2, disabled: 1, attention: 2 });
});

test("诊断计数、级别文案与色调", () => {
  const skill = makeSkill({
    id: "a:x",
    diagnostics: [diag("error", "BOM_PRESENT"), diag("warning", "MIXED_EOL"), diag("info", "EXTRA_KEY"), diag("info", "YAML_L1_FEATURE")],
  });
  assert.deepEqual(diagnosticCounts(skill), { error: 1, warning: 1, info: 2, total: 4 });
  assert.equal(hasProblems(skill), true, "error/warning 算有问题");
  assert.equal(hasProblems(makeSkill({ id: "a:info", diagnostics: [diag("info", "EXTRA_KEY")] })), false);
  assert.equal(levelTone("error"), "danger");
  assert.equal(levelTone("warning"), "warn");
  assert.equal(levelTone("info"), "neutral");
  assert.equal(levelLabel("error"), "错误");
  assert.equal(levelLabel("warning"), "警告");
  assert.equal(levelLabel("info"), "提示");
});

test("启停禁用原因与无障碍名（D-B3）", () => {
  assert.equal(toggleBlockReason(makeSkill({ id: "a:ok" })), undefined);

  const readonly = makeSkill({ id: "custom-0:ro", rootId: "custom-0", writable: false });
  assert.equal(toggleBlockReason(readonly), "只读根，不能启停");

  const unsafe = makeSkill({
    id: "user-agents:bom",
    format: { eol: "lf", bom: true, safeToToggle: false },
    diagnostics: [diag("error", "BOM_PRESENT", "文件以 UTF-8 BOM 开头。")],
  });
  assert.equal(toggleBlockReason(unsafe), "文件格式不支持安全改写（只能手工改）：文件以 UTF-8 BOM 开头。");

  const unsafeNoDiag = makeSkill({ id: "user-agents:x", format: { eol: "mixed", bom: false, safeToToggle: false } });
  assert.equal(toggleBlockReason(unsafeNoDiag), "文件格式不支持安全改写（只能手工改）");

  assert.equal(toggleLabel(makeSkill({ id: "a:on", name: "on" })), "停用「on」");
  assert.equal(toggleLabel(makeSkill({ id: "a:off", name: "off", modelInvocationDisabled: true })), "启用「off」");
  assert.equal(toggleLabel(makeSkill({ id: "a:noname", dirName: "dir-only" })), "停用「dir-only」");
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
  assert.equal(updated.skills.find((skill) => skill.id === "user-agents:b"), other);

  const appended = replaceSkill(list, makeSkill({ id: "user-agents:c", name: "c" }));
  assert.equal(appended.skills.length, 3);

  const removed = removeSkill(list, "user-agents:a");
  assert.deepEqual(removed.skills.map((skill) => skill.id), ["user-agents:b"]);
});

test("文件清单：目录在前、按层级与名字排序、深度与文件名", () => {
  const files = [
    { path: "references/guide.md", size: 100, isDir: false },
    { path: "SKILL.md", size: 2048, isDir: false },
    { path: "assets", size: 0, isDir: true },
    { path: "assets/logo.png", size: 4096, isDir: false },
  ];
  assert.deepEqual(sortFiles(files).map((file) => file.path), [
    "assets",
    "SKILL.md",
    "assets/logo.png",
    "references/guide.md",
  ]);
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
  assert.deepEqual(sortTrash(items).map((item) => item.trashId), ["t3", "t1", "t2"]);
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
  assert.equal(errorMessage(plain), "普通错误");
  assert.equal(errorCode(plain), undefined);
  assert.deepEqual(fieldErrors(plain), []);
  assert.equal(isConflict(plain), false);

  const validation = new FakeApiError("VALIDATION", "参数不合法", [
    { path: "id", message: "id 不能为空" },
    { field: "enabled", message: "enabled 必须是布尔值" },
    { path: "ignore" },
    "不是对象",
  ]);
  assert.equal(errorCode(validation), "VALIDATION");
  assert.equal(errorMessage(validation), "参数不合法");
  assert.deepEqual(fieldErrors(validation), [
    { field: "id", message: "id 不能为空" },
    { field: "enabled", message: "enabled 必须是布尔值" },
  ]);

  const conflict = new FakeApiError("CONFLICT", "原路径已存在同名的目录/文件");
  assert.equal(isConflict(conflict), true);
  assert.equal(isConflict(new Error("读取失败：原路径已存在同名的目录/文件")), true, "没有 code 时按文案兜底");
});

test("调用权限（D-B17）：与 DSH 口径一致，四种组合各有一段文字，悬停说明来源", () => {
  const both = invocationAccess(makeSkill({ id: "a:x" }));
  assert.deepEqual(both, { model: true, user: true, userExplicit: false });
  assert.equal(invocationLabel(both), "模型、用户");
  assert.match(invocationTitle(both), /模型调用：允许/);
  assert.match(invocationTitle(both), /用户调用：允许（未设置 user-invocable，默认允许）/);

  const modelOnly = invocationAccess(makeSkill({ id: "a:x", userInvocable: false }));
  assert.equal(invocationLabel(modelOnly), "仅模型");
  assert.match(invocationTitle(modelOnly), /用户调用：禁止（user-invocable: false）/);

  const userOnly = invocationAccess(makeSkill({ id: "a:x", modelInvocationDisabled: true, userInvocable: true }));
  assert.deepEqual(userOnly, { model: false, user: true, userExplicit: true });
  assert.equal(invocationLabel(userOnly), "仅用户");
  assert.match(invocationTitle(userOnly), /模型调用：禁止（disable-model-invocation: true/);
  assert.match(invocationTitle(userOnly), /用户调用：允许（user-invocable: true）/);

  const none = invocationAccess(makeSkill({ id: "a:x", modelInvocationDisabled: true, userInvocable: false }));
  assert.equal(invocationLabel(none), "不可调用");
});
