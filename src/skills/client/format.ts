/**
 * 技能标签页的**纯逻辑**（UI-A 重做后：按 docs/UI-DESIGN.md §4 的口径）。
 *
 * 这里刻意不碰 DOM、不碰 React、不发请求：全部可以用 node:test 直接测
 * （见 test/skills/client/format.test.ts）。
 * 文案一律走 strings.ts 的 t()，所以测试断言的是界面上真正会出现的字。
 *
 * 与重做前的差别（都来自 UI-DESIGN §4）：
 *   - 筛选从 6 段收敛成 4 段：全部 / 已启用 / 已停用 / 需关注；
 *   - 「需关注」= 不可加载 + 被遮蔽 + 可更新（可更新来自远程 store，用 MatchContext 传进来）；
 *   - 分组不再折叠空的根，而是**隐藏**它们（列表底部给一行「另有 N 个…」可切换）；
 *   - 一行的标记只剩三种：不可加载 / 可更新 / 被遮蔽（外加「无名称」兜底），最多 2 个。
 */

import type { DiagnosticLevel, ListResult, RootInfo, SkillSummary, SkillViewFile, TrashItem, TrashReason } from "../contract/local.ts";
import { t } from "./strings.ts";
import type { BadgeTone } from "../../kit/index.ts";
import type { FieldError } from "../../platform/contract/host.ts";

/* ---------------- 技能根 ---------------- */

export type RootScope = "project" | "user" | "custom" | "bundled";

/** 根 id → 归谁管（D-B2：项目级 / 用户级 / 自定义只读根 / 内置只读根）。 */
export function rootScope(rootId: string): RootScope {
  if (rootId === "project-dsh" || rootId === "project-agents") return "project";
  if (rootId === "user-dsh" || rootId === "user-agents") return "user";
  if (rootId.startsWith("custom-")) return "custom";
  return "bundled";
}

/** 根的范围文案（分组标题用）。 */
export function rootScopeLabel(rootId: string): string {
  switch (rootScope(rootId)) {
    case "project":
      return t("skills.root.project");
    case "user":
      return t("skills.root.user");
    case "custom":
      return t("skills.root.custom");
    case "bundled":
      return t("skills.root.bundled");
  }
}

/** 项目级根（workspace 为空时接口不会返回它们）。 */
export function isProjectRoot(rootId: string): boolean {
  return rootScope(rootId) === "project";
}

/* ---------------- 路径显示（UI-C） ---------------- */

/** 路径统一成反斜杠分隔（Windows 展示口径），并去掉末尾多余的分隔符。 */
export function normalizePath(path: string): string {
  return path.trim().replace(/[\\/]+/g, "\\").replace(/\\+$/, "");
}

/**
 * 是不是 DSH 安装目录里的路径（asar 内的内置根）。
 *
 * 判据只认 app.asar 这一段：安装目录本身可以变（用户可能装在别处），
 * 但 DSH 自己的包树一定挂在 …\\resources\\app.asar\\… 之下。
 */
export function isDshInstallPath(path: string): boolean {
  return /(^|[\\/])app\.asar([/\\]|$)/i.test(path.trim());
}

/** 去掉路径末尾的若干段（大小写不敏感）；对不上返回 undefined。 */
function stripSegments(path: string, segments: readonly string[]): string | undefined {
  const full = normalizePath(path);
  const suffix = segments.join("\\");
  const lowerFull = full.toLowerCase();
  const lowerSuffix = suffix.toLowerCase();
  if (lowerFull === lowerSuffix) return "";
  if (!lowerFull.endsWith("\\" + lowerSuffix)) return undefined;
  return full.slice(0, full.length - suffix.length - 1);
}

/**
 * 从根列表推出用户家目录。
 *
 * 宿主不会把 homeDir 交给客户端，但两条用户级根的路径是契约固定的：
 * user-agents = <home>/.agents/skills、user-dsh = <home>/.dsh/skills。
 * 反推出来的最短候选就是家目录；两条都拿不到时返回 undefined（界面就不做缩写）。
 */
export function homeDirFromRoots(roots: readonly RootInfo[]): string | undefined {
  const candidates: string[] = [];
  for (const root of roots) {
    const segments = root.rootId === "user-agents"
      ? [".agents", "skills"]
      : root.rootId === "user-dsh"
        ? [".dsh", "skills"]
        : undefined;
    if (segments === undefined) continue;
    const home = stripSegments(root.path, segments);
    if (home !== undefined && home !== "") candidates.push(home);
  }
  if (candidates.length === 0) return undefined;
  return candidates.sort((left, right) => left.length - right.length)[0];
}

