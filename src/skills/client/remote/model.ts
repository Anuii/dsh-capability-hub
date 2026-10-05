/**
 * 「远程部分」的**纯逻辑**：来源展示、更新状态、安装目标、候选分组、结果汇总。
 *
 * 这里刻意不碰 DOM、不碰 React、不发请求：全部可以用 node:test 直接测
 * （见 test/skills/client/remote-model.test.ts）。文案一律走 ../strings.ts 的 t()，
 * 所以测试断言的是界面上真正会出现的字。
 */

import { isFlatSkill } from "../format.ts";
import { t } from "../strings.ts";
import type { RootInfo, SkillSummary } from "../types.ts";
import type {
  AuthMode,
  Confidence,
  DiscoverCandidate,
  InstallItemResult,
  InstallTarget,
  SourceEntry,
  UpdateApplyItem,
  UpdateCheckItem,
  UpdateStatus,
} from "./types.ts";

/* ---------------- 平铺 .md 技能 ---------------- */

/**
 * 平铺技能的判定共用本地部分的 isFlatSkill（format.ts 是唯一实现，避免两份正则走偏）。
 * 调度者决定：平铺技能的「来源登记 / 检查更新 / 更新」宿主侧不支持，界面直接说明并不发请求。
 */
export { isFlatSkill };

/** 平铺技能的说明（界面上必须显示这句，别让用户白点）。 */
export function flatUnsupportedText(): string {
  return t("skills.remote.flat.unsupported");
}

/* ---------------- 来源展示 ---------------- */

export function storeLabel(store: SourceEntry["store"]): string {
  return store === "skill-lock" ? t("skills.remote.source.storeLock") : t("skills.remote.source.storeHub");
}

/** 来源标题：`repo@ref`（没有 ref 时只有 repo）。 */
export function sourceRepoRef(entry: { repo: string; ref?: string }): string {
  return entry.ref === undefined || entry.ref === "" ? entry.repo : `${entry.repo}@${entry.ref}`;
}

/** 有来源时悬停显示的明细（含记录位置与时间）。 */
export function sourceTitle(entry: SourceEntry): string {
  return t("skills.remote.source.title", {
    repo: sourceRepoRef(entry),
    path: entry.skillPath,
    store: storeLabel(entry.store),
    updated: entry.updatedAt === undefined ? t("skills.detail.none") : entry.updatedAt,
  });
}

/* ---------------- 更新状态 ---------------- */

export function updateStatusLabel(status: UpdateStatus | undefined): string {
  switch (status) {
    case "up-to-date":
      return t("skills.remote.update.status.upToDate");
    case "update-available":
      return t("skills.remote.update.status.available");
    case "no-source":
      return t("skills.remote.update.status.noSource");
    case "error":
      return t("skills.remote.update.status.error");
    default:
      return t("skills.remote.update.status.unknown");
  }
}

/**
 * 状态 → kit Badge 的 tone。
 * UI-DESIGN §0.4：强调色只给「可更新」；最新是中性；出错是红；无来源是中性。
 */
export function updateStatusBadgeTone(status: UpdateStatus | undefined): "neutral" | "accent" | "danger" {
  if (status === "update-available") return "accent";
  if (status === "error") return "danger";
  return "neutral";
}

/** 状态的悬停说明：优先用服务端给的中文 message，没有就用界面自带的解释。 */
export function updateStatusTitle(item: UpdateCheckItem | undefined): string | undefined {
  if (item === undefined) return undefined;
  if (item.message !== undefined && item.message !== "") return item.message;
  switch (item.status) {
    case "up-to-date":
      return t("skills.remote.update.upToDateHint");
    case "update-available":
      return t("skills.remote.update.availableHint");
    case "no-source":
      return t("skills.remote.update.noSourceHint");
    default:
      return undefined;
  }
}

export function authModeLabel(mode: AuthMode | undefined): string {
  switch (mode) {
    case "env":
      return t("skills.remote.auth.env");
    case "gh":
      return t("skills.remote.auth.gh");
    case "anonymous":
      return t("skills.remote.auth.anonymous");
    default:
      return t("skills.remote.auth.unknown");
  }
}

