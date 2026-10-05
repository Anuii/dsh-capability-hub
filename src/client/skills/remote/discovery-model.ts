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
