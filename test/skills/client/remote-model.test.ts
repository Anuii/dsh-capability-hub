/**
 * 远程部分纯逻辑单测：来源展示、更新状态、安装目标、候选分组、结果汇总。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  authModeLabel,
  applySummaryText,
  candidateKey,
  checkSummaryText,
  confidenceBadgeTone,
  confidenceLabel,
  flatUnsupportedText,
  groupCandidates,
  installResultText,
  installSummaryText,
  installTargetOptions,
  isFlatSkill,
  quotaValue,
  skillsNeedingSource,
  sourceRepoRef,
  sourceTitle,
  storeLabel,
  summarizeApplies,
  summarizeChecks,
  targetLabel,
  updateStatusBadgeTone,
  updateStatusLabel,
  updateStatusTitle,
  updatableIds,
} from "../../../src/skills/client/remote/model.ts";
import { t } from "../../../src/skills/client/strings.ts";
import { makeSkill, root } from "./fixtures.ts";
import type { DiscoverCandidate, SourceEntry } from "../../../src/skills/contract/remote.ts";

const entry: SourceEntry = {
  skillId: "user-agents:grilling",
  repo: "mattpocock/skills",
  ref: "main",
  skillPath: "skills/productivity/grilling/SKILL.md",
  store: "skill-lock",
  installedAt: "2026-09-22T01:17:31.905Z",
  updatedAt: "2026-09-22T01:17:31.905Z",
  skillFolderHash: "4fa026e5979770347b3357ff5139e1e41d21c3a9f7335e9cd2811cb5b8d32f2f",
};

test("来源展示：repo@ref、记录位置、标题带明细", () => {
  assert.equal(sourceRepoRef(entry), "mattpocock/skills@main");
  assert.equal(sourceRepoRef({ repo: "a/b" }), "a/b");
  assert.equal(storeLabel("skill-lock"), t("skills.remote.source.storeLock"));
  assert.equal(storeLabel("hub"), t("skills.remote.source.storeHub"));
  const title = sourceTitle(entry);
  assert.ok(title.includes("mattpocock/skills@main"));
  assert.ok(title.includes("skills/productivity/grilling/SKILL.md"));
  assert.ok(title.includes(".skill-lock.json"));
  assert.ok(title.includes("2026-09-22T01:17:31.905Z"));
});

test("更新状态：文案、色板与悬停说明", () => {
  assert.equal(updateStatusLabel("up-to-date"), t("skills.remote.update.status.upToDate"));
  assert.equal(updateStatusLabel("update-available"), t("skills.remote.update.status.available"));
  assert.equal(updateStatusLabel("no-source"), t("skills.remote.update.status.noSource"));
  assert.equal(updateStatusLabel("error"), t("skills.remote.update.status.error"));
  assert.equal(updateStatusLabel(undefined), t("skills.remote.update.status.unknown"));
  // UI-A：行/详情上的标记走 kit 的 Badge tone（强调色只给「可更新」，红只给「出错」）
  assert.equal(updateStatusBadgeTone("update-available"), "accent");
  assert.equal(updateStatusBadgeTone("error"), "danger");
  assert.equal(updateStatusBadgeTone("up-to-date"), "neutral");
  assert.equal(updateStatusBadgeTone("no-source"), "neutral");
  assert.equal(updateStatusBadgeTone(undefined), "neutral");
  assert.equal(updateStatusTitle(undefined), undefined);
  assert.equal(updateStatusTitle({ skillId: "a", status: "error", message: "上游 502" }), "上游 502");
  assert.equal(updateStatusTitle({ skillId: "a", status: "no-source" }), t("skills.remote.update.noSourceHint"));
});

test("凭据模式与配额：只说模式，绝不出现令牌", () => {
  assert.equal(authModeLabel("gh"), t("skills.remote.auth.gh"));
  assert.equal(authModeLabel("env"), t("skills.remote.auth.env"));
  assert.equal(authModeLabel("anonymous"), t("skills.remote.auth.anonymous"));
  assert.equal(authModeLabel(undefined), t("skills.remote.auth.unknown"));
  assert.equal(quotaValue(4999), "4999");
  assert.equal(quotaValue(undefined), t("skills.remote.quotaUnknownShort"));
});

test("检查/更新结果汇总", () => {
  const summary = summarizeChecks([
    { skillId: "a", status: "up-to-date" },
    { skillId: "b", status: "update-available" },
    { skillId: "c", status: "no-source" },
    { skillId: "d", status: "error" },
    { skillId: "e", status: "update-available" },
  ]);
  assert.deepEqual(summary, { available: 2, upToDate: 1, noSource: 1, error: 1, total: 5 });
  assert.equal(
    checkSummaryText(summary),
    t("skills.remote.bar.checkSummary", { available: 2, upToDate: 1, noSource: 1, error: 1 }),
  );
  const applied = summarizeApplies([
    { skillId: "a", ok: true },
    { skillId: "b", ok: false },
  ]);
  assert.deepEqual(applied, { ok: 1, failed: 1, total: 2 });
  assert.equal(applySummaryText(applied), t("skills.remote.bar.updateSummary", { ok: 1, failed: 1 }));
});

test("候选来源：唯一键、分组与置信度文案", () => {
  const candidates: DiscoverCandidate[] = [
    { skillId: "user-agents:a", repo: "x/y", ref: "main", skillPath: "a/SKILL.md", confidence: "high", reason: "目录里有链接" },
    { skillId: "user-agents:a", repo: "x/y", ref: "dev", skillPath: "a/SKILL.md", confidence: "medium", reason: "仓库同名" },
    { skillId: "user-agents:b", repo: "x/y", ref: "main", skillPath: "b/SKILL.md", confidence: "low", reason: "弱信号" },
  ];
  assert.equal(candidateKey(candidates[0]!), "user-agents:a|x/y|main|a/SKILL.md");
  assert.notEqual(candidateKey(candidates[0]!), candidateKey(candidates[1]!));
  const groups = groupCandidates(candidates);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.skillId, "user-agents:a");
  assert.equal(groups[0]!.candidates.length, 2);
  assert.equal(confidenceLabel("high"), t("skills.remote.source.confidence.high"));
  assert.equal(confidenceBadgeTone("high"), "neutral");
  assert.equal(confidenceBadgeTone("medium"), "warn");
  assert.equal(confidenceBadgeTone("low"), "neutral");
});

test("安装目标：有工作区才有项目级，路径来自 roots", () => {
  const roots = [
    root("project-dsh", { path: "C:\\proj\\.dsh\\skills" }),
    root("project-agents", { path: "C:\\proj\\.agents\\skills" }),
    root("user-dsh", { path: "C:\\home\\.dsh\\skills" }),
    root("user-agents", { path: "C:\\home\\.agents\\skills" }),
  ];
  const without = installTargetOptions(roots, undefined);
  assert.deepEqual(without.map((option) => option.id), ["user-agents", "user-dsh"]);
  assert.equal(without[0]!.path, "C:\\home\\.agents\\skills");
  const withSpace = installTargetOptions(roots, "C:\\proj");
  assert.deepEqual(withSpace.map((option) => option.id), ["user-agents", "user-dsh", "project-agents", "project-dsh"]);
  assert.equal(withSpace[2]!.path, "C:\\proj\\.agents\\skills");
  assert.equal(targetLabel("project-dsh"), t("skills.install.targetProjectDsh"));
});

test("安装结果文案", () => {
  assert.equal(installResultText({ skillPath: "a/SKILL.md", ok: true, skillId: "user-agents:a" }), t("skills.install.resultOk", { id: "user-agents:a" }));
  assert.equal(installResultText({ skillPath: "a/SKILL.md", ok: false, message: "已存在同名技能" }), t("skills.install.resultFail", { message: "已存在同名技能" }));
  assert.equal(installSummaryText(1, 0), t("skills.install.done", { ok: 1, failed: 0 }));
});

test("哪些技能需要推测来源：可写 + 非平铺 + 尚无记录", () => {
  const skills = [
    makeSkill({ id: "user-agents:a" }),
    makeSkill({ id: "user-agents:b", writable: false }),
    makeSkill({ id: "user-agents:flat.md" }),
    makeSkill({ id: "user-agents:c" }),
  ];
  const needing = skillsNeedingSource(skills, new Set<string>(["user-agents:c"]));
  assert.deepEqual(needing.map((skill) => skill.id), ["user-agents:a"]);
  assert.equal(isFlatSkill({ dirName: "flat.md" }), true);
  assert.ok(flatUnsupportedText().includes("平铺 .md"));
});

test("「全部更新」只挑有更新且非平铺的技能", () => {
  const skills = [makeSkill({ id: "user-agents:a" }), makeSkill({ id: "user-agents:b" }), makeSkill({ id: "user-agents:flat.md" })];
  const checks = {
    "user-agents:a": { status: "update-available" as const },
    "user-agents:b": { status: "up-to-date" as const },
    "user-agents:flat.md": { status: "update-available" as const },
  };
  assert.deepEqual(updatableIds(skills, checks), ["user-agents:a"]);
});
