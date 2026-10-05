/**
 * 仓库视图（「添加技能」，D-B16）的纯逻辑：汇总发现的筛选与计数、跨仓库安装计划、
 * 相对时间、首次自动扫描判定、增量渲染。不碰 React / DOM，可直接单测。
 */

import { t } from "../strings.ts";
import type { DiscoveredSkill, DiscoveryRepoView, DiscoveryView } from "./types.ts";

export type InstalledFilter = "all" | "not" | "yes";
export const INSTALLED_FILTERS: readonly InstalledFilter[] = ["all", "not", "yes"];

/** 每次多渲染多少行（上千行时不卡）。 */
export const DISCOVERY_PAGE = 200;

/** 一个技能在勾选集合里的 key。 */
export function discoveredKey(skill: { repo: string; skillPath: string }): string {
  return skill.repo.toLowerCase() + "|" + skill.skillPath;
}

function matchesText(skill: DiscoveredSkill, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [skill.name, skill.dirName, skill.description, skill.repo].some((value) => typeof value === "string" && value.toLowerCase().includes(q));
}

export interface DiscoveryFilter {
  query: string;
  installed: InstalledFilter;
  /** 仓库筛选；"" = 全部仓库 */
  repo: string;
}

function matchesRepo(skill: DiscoveredSkill, repo: string): boolean {
  return repo === "" || skill.repo.toLowerCase() === repo.toLowerCase();
}

/** 按搜索、已安装、仓库筛选；排序：未安装在前，再按名称。 */
export function filterDiscovered(skills: readonly DiscoveredSkill[], filter: DiscoveryFilter): DiscoveredSkill[] {
  return skills
    .filter((skill) => matchesText(skill, filter.query) && matchesRepo(skill, filter.repo))
    .filter((skill) => filter.installed === "all" || (filter.installed === "yes") === (skill.installedId !== undefined))
    .sort((left, right) =>
      Number(left.installedId !== undefined) - Number(right.installedId !== undefined) ||
      (left.name ?? left.dirName).localeCompare(right.name ?? right.dirName) ||
      left.repo.localeCompare(right.repo));
}

/** 分段上的计数（受搜索与仓库筛选影响，不受已安装筛选影响）。 */
export function installedCounts(skills: readonly DiscoveredSkill[], query: string, repo: string): Record<InstalledFilter, number> {
  const base = skills.filter((skill) => matchesText(skill, query) && matchesRepo(skill, repo));
  const yes = base.filter((skill) => skill.installedId !== undefined).length;
  return { all: base.length, not: base.length - yes, yes };
}

export interface InstallGroup {
  repo: string;
  ref?: string;
  skillPaths: string[];
}

/** 跨仓库的勾选 → 按「仓库 + 分支」分组的安装计划（每组一次 POST skills/install），仓库名排序。 */
export function installPlan(picked: Iterable<{ repo: string; ref?: string; skillPath: string }>): InstallGroup[] {
  const groups = new Map<string, InstallGroup>();
  for (const item of picked) {
    const key = item.repo.toLowerCase() + "@" + (item.ref ?? "");
    const group = groups.get(key) ?? { repo: item.repo, ...(item.ref === undefined ? {} : { ref: item.ref }), skillPaths: [] };
    if (!group.skillPaths.includes(item.skillPath)) group.skillPaths.push(item.skillPath);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.repo.toLowerCase().localeCompare(right.repo.toLowerCase()));
}