/**
 * 家目录下的路径缩写成 ~\\…；不在家目录下（或推不出家目录）时原样返回。
 * 盘符大小写、正反斜杠混用都能正确匹配。
 */
export function abbreviateHomePath(path: string, homeDir: string | undefined): string {
  if (typeof path !== "string" || path.trim() === "") return path;
  if (homeDir === undefined || homeDir.trim() === "") return path;
  const home = normalizePath(homeDir);
  if (home === "") return path;
  const full = normalizePath(path);
  const lowerHome = home.toLowerCase();
  const lowerFull = full.toLowerCase();
  if (lowerFull === lowerHome) return "~";
  if (!lowerFull.startsWith(lowerHome + "\\")) return path;
  return "~" + full.slice(home.length);
}

/**
 * 分组标题：DSH 安装目录（asar）里的自定义根统一叫「DSH 内置」——
 * 标题上挂一串 …\\app.asar\\… 既长又没有任何决策价值。
 */
export function rootGroupTitle(root: RootInfo): string {
  if (rootScope(root.rootId) === "custom" && isDshInstallPath(root.path)) return t("skills.root.dshBuiltin");
  return rootScopeLabel(root.rootId);
}

/** DSH 内置根（标题上不显示路径，完整路径走 title 提示）。 */
export function isDshBuiltinRoot(root: RootInfo): boolean {
  return rootScope(root.rootId) === "custom" && isDshInstallPath(root.path);
}

/**
 * 分组标题右下那条等宽小字：项目级显示相对工作区的路径，家目录下的缩写成 ~\\…，
 * DSH 内置根**不显示**路径（完整路径只出现在悬停提示里）。
 */
export function rootMetaPath(root: RootInfo, workspace: string | undefined, homeDir?: string): string | undefined {
  if (isDshBuiltinRoot(root)) return undefined;
  if (!isProjectRoot(root.rootId)) return abbreviateHomePath(root.path, homeDir);
  return relativeToWorkspace(workspace, root.path) ?? abbreviateHomePath(root.path, homeDir);
}

/** 分组标题（以及 meta）的悬停提示：永远是完整路径。 */
export function rootPathTitle(root: RootInfo): string {
  return root.path;
}

/* ---------------- 分组顺序（UI-C） ---------------- */

/**
 * 分组的显示顺序（UI-DESIGN §4 + UI-C）：项目级 → 用户级 → 只读根（custom / bundled / DSH 内置）。
 *
 * 为什么不再直接用接口顺序（= 优先级顺序）：优先级是「谁遮蔽谁」的实现细节，
 * 界面上按「跟我最近的排最前」才符合直觉；遮蔽关系由行上的 shadowedBy 标记表达，
 * 与分组顺序无关。同档内保持接口给的顺序（precedence）。
 */
export function rootRank(rootId: string): number {
  const scope = rootScope(rootId);
  if (scope === "project") return 0;
  if (scope === "user") return 1;
  return 2;
}

export function orderRoots(roots: readonly RootInfo[]): RootInfo[] {
  return roots
    .map((root, index) => ({ root, index }))
    .sort((left, right) => rootRank(left.root.rootId) - rootRank(right.root.rootId) || left.index - right.index)
    .map((entry) => entry.root);
}

/**
 * path 相对 workspace 的路径（Windows 盘符大小写不敏感）。
 * 不是 workspace 的子路径时返回 undefined（调用方退回绝对路径）。
 */
export function relativeToWorkspace(workspace: string | undefined, path: string): string | undefined {
  if (typeof workspace !== "string" || workspace.trim() === "") return undefined;
  const normalize = (value: string): string => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const base = normalize(workspace.trim());
  const full = normalize(path);
  const lowerBase = base.toLowerCase();
  const lowerFull = full.toLowerCase();
  if (lowerFull === lowerBase) return ".";
  if (!lowerFull.startsWith(lowerBase + "/")) return undefined;
  return full.slice(base.length + 1);
}

/* ---------------- 排序与分组 ---------------- */

export interface RootGroup {
  root: RootInfo;
  skills: SkillSummary[];
  /** 根目录不存在（界面上只在用户展开空根时才看得到） */
  missing: boolean;
}

/** 技能显示名（没有 frontmatter name 时用目录名）。 */
export interface DisplayName {
  text: string;
  /** true = 该名称来自目录名（frontmatter 没有 name） */
  fromDir: boolean;
  dirName: string;
}

export function displayName(skill: SkillSummary): DisplayName {
  const name = skill.name;
  if (typeof name === "string" && name !== "") return { text: name, fromDir: false, dirName: skill.dirName };
  return { text: skill.dirName, fromDir: true, dirName: skill.dirName };
}

