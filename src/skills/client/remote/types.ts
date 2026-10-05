/**
 * 宿主 skills-remote 契约的**客户端镜像**（PLAN §3.7 的远程组）。
 *
 * 为什么不 import 宿主类型：宿主半与浏览器半是两份产物（PLAN §2：功能模块之间不得互相 import）。
 * 这里按 HTTP 请求/响应逐字段复制，源头是 src/skills/remote/{types,routes}.ts —— 改契约时两处一起改。
 */

/* ---------------- 来源记录 ---------------- */

export type SourceStoreKind = "skill-lock" | "hub";

/** GET skills/sources → entries[]。 */
export interface SourceEntry {
  skillId: string;
  /** owner/name */
  repo: string;
  ref?: string;
  /** 仓库内 SKILL.md 路径 */
  skillPath: string;
  store: SourceStoreKind;
  installedAt?: string;
  updatedAt?: string;
  skillFolderHash?: string;
  /** lock 里有记录、但本机找不到对应技能目录（UI 需要提示） */
  orphan?: boolean;
}

/* ---------------- 仓库浏览 ---------------- */

export interface BrowseSkill {
  skillPath: string;
  dirName: string;
  name?: string;
  description?: string;
  /** 本机已安装时的 skillId */
  installedId?: string;
}

export interface BrowseResult {
  repo: string;
  ref: string;
  skills: BrowseSkill[];
}

export interface RepoRecord {
  repo: string;
  ref?: string;
  /** 只在这个子目录下发现技能（0.3.0） */
  subPath?: string;
  preset: boolean;
}

/* ---------------- 汇总发现（D-B16，0.3.0） ---------------- */

/** GET skills/discovery 的 repos[]：一个仓库的配置 + 上次扫描结果。 */
export interface DiscoveryRepoView {
  repo: string;
  ref?: string;
  subPath?: string;
  preset: boolean;
  /** 从未扫描过时没有 */
  scannedAt?: string;
  resolvedRef?: string;
  skillCount?: number;
  /** 上次扫描失败的原因（中文，已打码） */
  error?: string;
  /** 缓存是按旧的分支 / 子目录扫的 */
  stale?: boolean;
}

/** 汇总里的一个技能。 */
export interface DiscoveredSkill {
  skillPath: string;
  dirName: string;
  name?: string;
  description?: string;
  repo: string;
  /** 安装时带的分支 */
  ref?: string;
  installedId?: string;
}

export interface DiscoveryView {
  /** false = 从未扫描过（打开视图时自动扫一次） */
  cached: boolean;
  lastScannedAt?: string;
  repos: DiscoveryRepoView[];
  skills: DiscoveredSkill[];
}

/* ---------------- 来源推测 ---------------- */

export type Confidence = "high" | "medium" | "low";

export interface DiscoverCandidate {
  skillId: string;
  repo: string;
  ref?: string;
  skillPath: string;
  confidence: Confidence;
  reason: string;
}

/* ---------------- 检查更新 / 应用更新 ---------------- */

export type UpdateStatus = "up-to-date" | "update-available" | "no-source" | "error";

export interface UpdateCheckItem {
  skillId: string;
  status: UpdateStatus;
  message?: string;
}

export type AuthMode = "env" | "gh" | "anonymous";

export interface UpdateCheckResult {
  results: UpdateCheckItem[];
  auth: AuthMode;
  rateLimitRemaining?: number;
}

export interface UpdateApplyItem {
  skillId: string;
  ok: boolean;
  message?: string;
  trashId?: string;
}

export interface UpdateApplyResult {
  results: UpdateApplyItem[];
}

/* ---------------- 安装 / 搜索 ---------------- */

export type InstallTarget = "user-agents" | "user-dsh" | "project-agents" | "project-dsh";

export interface InstallItemResult {
  skillPath: string;
  ok: boolean;
  skillId?: string;
  message?: string;
}

export interface SearchResultItem {
  name: string;
  description?: string;
  repo: string;
  skillPath?: string;
  installs?: number;
}

export interface GithubAuth {
  mode: AuthMode;
  rateLimitRemaining?: number;
}