/** 「上次扫描」的相对时间。 */
export function relativeTime(iso: string | undefined, now: number): string {
  if (iso === undefined) return t("skills.repoView.never");
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return t("skills.repoView.never");
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return t("skills.repoView.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("skills.repoView.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("skills.repoView.hoursAgo", { count: hours });
  return t("skills.repoView.daysAgo", { count: Math.round(hours / 24) });
}

/** 打开视图时是否要自动扫一次：从没扫过、且仓库列表非空。 */
export function shouldAutoScan(view: DiscoveryView | undefined): boolean {
  return view !== undefined && !view.cached && view.repos.length > 0;
}

/** 仓库行的等宽小字：分支 · 子目录。 */
export function repoConfigText(repo: Pick<DiscoveryRepoView, "ref" | "subPath">): string {
  const ref = repo.ref === undefined || repo.ref === "" ? t("skills.repoView.defaultBranch") : repo.ref;
  const sub = repo.subPath === undefined || repo.subPath === "" ? t("skills.repoView.wholeRepo") : repo.subPath;
  return ref + " · " + sub;
}

/** 仓库行的扫描状态：未扫描 / n 个技能 / 扫描失败。 */
export function repoScanText(repo: DiscoveryRepoView): string {
  if (repo.scannedAt === undefined) return t("skills.repoView.notScanned");
  if (repo.error !== undefined) return t("skills.repoView.scanFailed");
  return t("skills.repoView.skillCount", { count: repo.skillCount ?? 0 });
}

/** 增量渲染：只取前 limit 个，并告诉界面还剩多少。 */
export function sliceVisible<T>(items: readonly T[], limit: number): { visible: T[]; rest: number } {
  const visible = items.slice(0, Math.max(0, limit));
  return { visible, rest: items.length - visible.length };
}

/* ---------------- 合一的输入框（0.3.4） ---------------- */

export type InputIntent = "empty" | "repo" | "search";

const REPO_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/**
 * 顶部唯一一个输入框里的内容是什么：像仓库地址（owner/name、https://github.com/…、github.com/…）
 * 就是 "repo"（浏览 / 加入仓库列表），否则是 skills.sh 搜索关键词。
 */
export function inputIntent(text: string): InputIntent {
  const value = text.trim();
  if (value === "") return "empty";
  if (/^https?:\/\//i.test(value) || /^(www\.)?github\.com\//i.test(value)) return "repo";
  return REPO_SHAPE.test(value) ? "repo" : "search";
}

/** 宿主只认 owner/name 或带协议的链接：github.com/… 补上 https://。 */
export function normalizeRepoInput(text: string): string {
  const value = text.trim();
  return /^(www\.)?github\.com\//i.test(value) ? "https://" + value : value;
}

/* ---------------- 汇总按仓库分组（0.3.4） ---------------- */

/** 技能数超过这个数的仓库默认折叠（例如 ComposioHQ 一个仓库就有 800 多个）。 */
export const LARGE_REPO = 50;

export interface DiscoveryGroup {
  repo: string;
  /** 该仓库在汇总里的技能总数（不受筛选影响，决定默认是否折叠） */
  total: number;
  /** 通过筛选的技能（保持 filterDiscovered 的顺序） */
  skills: DiscoveredSkill[];
}

/** 把筛选后的技能按仓库分组：顺序跟仓库列表一致，列表里没有的仓库排在后面（按名称）；没有技能的组不出现。 */
export function groupDiscovered(all: readonly DiscoveredSkill[], filtered: readonly DiscoveredSkill[], repoOrder: readonly string[]): DiscoveryGroup[] {
  const totals = new Map<string, number>();
  for (const skill of all) totals.set(skill.repo.toLowerCase(), (totals.get(skill.repo.toLowerCase()) ?? 0) + 1);
  const groups = new Map<string, DiscoveryGroup>();
  for (const skill of filtered) {
    const key = skill.repo.toLowerCase();
    const group = groups.get(key) ?? { repo: skill.repo, total: totals.get(key) ?? 0, skills: [] };
    group.skills.push(skill);
    groups.set(key, group);
  }
  const order = repoOrder.map((repo) => repo.toLowerCase());
  const rank = (repo: string): number => {
    const index = order.indexOf(repo.toLowerCase());
    return index === -1 ? order.length : index;
  };
  return [...groups.values()].sort((left, right) => rank(left.repo) - rank(right.repo) || left.repo.localeCompare(right.repo));
}

/** 这一次筛选的标识；不筛选时是 ""。 */
export function discoveryFilterKey(filter: DiscoveryFilter): string {
  const query = filter.query.trim().toLowerCase();
  if (query === "" && filter.installed === "all" && filter.repo === "") return "";
  return [query, filter.installed, filter.repo.toLowerCase()].join("\u0000");
}

/**
 * 仓库分组的折叠：只记用户点过的（true = 展开），没点过的用默认值。
 *   不筛选：默认 = 技能数不超过 LARGE_REPO 就展开；
 *   筛选中：有匹配的分组默认全部展开，仍可手动折叠，只对这一次筛选有效。
 */
export interface RepoFold {
  normal: ReadonlyMap<string, boolean>;
  filtered: { filterKey: string; open: ReadonlyMap<string, boolean> };
}

export function initialRepoFold(): RepoFold {
  return { normal: new Map(), filtered: { filterKey: "", open: new Map() } };
}

function filteredOpen(fold: RepoFold, filterKey: string): ReadonlyMap<string, boolean> {
  return fold.filtered.filterKey === filterKey ? fold.filtered.open : new Map();
}

export function repoExpanded(fold: RepoFold, filterKey: string, group: Pick<DiscoveryGroup, "repo" | "total">): boolean {
  const key = group.repo.toLowerCase();
  if (filterKey === "") return fold.normal.get(key) ?? group.total <= LARGE_REPO;
  return filteredOpen(fold, filterKey).get(key) ?? true;
}

export function toggleRepoFold(fold: RepoFold, filterKey: string, group: Pick<DiscoveryGroup, "repo" | "total">): RepoFold {
  const key = group.repo.toLowerCase();
  const next = !repoExpanded(fold, filterKey, group);
  if (filterKey === "") return { ...fold, normal: new Map(fold.normal).set(key, next) };
  return { ...fold, filtered: { filterKey, open: new Map(filteredOpen(fold, filterKey)).set(key, next) } };
}
