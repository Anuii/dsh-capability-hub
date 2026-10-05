/**
 * 技能列表的两级折叠（D-B14 / D-B15，UI-DESIGN §3）：纯逻辑，不碰 React / DOM，可直接单测。
 *
 *   一级 = 层级：DSH 内置（默认折叠）/ 用户级 / 项目级。自定义技能目录归用户级；
 *          自定义目录若在 DSH 安装目录（app.asar）里，就是 DSH 内置。
 *   二级 = 来源仓库（owner/name，来自 lock 或插件自己的来源记录），名称排序，「无来源」最后；
 *          DSH 内置不细分；某层级全是无来源、或来源数据不可用时，不显示二级、直接列技能。
 *   目录标签 = 技能所在技能目录路径里最后一个 skills 段之前的那一段（.agents / .dsh），
 *          没有 skills 段时取最后一段；完整路径做悬停提示。只在层级里有不止一个目录的技能时显示（multiDir）。
 *   目录筛选 = 按技能目录（rootId）筛选；选项含空目录、带技能数、按层级分段。
 *   折叠 = 调用方持有「被用户折叠的分组 key 集合」；搜索 / 任何筛选生效时一律展开，
 *          清空后回到用户原来的折叠状态（集合本身没被改动过）。
 */

import { findSourceFor } from "./remote/model.ts";
import type { SourceEntry } from "../contract/remote.ts";
import { isDshInstallPath, matches, normalizePath, rootScope, sortSkills, type FilterId, type MatchContext } from "./format.ts";
import { t } from "./strings.ts";
import type { ListResult, RootInfo, SkillSummary } from "../contract/local.ts";

/* ---------------- 层级 ---------------- */

export type SkillLevel = "builtin" | "user" | "project";

/** 界面顺序。 */
export const LEVELS: readonly SkillLevel[] = ["builtin", "user", "project"];

/** 一个技能目录归哪个层级。 */
export function levelOfRoot(root: Pick<RootInfo, "rootId" | "path">): SkillLevel {
  const scope = rootScope(root.rootId);
  if (scope === "project") return "project";
  if (scope === "user") return "user";
  if (scope === "custom") return isDshInstallPath(root.path) ? "builtin" : "user";
  return "builtin";
}

export function levelLabel(level: SkillLevel): string {
  if (level === "builtin") return t("skills.root.dshBuiltin");
  if (level === "user") return t("skills.root.user");
  return t("skills.root.project");
}

/* ---------------- 目录标签与目录筛选 ---------------- */

/** 技能目录的短名：最后一个 skills 段之前的那一段；没有就取最后一段。 */
export function dirTagText(path: string): string {
  const segments = normalizePath(path).split("\\").filter((part) => part !== "");
  if (segments.length === 0) return path;
  for (let index = segments.length - 1; index > 0; index--) {
    if (segments[index]!.toLowerCase() !== "skills") continue;
    const parent = segments[index - 1]!;
    if (!/^[A-Za-z]:$/.test(parent)) return parent;
    break;
  }
  return segments[segments.length - 1]!;
}

export interface DirOption {
  /** 筛选值 = 技能目录的 rootId */
  rootId: string;
  level: SkillLevel;
  tag: string;
  /** 该目录下的技能总数（不受搜索 / 筛选影响） */
  count: number;
  /** 完整路径（悬停提示） */
  title: string;
}

/**
 * 目录筛选的选项：DSH 会加载的全部技能目录（存在的目录，含空目录；不存在但列表里有技能的也算），
 * 按层级（LEVELS 顺序）再按短名排序。
 */
export function dirOptions(list: Pick<ListResult, "roots" | "skills">): DirOption[] {
  const counts = new Map<string, number>();
  for (const skill of list.skills) counts.set(skill.rootId, (counts.get(skill.rootId) ?? 0) + 1);
  const options = list.roots
    .filter((root) => root.exists || (counts.get(root.rootId) ?? 0) > 0)
    .map((root) => ({
      rootId: root.rootId,
      level: levelOfRoot(root),
      tag: dirTagText(root.path),
      count: counts.get(root.rootId) ?? 0,
      title: root.path,
    }));
  return options.sort((left, right) =>
    LEVELS.indexOf(left.level) - LEVELS.indexOf(right.level) || left.tag.localeCompare(right.tag) || left.rootId.localeCompare(right.rootId));
}

/** rootId → 目录标签（行上用）。 */
export function dirTagIndex(roots: readonly RootInfo[]): Map<string, { text: string; title: string }> {
  return new Map(roots.map((root) => [root.rootId, { text: dirTagText(root.path), title: root.path }]));
}

/* ---------------- 树 ---------------- */

export interface RepoGroupView {
  /** 折叠 key */
  key: string;
  /** owner/name；「无来源」为 undefined */
  repo?: string;
  label: string;
  skills: SkillSummary[];
}

export interface LevelView {
  level: SkillLevel;
  /** 折叠 key */
  key: string;
  label: string;
  /** 层级内技能总数（不受搜索 / 筛选影响） */
  total: number;
  /** 通过搜索 / 筛选的技能数 */
  shown: number;
  /** true = 不分二级，直接列 skills */
  flat: boolean;
  /** 层级里的技能来自不止一个技能目录：只有这时行上才显示目录标签（只有一个目录时它是噪音） */
  multiDir: boolean;
  skills: SkillSummary[];
  repos: RepoGroupView[];
  /** 项目级且没有当前工作区：只显示一行说明 */
  noWorkspace?: boolean;
}

export interface TreeView {
  levels: LevelView[];
  shown: number;
  total: number;
  /** 搜索或任何筛选生效中 */
  filtering: boolean;
}

