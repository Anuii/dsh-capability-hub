/**
 * 技能页的纯逻辑（不碰 DOM、不碰 React、不发请求，node:test 直接测，见 test/skills/client/format.test.ts）：
 * 技能目录（范围、路径缩写、排序）、显示名、搜索与四段筛选（全部 / 已启用 / 已停用 / 需关注）、
 * 诊断级别、格式化、局部更新、错误映射。
 * 「一行技能长什么样」在 row.ts，分组在 tree.ts。文案一律走 strings.ts 的 t()。
 */

import type {
  DiagnosticLevel,
  ListResult,
  RootInfo,
  SkillSummary,
  SkillViewFile,
  TrashItem,
  TrashReason,
} from "../contract/local.ts";
import { t } from "./strings.ts";
import type { BadgeTone } from "../../kit/index.ts";
import type { FieldError } from "../../platform/contract/host.ts";
import { errorText } from "../../shared/error-text.ts";

/* ---------------- 技能根 ---------------- */

export type RootScope = "project" | "user" | "custom" | "bundled";

/** 根 id → 归谁管（D-B2：项目级 / 用户级 / 自定义只读根 / 内置只读根）。 */
export function rootScope(rootId: string): RootScope {
  if (rootId === "project-dsh" || rootId === "project-agents") return "project";
  if (rootId === "user-dsh" || rootId === "user-agents") return "user";
  if (rootId.startsWith("custom-")) return "custom";
  return "bundled";
}

/* ---------------- 路径显示（UI-C） ---------------- */

/** 路径统一成反斜杠分隔（Windows 展示口径），并去掉末尾多余的分隔符。 */
export function normalizePath(path: string): string {
  return path
    .trim()
    .replace(/[\\/]+/g, "\\")
    .replace(/\\+$/, "");
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
    const segments =
      root.rootId === "user-agents"
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

/* ---------------- 分组顺序（UI-C） ---------------- */

/* ---------------- 排序与分组 ---------------- */

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
  const haystack = [skill.name ?? "", skill.dirName, skill.id, skill.description ?? "", skill.rootId]
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

/* ---------------- 诊断级别 ---------------- */

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
    const field =
      typeof record.path === "string" ? record.path : typeof record.field === "string" ? record.field : undefined;
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
  return errorText(error).includes("已存在");
}
