/**
 * 「来源与更新」一节的**结构**断言（UI-C 的收尾意见，没有浏览器时的第一道防线）：
 *
 *   1. 「未检查 / 无来源」这类状态只能有一个载体（之前「未检查」在标记、一句说明、KeyValue 里出现了三次）；
 *   2. GitHub 凭据与配额不再在每个技能的详情里重复（它们在工具栏「⋯」菜单里）；
 *   3. 无来源时只给一句「无来源」+ 两个文字按钮；有来源时才渲染「更新」那一段。
 *
 * 用源码文本断言而不是渲染断言：仓库里没有 jsdom，组件渲染测试的性价比太低；
 * 真正的界面验收由 .review/ui-c 的走查脚本负责。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS_CSS } from "../../src/client/skills/styles.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(here, "..", "..", "src", "client", "skills");
const source = fs.readFileSync(path.join(skillsDir, "remote", "source.tsx"), "utf8");
const update = fs.readFileSync(path.join(skillsDir, "remote", "update.tsx"), "utf8");
const detail = fs.readFileSync(path.join(skillsDir, "detail.tsx"), "utf8");

test("无来源时只有一句「无来源」，且不再有解释性长句", () => {
  assert.equal(source.includes('t("skills.remote.update.status.noSource")'), true);
  assert.equal(source.includes("noneHint"), false, "「还没有来源记录…」这句解释已经删掉");
  assert.equal(/还没有来源记录/.test(source), false);
});

test("无来源时才出现「推测来源」「手动登记」两个文字按钮", () => {
  assert.ok(source.includes('step === "view" && entry === undefined'));
  assert.ok(source.includes('"skills-remote-source-discover"'));
  assert.ok(source.includes('"skills-remote-source-manual"'));
});

test("状态只有一个标记：Badge 只在 update.tsx 里出现一次，且没有第二处状态文字", () => {
  const badges = update.match(/React\.createElement\(Badge/g) ?? [];
  assert.equal(badges.length, 1, "状态标记只该有一个");
  assert.equal(update.includes("neverChecked"), false);
  assert.equal(/skills\.remote\.update\.status"/.test(update), false, "KeyValue 里那一行「状态」已经删掉");
  assert.equal(update.includes("KeyValue"), false, "更新那一段不再有 KeyValue（凭据 / 配额 / 状态都挪走了）");
});

test("GitHub 凭据与配额不在详情里重复出现", () => {
  assert.equal(update.includes("authModeLabel"), false);
  assert.equal(update.includes("quotaValue"), false);
  assert.equal(/authLabel|quotaLabel/.test(update), false);
});

test("有来源时才渲染更新那一段", () => {
  assert.ok(update.includes("hasSource"));
  assert.ok(source.includes("hasSource: entry !== undefined"));
  assert.equal(detail.includes("SkillUpdateSection"), false, "detail.tsx 不再单独渲染更新那一段");
  assert.ok(source.includes("SkillUpdateSection"), "它由 source.tsx 接在来源信息下面");
});

test("抽屉副标题与「位置」都用缩写后的路径，完整路径走 title", () => {
  assert.ok(detail.includes("abbreviateHomePath(skill.path, props.homeDir)"));
  assert.ok(detail.includes("subtitleTitle: skill.path"));
  assert.ok(detail.includes('title: skill.path'), "位置那一项要给出完整路径的悬停提示");
});

test("添加技能 = 仓库视图：地址输入占满、分支固定 140px、仓库列表默认折叠、汇总发现分批渲染", () => {
  const install = fs.readFileSync(path.join(skillsDir, "remote", "install-view.tsx"), "utf8");
  assert.ok(install.includes("styles.repoGrow"));
  assert.ok(install.includes("styles.refGrow"));
  assert.ok(SKILLS_CSS.includes(".chsk_refGrow{display:flex;flex:0 0 140px"), "分支输入框固定 140px");
  assert.ok(install.includes("React.useState<boolean>(false);\n  const [editing"), "仓库列表默认折叠");
  assert.ok(install.includes("shouldAutoScan(view)"), "第一次没有缓存时自动扫一次");
  assert.ok(install.includes("sliceVisible(group.skills, limitOf(group.repo))"), "上千行分批渲染（按仓库分组，每组 200 行）");
  assert.ok(install.includes("groupDiscovered(all, filtered"), "汇总按仓库分组");
  assert.ok(install.includes("inputIntent(entry)"), "仓库地址与搜索合成一个输入框");
  assert.ok(install.includes("installPlan(selected.values())"), "跨仓库按仓库分组安装");
  assert.ok(install.includes("width: 860"), "宽抽屉");
});