/** 组内按显示名排序（同名时按 id，保证顺序稳定）。 */
export function sortSkills(skills: readonly SkillSummary[]): SkillSummary[] {
  return [...skills].sort((left, right) => {
    const byName = displayName(left).text.localeCompare(displayName(right).text);
    return byName !== 0 ? byName : left.id.localeCompare(right.id);
  });
}

/**
 * 按根分组：根的顺序就是接口给的顺序（= 优先级顺序），组内按名称排序。
 * 未知 rootId（契约外的根）兜底成合成根，绝不丢技能。
 */
export function groupByRoot(roots: readonly RootInfo[], skills: readonly SkillSummary[]): RootGroup[] {
  const groups: RootGroup[] = orderRoots(roots).map((root) => ({
    root,
    skills: sortSkills(skills.filter((skill) => skill.rootId === root.rootId)),
    missing: !root.exists,
  }));
  const known = new Set(roots.map((root) => root.rootId));
  for (const skill of sortSkills(skills.filter((item) => !known.has(item.rootId)))) {
    const existing = groups.find((group) => group.root.rootId === skill.rootId);
    if (existing !== undefined) {
      existing.skills.push(skill);
      existing.skills = sortSkills(existing.skills);
      continue;
    }
    groups.push({
      root: { rootId: skill.rootId, path: skill.path, exists: true, writable: skill.writable, precedence: 9999 },
      skills: [skill],
      missing: false,
    });
  }
  return groups;
}

/**
 * 平铺 .md 技能：**单个 .md 文件**就是技能（宿主把 dirName 设成文件名，path 指向文件本身）。
 * 这类技能不支持来源登记 / 检查更新 / 更新（调度者决定），界面上直接说明并不发请求。
 */
export function isFlatSkill(skill: { dirName: string }): boolean {
  return /\.md$/i.test(skill.dirName);
}

/* ---------------- 搜索与筛选 ---------------- */

/** UI-DESIGN §4 的四段筛选。 */
export type FilterId = "all" | "enabled" | "disabled" | "attention";

/** 筛选条的顺序（界面按这个顺序渲染）。 */
export const FILTERS: readonly FilterId[] = ["all", "enabled", "disabled", "attention"];

export function filterLabel(id: FilterId): string {
  switch (id) {
    case "all":
      return t("skills.filter.all");
    case "enabled":
      return t("skills.filter.enabled");
    case "disabled":
      return t("skills.filter.disabled");
    case "attention":
      return t("skills.filter.attention");
  }
}

/** 判定筛选时需要的**外部事实**：哪些技能当前标着「可更新」（来自远程 store）。 */
export interface MatchContext {
  updatable?: ReadonlySet<string>;
}

/** 诊断计数。 */
export interface DiagnosticCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

export function diagnosticCounts(skill: SkillSummary): DiagnosticCounts {
  const counts: DiagnosticCounts = { error: 0, warning: 0, info: 0, total: 0 };
  for (const diagnostic of skill.diagnostics) {
    const level: DiagnosticLevel = diagnostic.level;
    counts[level] += 1;
    counts.total += 1;
  }
  return counts;
}

/** 「有问题」＝ 有 error 或 warning（info 只是提示，不算问题）。 */
export function hasProblems(skill: SkillSummary): boolean {
  const counts = diagnosticCounts(skill);
  return counts.error > 0 || counts.warning > 0;
}

/** 「需关注」＝ 不可加载 + 被遮蔽 + 可更新（UI-DESIGN §4）。 */
export function needsAttention(skill: SkillSummary, context?: MatchContext): boolean {
  if (!skill.loadable) return true;
  if (skill.shadowedBy !== undefined) return true;
  return context?.updatable?.has(skill.id) === true;
}

/** 搜索：名称、目录名、id、描述（大小写不敏感）。 */
export function matchesQuery(skill: SkillSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = [
    skill.name ?? "",
    skill.dirName,
    skill.id,
    skill.description ?? "",
    skill.rootId,
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle);
}

export function matchesFilter(skill: SkillSummary, filter: FilterId, context?: MatchContext): boolean {
  switch (filter) {
    case "all":
      return true;
    case "enabled":
      return !skill.modelInvocationDisabled;
    case "disabled":
      return skill.modelInvocationDisabled;
    case "attention":
      return needsAttention(skill, context);
  }
}

export function matches(skill: SkillSummary, query: string, filter: FilterId, context?: MatchContext): boolean {
  return matchesQuery(skill, query) && matchesFilter(skill, filter, context);
}

