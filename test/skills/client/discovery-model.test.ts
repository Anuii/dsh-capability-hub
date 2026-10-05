/**
 * 仓库视图（D-B16）的纯逻辑：汇总筛选与计数、跨仓库安装计划、相对时间、首次自动扫描、增量渲染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DISCOVERY_PAGE,
  LARGE_REPO,
  discoveredKey,
  discoveryFilterKey,
  groupDiscovered,
  initialRepoFold,
  inputIntent,
  normalizeRepoInput,
  repoExpanded,
  toggleRepoFold,
  filterDiscovered,
  installPlan,
  installedCounts,
  relativeTime,
  repoConfigText,
  repoScanText,
  shouldAutoScan,
  sliceVisible,
} from "../../../src/skills/client/remote/discovery-model.ts";
import { normalizeDiscovery } from "../../../src/skills/client/remote/data.ts";
import type { DiscoveredSkill } from "../../../src/skills/contract/remote.ts";

const SKILLS: DiscoveredSkill[] = [
  {
    repo: "mattpocock/skills",
    ref: "main",
    skillPath: "skills/tdd/SKILL.md",
    dirName: "tdd",
    name: "tdd",
    description: "测试驱动开发",
    installedId: "user-agents:tdd",
  },
  {
    repo: "mattpocock/skills",
    ref: "main",
    skillPath: "skills/grill/SKILL.md",
    dirName: "grill",
    name: "grill",
    description: "拷问计划",
  },
  {
    repo: "anthropics/skills",
    ref: "main",
    skillPath: "skills/pdf/SKILL.md",
    dirName: "pdf",
    name: "pdf",
    description: "PDF 工具",
  },
  { repo: "anthropics/skills", ref: "main", skillPath: "SKILL.md", dirName: "skills", description: "根级技能" },
];

test("筛选：搜索名称/描述/仓库，已安装/未安装，仓库（大小写不敏感）；未安装排前", () => {
  const all = filterDiscovered(SKILLS, { query: "", installed: "all", repo: "" });
  assert.equal(all.length, 4);
  assert.equal(all[all.length - 1]!.installedId, "user-agents:tdd", "已安装的排在最后");
  assert.deepEqual(
    filterDiscovered(SKILLS, { query: "拷问", installed: "all", repo: "" }).map((s) => s.dirName),
    ["grill"],
  );
  assert.deepEqual(filterDiscovered(SKILLS, { query: "ANTHROPICS", installed: "all", repo: "" }).length, 2);
  assert.deepEqual(
    filterDiscovered(SKILLS, { query: "", installed: "yes", repo: "" }).map((s) => s.dirName),
    ["tdd"],
  );
  assert.deepEqual(
    filterDiscovered(SKILLS, { query: "", installed: "not", repo: "MattPocock/skills" }).map((s) => s.dirName),
    ["grill"],
  );
});

test("分段计数受搜索与仓库影响、不受已安装筛选影响", () => {
  assert.deepEqual(installedCounts(SKILLS, "", ""), { all: 4, not: 3, yes: 1 });
  assert.deepEqual(installedCounts(SKILLS, "", "mattpocock/skills"), { all: 2, not: 1, yes: 1 });
  assert.deepEqual(installedCounts(SKILLS, "pdf", ""), { all: 1, not: 1, yes: 0 });
});

test("安装计划：按仓库 + 分支分组、去重、仓库名排序", () => {
  const plan = installPlan([
    { repo: "mattpocock/skills", ref: "main", skillPath: "skills/grill/SKILL.md" },
    { repo: "anthropics/skills", ref: "main", skillPath: "skills/pdf/SKILL.md" },
    { repo: "anthropics/skills", ref: "main", skillPath: "SKILL.md" },
    { repo: "anthropics/skills", ref: "main", skillPath: "SKILL.md" },
    { repo: "Anthropics/skills", ref: "dev", skillPath: "skills/x/SKILL.md" },
  ]);
  assert.deepEqual(plan, [
    { repo: "anthropics/skills", ref: "main", skillPaths: ["skills/pdf/SKILL.md", "SKILL.md"] },
    { repo: "Anthropics/skills", ref: "dev", skillPaths: ["skills/x/SKILL.md"] },
    { repo: "mattpocock/skills", ref: "main", skillPaths: ["skills/grill/SKILL.md"] },
  ]);
  assert.equal(
    discoveredKey({ repo: "A/B", skillPath: "x/SKILL.md" }),
    discoveredKey({ repo: "a/b", skillPath: "x/SKILL.md" }),
  );
});

test("相对时间", () => {
  const now = Date.parse("2026-10-05T12:00:00.000Z");
  assert.equal(relativeTime(undefined, now), "从未");
  assert.equal(relativeTime("not a date", now), "从未");
  assert.equal(relativeTime("2026-10-05T11:59:30.000Z", now), "刚刚");
  assert.equal(relativeTime("2026-10-05T11:55:00.000Z", now), "5 分钟前");
  assert.equal(relativeTime("2026-10-05T09:00:00.000Z", now), "3 小时前");
  assert.equal(relativeTime("2026-10-03T12:00:00.000Z", now), "2 天前");
});

test("首次自动扫描：从没扫过且仓库列表非空才扫", () => {
  assert.equal(shouldAutoScan(undefined), false);
  assert.equal(shouldAutoScan({ cached: false, repos: [{ repo: "a/b", preset: true }], skills: [] }), true);
  assert.equal(shouldAutoScan({ cached: false, repos: [], skills: [] }), false);
  assert.equal(
    shouldAutoScan({ cached: true, repos: [{ repo: "a/b", preset: true, scannedAt: "x" }], skills: [] }),
    false,
  );
});

test("仓库行文字：分支 · 子目录 与 扫描状态", () => {
  assert.equal(repoConfigText({}), "默认分支 · 整个仓库");
  assert.equal(repoConfigText({ ref: "dev", subPath: "skills" }), "dev · skills");
  assert.equal(repoScanText({ repo: "a/b", preset: false }), "未扫描");
  assert.equal(repoScanText({ repo: "a/b", preset: false, scannedAt: "x", error: "404" }), "扫描失败");
  assert.equal(repoScanText({ repo: "a/b", preset: false, scannedAt: "x", skillCount: 12 }), "12 个技能");
});

test("增量渲染：每批 200 行", () => {
  const items = Array.from({ length: 450 }, (_, index) => index);
  assert.equal(DISCOVERY_PAGE, 200);
  assert.deepEqual(sliceVisible(items, DISCOVERY_PAGE).rest, 250);
  assert.equal(sliceVisible(items, 400).visible.length, 400);
  assert.equal(sliceVisible(items, 600).rest, 0);
});

test("接口返回补成安全形状", () => {
  assert.deepEqual(normalizeDiscovery(undefined), { cached: false, repos: [], skills: [] });
  const view = normalizeDiscovery({
    cached: true,
    lastScannedAt: "t",
    repos: [{ repo: "a/b", preset: true }, null as never],
    skills: [{ repo: "a/b", skillPath: "x/SKILL.md", dirName: "x" }, { bad: 1 } as never],
  });
  assert.equal(view.repos.length, 1);
  assert.equal(view.skills.length, 1);
  assert.equal(view.lastScannedAt, "t");
});

test("合一的输入框：像仓库地址就浏览 / 加入，否则搜索 skills.sh", () => {
  assert.equal(inputIntent("   "), "empty");
  assert.equal(inputIntent("mattpocock/skills"), "repo");
  assert.equal(inputIntent("https://github.com/a/b/tree/main/skills"), "repo");
  assert.equal(inputIntent("github.com/a/b"), "repo");
  assert.equal(inputIntent("pdf"), "search");
  assert.equal(inputIntent("pdf tools"), "search");
  assert.equal(inputIntent("a/b/c"), "search", "三段不是仓库");
  assert.equal(normalizeRepoInput(" github.com/a/b "), "https://github.com/a/b");
  assert.equal(normalizeRepoInput("a/b"), "a/b");
});

test("汇总按仓库分组：顺序跟仓库列表，总数不受筛选影响，空组不出现", () => {
  const groups = groupDiscovered(SKILLS, filterDiscovered(SKILLS, { query: "", installed: "not", repo: "" }), [
    "mattpocock/skills",
    "anthropics/skills",
  ]);
  assert.deepEqual(
    groups.map((g) => [g.repo, g.total, g.skills.length]),
    [
      ["mattpocock/skills", 2, 1],
      ["anthropics/skills", 2, 2],
    ],
  );
  const onlyPdf = groupDiscovered(SKILLS, filterDiscovered(SKILLS, { query: "pdf", installed: "all", repo: "" }), [
    "mattpocock/skills",
    "anthropics/skills",
  ]);
  assert.deepEqual(
    onlyPdf.map((g) => g.repo),
    ["anthropics/skills"],
  );
  const unknown = groupDiscovered(
    [{ repo: "z/z", skillPath: "SKILL.md", dirName: "z" }],
    [{ repo: "z/z", skillPath: "SKILL.md", dirName: "z" }],
    [],
  );
  assert.equal(unknown[0]!.repo, "z/z", "不在仓库列表里的仓库排在后面");
});

test("仓库分组折叠：大仓库默认折叠；筛选中先全部展开、可手动折叠；清空后回到原来的状态", () => {
  const big = { repo: "ComposioHQ/awesome-claude-skills", total: LARGE_REPO + 1 };
  const small = { repo: "mattpocock/skills", total: 37 };
  let fold = initialRepoFold();
  const none = discoveryFilterKey({ query: "", installed: "all", repo: "" });
  assert.equal(none, "");
  assert.equal(repoExpanded(fold, none, big), false, "超过 50 个默认折叠");
  assert.equal(repoExpanded(fold, none, small), true);
  fold = toggleRepoFold(fold, none, big);
  assert.equal(repoExpanded(fold, none, big), true, "用户展开后记住");
  fold = toggleRepoFold(fold, none, small);
  const searching = discoveryFilterKey({ query: "pdf", installed: "all", repo: "" });
  assert.equal(repoExpanded(fold, searching, small), true, "筛选中先全部展开");
  fold = toggleRepoFold(fold, searching, small);
  assert.equal(repoExpanded(fold, searching, small), false, "筛选中可以折叠");
  assert.equal(
    repoExpanded(fold, discoveryFilterKey({ query: "", installed: "not", repo: "" }), small),
    true,
    "换一种筛选又展开",
  );
  assert.equal(repoExpanded(fold, none, small), false, "清空后回到不筛选时的折叠");
  assert.equal(repoExpanded(fold, none, big), true);
});