/** 剩余配额的值（标签由调用方给：详情里是 KeyValue 的一行，菜单里拼在一句话里）。 */
export function quotaValue(remaining: number | undefined): string {
  return typeof remaining === "number" ? String(remaining) : t("skills.remote.quotaUnknownShort");
}

/** 「检查更新」的结果统计（工具栏用）。 */
export interface CheckSummary {
  available: number;
  upToDate: number;
  noSource: number;
  error: number;
  total: number;
}

export function summarizeChecks(items: readonly UpdateCheckItem[]): CheckSummary {
  const summary: CheckSummary = { available: 0, upToDate: 0, noSource: 0, error: 0, total: items.length };
  for (const item of items) {
    if (item.status === "update-available") summary.available += 1;
    else if (item.status === "up-to-date") summary.upToDate += 1;
    else if (item.status === "no-source") summary.noSource += 1;
    else summary.error += 1;
  }
  return summary;
}

export function checkSummaryText(summary: CheckSummary): string {
  return t("skills.remote.bar.checkSummary", {
    available: summary.available,
    upToDate: summary.upToDate,
    noSource: summary.noSource,
    error: summary.error,
  });
}

export interface ApplySummary {
  ok: number;
  failed: number;
  total: number;
}

export function summarizeApplies(items: readonly UpdateApplyItem[]): ApplySummary {
  let ok = 0;
  let failed = 0;
  for (const item of items) {
    if (item.ok) ok += 1;
    else failed += 1;
  }
  return { ok, failed, total: items.length };
}

export function applySummaryText(summary: ApplySummary): string {
  return t("skills.remote.bar.updateSummary", { ok: summary.ok, failed: summary.failed });
}

/* ---------------- 候选来源 ---------------- */

export function confidenceLabel(confidence: Confidence): string {
  switch (confidence) {
    case "high":
      return t("skills.remote.source.confidence.high");
    case "medium":
      return t("skills.remote.source.confidence.medium");
    case "low":
      return t("skills.remote.source.confidence.low");
  }
}

/** kit Badge 只认 neutral / accent / warn / danger —— 置信度标记用中性的两档。 */
export function confidenceBadgeTone(confidence: Confidence): "neutral" | "warn" {
  return confidence === "medium" ? "warn" : "neutral";
}

/** 候选的唯一键（勾选集合用它，前端不去猜后端 id）。 */
export function candidateKey(candidate: DiscoverCandidate): string {
  return `${candidate.skillId}|${candidate.repo.toLowerCase()}|${candidate.ref ?? ""}|${candidate.skillPath}`;
}

/**
 * 候选里的 skillPath 只有在「仓库内相对路径」时才能直接用。
 * 宿主对「技能目录里出现链接」这类候选返回的是**本机绝对路径**（缺陷，见回报 D-2），
 * 直接登记会把本机路径写进来源记录、之后更新必然找不到上游 —— 这里统一退回「<目录名>/SKILL.md」。
 */
export function candidateSkillPath(candidate: { skillPath: string }, dirName: string): string {
  const value = typeof candidate.skillPath === "string" ? candidate.skillPath.trim() : "";
  const looksLocal = value === "" || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\");
  return looksLocal ? `${dirName}/SKILL.md` : value;
}

export interface CandidateGroup {
  skillId: string;
  candidates: DiscoverCandidate[];
}

/** 候选按技能分组（组内保持宿主给的置信度顺序）。 */
export function groupCandidates(candidates: readonly DiscoverCandidate[]): CandidateGroup[] {
  const groups = new Map<string, DiscoverCandidate[]>();
  for (const candidate of candidates) {
    const list = groups.get(candidate.skillId);
    if (list === undefined) groups.set(candidate.skillId, [candidate]);
    else list.push(candidate);
  }
  return [...groups.entries()].map(([skillId, list]) => ({ skillId, candidates: list }));
}

/* ---------------- 安装目标 ---------------- */

export interface InstallTargetOption {
  id: InstallTarget;
  label: string;
  /** 目标根的完整路径（从 GET skills/list 的 roots 里取；取不到则 undefined） */
  path?: string;
  /** 不可选时的原因（例如没有工作区） */
  blocked?: string;
}

