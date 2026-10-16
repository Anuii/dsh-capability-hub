/**
 * 技能列表的两级折叠（D-B14 / D-B15，UI-DESIGN §3）：纯逻辑，不碰 React / DOM，可直接单测。
 *
 *   一级 = 层级：DSH 内置（默认折叠）/ 用户级 / 项目级。自定义技能目录归用户级；
 *          自定义目录若在 DSH 安装目录（app.asar）里，就是 DSH 内置。
 *   二级 = 来源仓库（owner/name，来自 lock 或插件自己的来源记录），名称排序，「无来源」最后；
 *          DSH 内置不细分；某层级全是无来源、或来源数据不可用时，不显示二级、直接列技能。
 *   目录标签 = 技能所在技能目录路径里最后一个 skills 段之前的那一段（.agents / .dsh），
 *          没有 skills 段时取最后一段；完整路径做悬停提示。只在层级里有不止一个目录的技能时显示（multiDir）。
 *   折叠 = 调用方持有「被用户折叠的分组 key 集合」；搜索 / 任何筛选生效时一律展开，
 *          清空后回到用户原来的折叠状态（集合本身没被改动过）。
 *
 * DSH 不会加载的技能（不可加载 / 被遮蔽，D-B4，0.8.0）默认不显示：它们不参与分组、不参与计数，
 * 某个层级 / 来源仓库里的技能全被隐藏时按「空」处理（层级照旧在，只是没有行；不凭空多出空分组）。
 * 判定复用 format.ts 的 matchesFilter("all")，与工具栏计数、搜索是同一套口径。
 */

import { findSourceFor } from "./remote/model.ts";
import type { SourceEntry } from "../contract/remote.ts";
import {
  isDshInstallPath,
  matches,
  matchesFilter,
  normalizePath,
  rootScope,
  sortSkills,
  type FilterId,
  type MatchContext,
} from "./format.ts";
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

/* ---------------- 目录标签 ---------------- */

/** 技能目录的短名：最后一个 skills 段之前的那一段；没有就取最后一段。 */
export function dirTagText(path: string): string {
  const segments = normalizePath(path)
    .split("\\")
    .filter((part) => part !== "");
  if (segments.length === 0) return path;
  for (let index = segments.length - 1; index > 0; index--) {
    if (segments[index]!.toLowerCase() !== "skills") continue;
    const parent = segments[index - 1]!;
    if (!/^[A-Za-z]:$/.test(parent)) return parent;
    break;
  }
  return segments[segments.length - 1]!;
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
  /** 层级内 DSH 会加载的技能数（不受搜索 / 筛选影响；DSH 不会加载的不算） */
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
  /** 来源表；undefined = 来源数据不可用（远程模块降级 / 请求失败 / 还没加载完） */
  sources?: Readonly<Record<string, SourceEntry>>;
  /** 当前会话有没有工作区 */
  hasWorkspace: boolean;
}

export const levelKey = (level: SkillLevel): string => "level:" + level;
export const repoKey = (level: SkillLevel, repo: string | undefined): string => "repo:" + level + ":" + (repo ?? "");

/** 分组默认是否展开：只有 DSH 内置默认折叠（筛选中一律先展开，见 kit/fold.ts）。 */
export function defaultExpanded(key: string): boolean {
  return key !== levelKey("builtin");
}

export function isFiltering(query: string, filter: FilterId): boolean {
  return query.trim() !== "" || filter !== "all";
}

/**
 * 当前这一次筛选的标识（kit/fold.ts 的 scope）：不筛选时是 ""；搜索词或状态筛选变了，标识就变。
 */
export function filterKeyOf(query: string, filter: FilterId): string {
  return isFiltering(query, filter) ? [query.trim().toLowerCase(), filter].join("\u0000") : "";
}

function repoGroups(
  level: SkillLevel,
  skills: readonly SkillSummary[],
  sources: Readonly<Record<string, SourceEntry>>,
): RepoGroupView[] {
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
  if (none.length > 0)
    groups.push({ key: repoKey(level, undefined), label: t("skills.tree.noSource"), skills: sortSkills(none) });
  return groups;
}

/**
 * 整棵树。不筛选时：用户级总在；DSH 内置有技能才出现；项目级总在（没有工作区时只给一行说明）。
 * 筛选时：只留有匹配的层级。
 *
 * 无论筛不筛选，「DSH 不会加载的技能」（不可加载 / 被遮蔽）都不参与——它们只属于「需关注」筛选
 * （matchesFilter 的口径），所以搜索也翻不出来，分组与计数只数显示出来的那些。
 */
export function buildSkillTree(input: TreeInput): TreeView {
  const { list } = input;
  const filtering = isFiltering(input.query, input.filter);
  const rootById = new Map(list.roots.map((root) => [root.rootId, root]));
  const levelOf = (skill: SkillSummary): SkillLevel =>
    levelOfRoot(rootById.get(skill.rootId) ?? { rootId: skill.rootId, path: skill.path });
  const kept = list.skills.filter((skill) => matches(skill, input.query, input.filter, input.context));

  const levels: LevelView[] = [];
  for (const level of LEVELS) {
    // 「这个层级有多少技能」一律指 DSH 会加载的那些：被隐藏的不进分组、不进计数。
    const all = list.skills.filter((skill) => levelOf(skill) === level && matchesFilter(skill, "all", input.context));
    const shown = sortSkills(kept.filter((skill) => levelOf(skill) === level));
    if (filtering && shown.length === 0) continue;
    if (!filtering && level === "builtin" && all.length === 0) continue;
    const multiDir = new Set(all.map((skill) => skill.rootId)).size > 1;
    const view: LevelView = {
      level,
      key: levelKey(level),
      label: levelLabel(level),
      total: all.length,
      shown: shown.length,
      flat: true,
      multiDir,
      skills: shown,
      repos: [],
    };
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
