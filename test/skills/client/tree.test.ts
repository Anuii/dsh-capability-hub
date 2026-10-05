/**
 * 技能列表两级折叠（D-B14 / D-B15）：层级归类、来源仓库分组、目录标签与筛选、折叠判定。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSkillTree,
  dirOptions,
  dirTagText,
  filterKeyOf,
  initialFoldState,
  isFiltering,
  isFoldExpanded,
  levelKey,
  levelOfRoot,
  repoKey,
  toggleFold,
} from "../../../src/skills/client/tree.ts";
import type { SourceEntry } from "../../../src/skills/client/remote/types.ts";
import { makeList, makeSkill, root } from "./fixtures.ts";

const ASAR = "C:\\Program Files\\DSH\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-agent-preset\\skills";

const ROOTS = [
  root("project-dsh", { path: "D:\\work\\demo\\.dsh\\skills" }),
  root("project-agents", { path: "D:\\work\\demo\\.agents\\skills", exists: false }),
  root("custom-0", { path: "E:\\team-skills", writable: false }),
  root("user-dsh", { path: "C:\\Users\\me\\.dsh\\skills" }),
  root("user-agents", { path: "C:\\Users\\me\\.agents\\skills" }),
  root("custom-1", { path: ASAR, writable: false }),
];

function source(skillId: string, repo: string, skillPath = "skills/x/SKILL.md"): SourceEntry {
  return { skillId, repo, skillPath, store: "skill-lock" };
}

const SKILLS = [
  makeSkill({ id: "user-agents:tdd", name: "tdd", rootId: "user-agents" }),
  makeSkill({ id: "user-agents:grill", name: "grill", rootId: "user-agents" }),
  makeSkill({ id: "user-agents:mine", name: "mine", rootId: "user-agents" }),
  makeSkill({ id: "user-dsh:notes.md", dirName: "notes.md", name: "notes", rootId: "user-dsh" }),
  makeSkill({ id: "custom-0:team", name: "team", rootId: "custom-0", writable: false }),
  makeSkill({ id: "custom-1:builtin-a", name: "builtin-a", rootId: "custom-1", writable: false }),
  makeSkill({ id: "project-dsh:local", name: "local", rootId: "project-dsh", modelInvocationDisabled: true, modelVisible: false }),
];

const SOURCES: Record<string, SourceEntry> = {
  "user-agents:tdd": source("user-agents:tdd", "mattpocock/skills"),
  "user-agents:grill": source("user-agents:grill", "anthropics/skills"),
  "custom-1:builtin-a": source("custom-1:builtin-a", "deepseek/preset"),
};

const LIST = makeList(ROOTS, SKILLS);

test("层级归类：自定义目录归用户级，app.asar 里的自定义目录与 bundled 是 DSH 内置", () => {
  assert.equal(levelOfRoot(ROOTS[0]!), "project");
  assert.equal(levelOfRoot(ROOTS[2]!), "user");
  assert.equal(levelOfRoot(ROOTS[3]!), "user");
  assert.equal(levelOfRoot(ROOTS[5]!), "builtin");
  assert.equal(levelOfRoot({ rootId: "bundled", path: "X:\\anything" }), "builtin");
});

test("目录标签：skills 前一段；没有 skills 段取最后一段；盘符不当标签", () => {
  assert.equal(dirTagText("C:\\Users\\me\\.agents\\skills"), ".agents");
  assert.equal(dirTagText("D:/work/demo/.dsh/skills/"), ".dsh");
  assert.equal(dirTagText("E:\\team-skills"), "team-skills");
  assert.equal(dirTagText(ASAR), "dsh-agent-preset");
  assert.equal(dirTagText("E:\\skills"), "skills");
});

test("目录筛选选项：按层级分段、含空目录、带技能数；不存在且没有技能的目录不列", () => {
  const options = dirOptions(LIST);
  assert.deepEqual(options.map((o) => [o.level, o.tag, o.count]), [
    ["builtin", "dsh-agent-preset", 1],
    ["user", ".agents", 3],
    ["user", ".dsh", 1],
    ["user", "team-skills", 1],
    ["project", ".dsh", 1],
  ]);
  assert.equal(options.find((o) => o.rootId === "user-agents")!.title, "C:\\Users\\me\\.agents\\skills");
});

test("默认视图：三个层级按 DSH 内置 / 用户级 / 项目级排列，DSH 内置不细分", () => {
  const tree = buildSkillTree({ list: LIST, query: "", filter: "all", sources: SOURCES, hasWorkspace: true });
  assert.equal(tree.filtering, false);
  assert.deepEqual(tree.levels.map((l) => l.level), ["builtin", "user", "project"]);
  const builtin = tree.levels[0]!;
  assert.equal(builtin.flat, true, "DSH 内置不按来源细分");
  assert.deepEqual(builtin.skills.map((s) => s.id), ["custom-1:builtin-a"]);
  const user = tree.levels[1]!;
  assert.equal(user.total, 5);
  assert.equal(user.flat, false);
  assert.deepEqual(user.repos.map((r) => r.label), ["anthropics/skills", "mattpocock/skills", "无来源"], "按仓库名排序，无来源最后");
  assert.deepEqual(user.repos[2]!.skills.map((s) => s.id).sort(), ["custom-0:team", "user-agents:mine", "user-dsh:notes.md"], "平铺技能与自定义目录的技能都归无来源");
  assert.equal(user.repos[0]!.key, repoKey("user", "anthropics/skills"));
  assert.equal(user.repos[2]!.key, repoKey("user", undefined));
});

test("某层级全是无来源：不显示孤零零的「无来源」二级头", () => {
  const tree = buildSkillTree({ list: LIST, query: "", filter: "all", sources: SOURCES, hasWorkspace: true });
  const project = tree.levels.find((l) => l.level === "project")!;
  assert.equal(project.flat, true);
  assert.deepEqual(project.skills.map((s) => s.id), ["project-dsh:local"]);
});

test("来源数据不可用：层级内直接列技能，不报错", () => {
  const tree = buildSkillTree({ list: LIST, query: "", filter: "all", hasWorkspace: true });
  assert.ok(tree.levels.every((l) => l.flat));
  assert.equal(tree.levels.find((l) => l.level === "user")!.skills.length, 5);
});

test("没有工作区：项目级只给一行说明；没有 DSH 内置技能时不出现该层级", () => {
  const list = makeList(ROOTS.filter((r) => !r.rootId.startsWith("project") && r.rootId !== "custom-1"),
    SKILLS.filter((s) => !s.rootId.startsWith("project") && s.rootId !== "custom-1"));
  const tree = buildSkillTree({ list, query: "", filter: "all", sources: SOURCES, hasWorkspace: false });
  assert.deepEqual(tree.levels.map((l) => l.level), ["user", "project"]);
  const project = tree.levels[1]!;
  assert.equal(project.noWorkspace, true);
  assert.equal(project.total, 0);
});

test("搜索 / 筛选 / 目录筛选：只留有匹配的层级与仓库，计数按匹配数", () => {
  const searched = buildSkillTree({ list: LIST, query: "tdd", filter: "all", sources: SOURCES, hasWorkspace: true });
  assert.equal(searched.filtering, true);
  assert.deepEqual(searched.levels.map((l) => l.level), ["user"]);
  assert.deepEqual(searched.levels[0]!.repos.map((r) => r.label), ["mattpocock/skills"]);
  assert.equal(searched.levels[0]!.shown, 1);
  assert.equal(searched.levels[0]!.total, 5);

  const builtinHit = buildSkillTree({ list: LIST, query: "builtin", filter: "all", sources: SOURCES, hasWorkspace: true });
  assert.deepEqual(builtinHit.levels.map((l) => l.level), ["builtin"], "默认折叠的 DSH 内置在有匹配时也会出现");

  const disabled = buildSkillTree({ list: LIST, query: "", filter: "disabled", sources: SOURCES, hasWorkspace: true });
  assert.deepEqual(disabled.levels.map((l) => l.level), ["project"]);

  const byDir = buildSkillTree({ list: LIST, query: "", filter: "all", dir: "user-dsh", sources: SOURCES, hasWorkspace: true });
  assert.equal(byDir.filtering, true);
  assert.equal(byDir.shown, 1);
  assert.deepEqual(byDir.levels.map((l) => l.level), ["user"]);

  const none = buildSkillTree({ list: LIST, query: "不存在的词", filter: "all", sources: SOURCES, hasWorkspace: true });
  assert.equal(none.shown, 0);
  assert.deepEqual(none.levels, []);
});
test("折叠：DSH 内置默认折叠；筛选时有匹配的分组先展开、仍可手动折叠；清空后回到原来的状态", () => {
  const none = filterKeyOf("", "all", "");
  assert.equal(none, "");
  let state = initialFoldState();
  assert.equal(isFoldExpanded(state, none, levelKey("builtin")), false, "DSH 内置默认折叠");
  assert.equal(isFoldExpanded(state, none, levelKey("user")), true);
  state = toggleFold(state, none, levelKey("user"));
  assert.equal(isFoldExpanded(state, none, levelKey("user")), false, "不筛选时用户折叠了用户级");

  const enabled = filterKeyOf("", "enabled", "");
  assert.notEqual(enabled, "");
  assert.equal(isFoldExpanded(state, enabled, levelKey("user")), true, "进入筛选：全部展开");
  assert.equal(isFoldExpanded(state, enabled, levelKey("builtin")), true);
  state = toggleFold(state, enabled, levelKey("user"));
  assert.equal(isFoldExpanded(state, enabled, levelKey("user")), false, "筛选中可以折叠（本次反馈的缺陷）");
  state = toggleFold(state, enabled, repoKey("user", "mattpocock/skills"));
  assert.equal(isFoldExpanded(state, enabled, repoKey("user", "mattpocock/skills")), false, "二级分组同样可以折叠");

  const disabled = filterKeyOf("", "disabled", "");
  assert.equal(isFoldExpanded(state, disabled, levelKey("user")), true, "换一种筛选：重新全部展开");
  assert.equal(isFoldExpanded(state, none, levelKey("user")), false, "清空筛选：回到不筛选时的折叠");
  assert.equal(isFoldExpanded(state, none, levelKey("builtin")), false);

  const before = state;
  toggleFold(before, none, levelKey("builtin"));
  assert.equal(isFoldExpanded(before, none, levelKey("builtin")), false, "toggle 不修改原状态");
  assert.equal(filterKeyOf(" Grill ", "all", ""), filterKeyOf("grill", "all", ""), "搜索词大小写与首尾空格不算新筛选");
  assert.equal(isFiltering("  ", "all", ""), false);
  assert.equal(isFiltering("", "all", "user-dsh"), true);
});

test("目录标签只在层级里有不止一个技能目录时显示", () => {
  const tree = buildSkillTree({ list: LIST, query: "", filter: "all", sources: SOURCES, hasWorkspace: true });
  assert.equal(tree.levels.find((l) => l.level === "user")!.multiDir, true, "用户级有 .agents、.dsh、team-skills");
  assert.equal(tree.levels.find((l) => l.level === "builtin")!.multiDir, false);
  assert.equal(tree.levels.find((l) => l.level === "project")!.multiDir, false);
  const onlyAgents = makeList(ROOTS, SKILLS.filter((s) => s.rootId === "user-agents"));
  assert.equal(buildSkillTree({ list: onlyAgents, query: "", filter: "all", hasWorkspace: true }).levels.find((l) => l.level === "user")!.multiDir, false);
});