export function targetLabel(target: InstallTarget): string {
  switch (target) {
    case "user-agents":
      return t("skills.install.targetUserAgents");
    case "user-dsh":
      return t("skills.install.targetUserDsh");
    case "project-agents":
      return t("skills.install.targetProjectAgents");
    case "project-dsh":
      return t("skills.install.targetProjectDsh");
  }
}

/** 安装目标列表：用户级恒有，项目级只在有工作区时出现（D-B6）。 */
export function installTargetOptions(roots: readonly RootInfo[], workspace: string | undefined): InstallTargetOption[] {
  const hasWorkspace = typeof workspace === "string" && workspace.trim() !== "";
  const order: InstallTarget[] = hasWorkspace
    ? ["user-agents", "user-dsh", "project-agents", "project-dsh"]
    : ["user-agents", "user-dsh"];
  return order.map((id) => {
    const root = roots.find((item) => item.rootId === id);
    const option: InstallTargetOption = { id, label: targetLabel(id) };
    if (root !== undefined) option.path = root.path;
    return option;
  });
}

/* ---------------- 安装结果 ---------------- */

export function installResultText(result: InstallItemResult): string {
  if (result.ok) return t("skills.install.resultOk", { id: result.skillId ?? result.skillPath });
  return t("skills.install.resultFail", { message: result.message ?? t("skills.detail.none") });
}

export function installSummaryText(ok: number, failed: number): string {
  return t("skills.install.done", { ok, failed });
}

/* ---------------- 与列表的交叉计算 ---------------- */

/**
 * 找出某个技能的来源条目。
 *
 * 为什么不能直接用 sources[skill.id]：宿主对「仓库根级 SKILL.md」这类 skillPath 会把
 * 条目的 skillId 派生成 `<rootId>:SKILL.md`（lockstore.ts 的 lockEntryToSourceEntry 在
 * skillPath 没有目录段时取了文件名），于是精确 id 对不上、界面会误显示「无来源」。
 * 这里按「同根 + skillPath 的父目录名 == dirName」兜底，保证来源照常显示。
 * （宿主侧缺陷已在回报里给出证据，客户端不再跟着错。）
 */
export function findSourceFor(
  skill: { id: string; rootId: string; dirName: string },
  sources: Readonly<Record<string, SourceEntry>>,
): SourceEntry | undefined {
  const exact = sources[skill.id];
  if (exact !== undefined) return exact;
  const prefix = `${skill.rootId}:`;
  for (const entry of Object.values(sources)) {
    if (!entry.skillId.startsWith(prefix)) continue;
    const segments = entry.skillPath.split("/").filter((part) => part !== "");
    const parent = segments.length >= 2 ? segments[segments.length - 2] : undefined;
    if (parent !== undefined && parent.toLowerCase() === skill.dirName.toLowerCase()) return entry;
  }
  return undefined;
}

/** 已经登记过来源的技能 id 集合（用容错匹配，和界面显示保持一致）。 */
export function sourceIdsOf(
  skills: readonly SkillSummary[],
  sources: Readonly<Record<string, SourceEntry>>,
): Set<string> {
  const ids = new Set<string>();
  for (const skill of skills) {
    if (findSourceFor(skill, sources) !== undefined) ids.add(skill.id);
  }
  return ids;
}

/** 需要（且可以）推测来源的技能：可写 + 非平铺 + 当前没有来源记录。 */
export function skillsNeedingSource(
  skills: readonly SkillSummary[],
  sourceIds: ReadonlySet<string>,
): SkillSummary[] {
  return skills.filter((skill) => skill.writable && !isFlatSkill(skill) && !sourceIds.has(skill.id));
}

/** 有更新、可以「全部更新」的技能 id（顺序与列表一致）。 */
export function updatableIds(
  skills: readonly SkillSummary[],
  checks: Readonly<Record<string, { status: UpdateStatus }>>,
): string[] {
  const ids: string[] = [];
  for (const skill of skills) {
    if (isFlatSkill(skill)) continue;
    if (checks[skill.id]?.status === "update-available") ids.push(skill.id);
  }
  return ids;
}
