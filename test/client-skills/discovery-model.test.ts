/**
 * 仓库视图（D-B16）的纯逻辑：汇总筛选与计数、跨仓库安装计划、相对时间、首次自动扫描、增量渲染。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DISCOVERY_PAGE,
  discoveredKey,
  filterDiscovered,
  installPlan,
  installedCounts,
  relativeTime,
  repoConfigText,
  repoScanText,
  shouldAutoScan,
  sliceVisible,
} from "../../src/client/skills/remote/discovery-model.ts";
import { normalizeDiscovery } from "../../src/client/skills/remote/data.ts";
import type { DiscoveredSkill } from "../../src/client/skills/remote/types.ts";

const SKILLS: DiscoveredSkill[] = [
  { repo: "mattpocock/skills", ref: "main", skillPath: "skills/tdd/SKILL.md", dirName: "tdd", name: "tdd", description: "测试驱动开发", installedId: "user-agents:tdd" },
  { repo: "mattpocock/skills", ref: "main", skillPath: "skills/grill/SKILL.md", dirName: "grill", name: "grill", description: "拷问计划" },
  { repo: "anthropics/skills", ref: "main", skillPath: "skills/pdf/SKILL.md", dirName: "pdf", name: "pdf", description: "PDF 工具" },
  { repo: "anthropics/skills", ref: "main", skillPath: "SKILL.md", dirName: "skills", description: "根级技能" },
];

test("筛选：搜索名称/描述/仓库，已安装/未安装，仓库（大小写不敏感）；未安装排前", () => {
  const all = filterDiscovered(SKILLS, { query: "", installed: "all", repo: "" });
  assert.equal(all.length, 4);
  assert.equal(all[all.length - 1]!.installedId, "user-agents:tdd", "已安装的排在最后");
  assert.deepEqual(filterDiscovered(SKILLS, { query: "拷问", installed: "all", repo: "" }).map((s) => s.dirName), ["grill"]);
  assert.deepEqual(filterDiscovered(SKILLS, { query: "ANTHROPICS", installed: "all", repo: "" }).length, 2);
  assert.deepEqual(filterDiscovered(SKILLS, { query: "", installed: "yes", repo: "" }).map((s) => s.dirName), ["tdd"]);
  assert.deepEqual(filterDiscovered(SKILLS, { query: "", installed: "not", repo: "MattPocock/skills" }).map((s) => s.dirName), ["grill"]);
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
  assert.equal(discoveredKey({ repo: "A/B", skillPath: "x/SKILL.md" }), discoveredKey({ repo: "a/b", skillPath: "x/SKILL.md" }));
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
  assert.equal(shouldAutoScan({ cached: true, repos: [{ repo: "a/b", preset: true, scannedAt: "x" }], skills: [] }), false);
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
  const view = normalizeDiscovery({ cached: true, lastScannedAt: "t", repos: [{ repo: "a/b", preset: true }, null as never], skills: [{ repo: "a/b", skillPath: "x/SKILL.md", dirName: "x" }, { bad: 1 } as never] });
  assert.equal(view.repos.length, 1);
  assert.equal(view.skills.length, 1);
  assert.equal(view.lastScannedAt, "t");
});