/** 工具栏分段上的计数。 */
export function filterCounts(skills: readonly SkillSummary[], context?: MatchContext): Record<FilterId, number> {
  const counts: Record<FilterId, number> = { all: 0, enabled: 0, disabled: 0, attention: 0 };
  for (const id of FILTERS) counts[id] = skills.filter((skill) => matchesFilter(skill, id, context)).length;
  return counts;
}

/* ---------------- 行标记与启停 ---------------- */


export interface RowBadge {
  key: string;
  label: string;
  tone: BadgeTone;
  title?: string;
}

/**
 * 一行的标记（UI-DESIGN §4）：不可加载（danger）、可更新（accent）、被遮蔽（neutral），
 * 外加「没有 name 时用目录名」的兜底标记。行内最多显示 2 个（多的由 kit 截掉），
 * 所以这里的顺序就是优先级。
 */
export function rowBadges(skill: SkillSummary, context?: MatchContext): RowBadge[] {
  const badges: RowBadge[] = [];
  if (!skill.loadable) {
    badges.push({ key: "notLoadable", label: t("skills.tag.notLoadable"), tone: "danger", title: t("skills.tag.notLoadableTitle") });
  }
  if (context?.updatable?.has(skill.id) === true) {
    badges.push({ key: "updatable", label: t("skills.tag.updatable"), tone: "accent", title: t("skills.tag.updatableTitle") });
  }
  if (skill.shadowedBy !== undefined) {
    badges.push({ key: "shadowed", label: t("skills.tag.shadowed"), tone: "neutral", title: t("skills.tag.shadowedTitle", { id: skill.shadowedBy }) });
  }
  if (displayName(skill).fromDir) {
    badges.push({ key: "noName", label: t("skills.tag.noName"), tone: "neutral", title: t("skills.name.hint") });
  }
  return badges;
}

/** 诊断级别 → kit Badge 的 tone（详情「体检」用）。 */
export function levelTone(level: DiagnosticLevel): BadgeTone {
  if (level === "error") return "danger";
  if (level === "warning") return "warn";
  return "neutral";
}

/** 诊断级别 → 界面上那一小段级别文字。 */
export function levelLabel(level: DiagnosticLevel): string {
  if (level === "error") return t("skills.diag.level.error");
  if (level === "warning") return t("skills.diag.level.warning");
  return t("skills.diag.level.info");
}

/**
 * 不能启停时给出**人能看懂的原因**（D-B3 / 验收 U2）。
 * 返回 undefined = 可以启停。
 */
export function toggleBlockReason(skill: SkillSummary): string | undefined {
  if (!skill.writable) return t("skills.toggle.blockedReadonly");
  if (!skill.format.safeToToggle) {
    const detail = skill.diagnostics.find((item) => item.level === "error" || item.level === "warning");
    const base = t("skills.toggle.blockedUnsafe");
    return detail === undefined ? base : `${base}：${detail.message}`;
  }
  return undefined;
}

/** 启停开关的无障碍名 / 悬停文案。 */
export function toggleLabel(skill: SkillSummary): string {
  const name = displayName(skill).text;
  return skill.modelInvocationDisabled
    ? t("skills.toggle.enable", { name })
    : t("skills.toggle.disable", { name });
}

/* ---------------- 调用权限（D-B17） ---------------- */

/**
 * 技能的调用权限，口径与 DSH 一致（dsh-skill-filesystem）：
 *   模型调用 = disable-model-invocation 不是 true（列表上的开关就是它，可改）；
 *   用户调用 = user-invocable 不是 false（只读展示，键缺省即允许）。
 */
export interface InvocationAccess {
  model: boolean;
  user: boolean;
  /** user-invocable 是否在 frontmatter 里显式写了 */
  userExplicit: boolean;
  /** 模型调用能不能在界面上改（技能所在目录可写） */
  editable: boolean;
}

export function invocationAccess(skill: Pick<SkillSummary, "modelInvocationDisabled" | "userInvocable"> & { writable?: boolean }): InvocationAccess {
  return {
    model: !skill.modelInvocationDisabled,
    user: skill.userInvocable !== false,
    userExplicit: skill.userInvocable !== null,
    editable: skill.writable !== false,
  };
}

/** 行尾那一小段文字：模型、用户 / 仅模型 / 仅用户 / 不可调用。 */
export function invocationLabel(access: InvocationAccess): string {
  if (access.model && access.user) return t("skills.access.both");
  if (access.model) return t("skills.access.modelOnly");
  if (access.user) return t("skills.access.userOnly");
  return t("skills.access.none");
}