export interface TreeInput {
  list: Pick<ListResult, "roots" | "skills">;
  query: string;
  filter: FilterId;
  context?: MatchContext;
  /** 目录筛选（rootId）；"" = 全部目录 */
  dir?: string;
  /** 来源表；undefined = 来源数据不可用（远程模块降级 / 请求失败 / 还没加载完） */
  sources?: Readonly<Record<string, SourceEntry>>;
  /** 当前会话有没有工作区 */
  hasWorkspace: boolean;
}

export const levelKey = (level: SkillLevel): string => "level:" + level;
export const repoKey = (level: SkillLevel, repo: string | undefined): string => "repo:" + level + ":" + (repo ?? "");

/** 默认被折叠的分组：只有 DSH 内置。 */
export const DEFAULT_COLLAPSED: readonly string[] = [levelKey("builtin")];

export function isFiltering(query: string, filter: FilterId, dir: string | undefined): boolean {
  return query.trim() !== "" || filter !== "all" || (dir ?? "") !== "";
}

/**
 * 当前这一次筛选的标识：不筛选时是 ""；搜索词、状态筛选、目录筛选任何一项变了，标识就变。
 */
export function filterKeyOf(query: string, filter: FilterId, dir: string | undefined): string {
  return isFiltering(query, filter, dir) ? [query.trim().toLowerCase(), filter, dir ?? ""].join("\u0000") : "";
}

/**
 * 折叠状态，分两份：
 *   normal   = 不筛选时用户的折叠（初始只有 DSH 内置被折叠）；
 *   filtered = 某一次筛选里用户的折叠，只对 filterKey 那一次筛选有效。
 * 进入（或换成另一种）筛选时有匹配的分组全部展开；筛选中仍可手动折叠；清空筛选回到 normal，原样不动。
 */
export interface FoldState {
  normal: ReadonlySet<string>;
  filtered: { filterKey: string; collapsed: ReadonlySet<string> };
}

export function initialFoldState(): FoldState {
  return { normal: new Set(DEFAULT_COLLAPSED), filtered: { filterKey: "", collapsed: new Set() } };
}

/** 某次筛选里被折叠的分组（筛选换了就当作没有）。 */
function filteredCollapsed(state: FoldState, filterKey: string): ReadonlySet<string> {
  return state.filtered.filterKey === filterKey ? state.filtered.collapsed : new Set();
}

/** 某个分组是否展开。 */
export function isFoldExpanded(state: FoldState, filterKey: string, key: string): boolean {
  if (filterKey === "") return !state.normal.has(key);
  return !filteredCollapsed(state, filterKey).has(key);
}

function toggled(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** 用户点了某个分组的标题：不筛选时改 normal，筛选时只改这一次筛选的折叠。 */
export function toggleFold(state: FoldState, filterKey: string, key: string): FoldState {
  if (filterKey === "") return { ...state, normal: toggled(state.normal, key) };
  return { ...state, filtered: { filterKey, collapsed: toggled(filteredCollapsed(state, filterKey), key) } };
}

function repoGroups(level: SkillLevel, skills: readonly SkillSummary[], sources: Readonly<Record<string, SourceEntry>>): RepoGroupView[] {
  const byRepo = new Map<string, SkillSummary[]>();
  const none: SkillSummary[] = [];
  for (const skill of skills) {
    const repo = findSourceFor(skill, sources)?.repo;
    if (repo === undefined || repo === "") none.push(skill);
    else byRepo.set(repo, [...(byRepo.get(repo) ?? []), skill]);
  }
  const groups: RepoGroupView[] = [...byRepo.entries()]
    .sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map(([repo, items]) => ({ key: repoKey(level, repo), repo, label: repo, skills: sortSkills(items) }));
  if (none.length > 0) groups.push({ key: repoKey(level, undefined), label: t("skills.tree.noSource"), skills: sortSkills(none) });
  return groups;
}

/**
 * 整棵树。不筛选时：用户级总在；DSH 内置有技能才出现；项目级总在（没有工作区时只给一行说明）。
 * 筛选时：只留有匹配的层级。
 */
export function buildSkillTree(input: TreeInput): TreeView {
  const { list } = input;
  const dir = input.dir ?? "";
  const filtering = isFiltering(input.query, input.filter, dir);
  const rootById = new Map(list.roots.map((root) => [root.rootId, root]));
  const levelOf = (skill: SkillSummary): SkillLevel => levelOfRoot(rootById.get(skill.rootId) ?? { rootId: skill.rootId, path: skill.path });
  const kept = list.skills.filter((skill) =>
    matches(skill, input.query, input.filter, input.context) && (dir === "" || skill.rootId === dir));

  const levels: LevelView[] = [];
  for (const level of LEVELS) {
    const all = list.skills.filter((skill) => levelOf(skill) === level);
    const shown = sortSkills(kept.filter((skill) => levelOf(skill) === level));
    if (filtering && shown.length === 0) continue;
    if (!filtering && level === "builtin" && all.length === 0) continue;
    const multiDir = new Set(all.map((skill) => skill.rootId)).size > 1;
    const view: LevelView = { level, key: levelKey(level), label: levelLabel(level), total: all.length, shown: shown.length, flat: true, multiDir, skills: shown, repos: [] };
    if (level === "project" && !input.hasWorkspace) view.noWorkspace = true;
    if (level !== "builtin" && input.sources !== undefined && shown.length > 0) {
      const groups = repoGroups(level, shown, input.sources);
      // 全是无来源：不显示孤零零的「无来源」二级头
      if (!(groups.length === 1 && groups[0]!.repo === undefined)) {
        view.flat = false;
        view.repos = groups;
      }
    }
    levels.push(view);
  }
  return { levels, shown: kept.length, total: list.skills.length, filtering };
}