/** 模型调用的说明（详情与悬停提示共用）。 */
export function modelAccessText(access: InvocationAccess): string {
  if (!access.editable) return access.model ? t("skills.access.modelAllowedReadonly") : t("skills.access.modelDeniedReadonly");
  return access.model ? t("skills.access.modelAllowed") : t("skills.access.modelDenied");
}

/** 用户调用的说明：区分「默认允许」与「显式写了」。 */
export function userAccessText(access: InvocationAccess): string {
  if (!access.user) return t("skills.access.userDenied");
  return access.userExplicit ? t("skills.access.userAllowed") : t("skills.access.userDefault");
}

/** 行尾文字的悬停提示：两种调用各一行。 */
export function invocationTitle(access: InvocationAccess): string {
  return t("skills.access.title") + "\n" +
    t("skills.access.model") + "：" + modelAccessText(access) + "\n" +
    t("skills.access.user") + "：" + userAccessText(access);
}

/* ---------------- 格式化 ---------------- */

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = index === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${units[index]}`;
}

/** ISO 时间 → 本地「YYYY-MM-DD HH:mm」（解析不了就原样返回）。 */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (input: number): string => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function eolLabel(eol: SkillSummary["format"]["eol"]): string {
  if (eol === "crlf") return t("skills.detail.eol.crlf");
  if (eol === "mixed") return t("skills.detail.eol.mixed");
  return t("skills.detail.eol.lf");
}

export function trashReasonLabel(reason: TrashReason): string {
  if (reason === "update") return t("skills.trash.reason.update");
  if (reason === "replace") return t("skills.trash.reason.replace");
  return t("skills.trash.reason.delete");
}

/* ---------------- 列表的局部更新 ---------------- */

/** 启停成功后只替换这一行（PLAN 验收 U2：局部更新，不整表刷新）。 */
export function replaceSkill(list: ListResult, skill: SkillSummary): ListResult {
  const found = list.skills.some((item) => item.id === skill.id);
  return {
    ...list,
    skills: found ? list.skills.map((item) => (item.id === skill.id ? skill : item)) : [...list.skills, skill],
  };
}

/** 删除成功后把这一行摘掉。 */
export function removeSkill(list: ListResult, id: string): ListResult {
  return { ...list, skills: list.skills.filter((item) => item.id !== id) };
}

/* ---------------- 文件清单 ---------------- */

/** 文件清单排序：目录在前、同级按名字（保证「树」的观感）。 */
export function sortFiles(files: readonly SkillViewFile[]): SkillViewFile[] {
  return [...files].sort((left, right) => {
    if (left.isDir !== right.isDir) return left.isDir ? -1 : 1;
    const leftDepth = left.path.split("/").length;
    const rightDepth = right.path.split("/").length;
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    return left.path.localeCompare(right.path);
  });
}

/** 相对路径的层级（缩进用）。 */
export function fileDepth(path: string): number {
  let depth = 0;
  for (const char of path) if (char === "/") depth += 1;
  return depth;
}

/** 文件清单里最后一段名字。 */
export function fileName(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? path : path.slice(at + 1);
}

/** 回收站排序：时间倒序（解析不了的时间排最后，保持稳定）。 */
export function sortTrash(items: readonly TrashItem[]): TrashItem[] {
  return [...items].sort((left, right) => {
    const leftTime = new Date(left.deletedAt).getTime();
    const rightTime = new Date(right.deletedAt).getTime();
    const leftValid = !Number.isNaN(leftTime);
    const rightValid = !Number.isNaN(rightTime);
    if (leftValid && rightValid) return rightTime - leftTime;
    if (leftValid) return -1;
    if (rightValid) return 1;
    return 0;
  });
}

/* ---------------- 错误映射 ---------------- */

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function errorDetails(error: unknown): unknown {
  if (error === null || typeof error !== "object") return undefined;
  return (error as { details?: unknown }).details;
}

/** 服务端 VALIDATION 的 details → 逐字段消息（没有就返回空数组）。 */
export function fieldErrors(error: unknown): FieldError[] {
  const details = errorDetails(error);
  if (!Array.isArray(details)) return [];
  const out: FieldError[] = [];
  for (const entry of details) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const field = typeof record.path === "string" ? record.path : typeof record.field === "string" ? record.field : undefined;
    const message = typeof record.message === "string" ? record.message : undefined;
    if (field === undefined || message === undefined) continue;
    out.push({ path: field, message });
  }
  return out;
}

/** 是否是「原路径已存在」的冲突（恢复时的替换流程要靠它区分）。 */
export function isConflict(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "CONFLICT") return true;
  return errorMessage(error).includes("已存在");
}
