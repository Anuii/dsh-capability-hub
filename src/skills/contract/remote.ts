/**
 * 远程技能（skills-remote）的 HTTP 契约（ADR-0002）：只有类型，宿主路由与客户端共用。
 */

/** 来源记录存在哪：npx skills 的 lock（~/.agents/.skill-lock.json）或插件自己的 sources.json。 */
export type SourceStoreKind = "skill-lock" | "hub";

/** 一条来源记录（GET skills/sources 的 entries[]）。 */
export interface SourceEntry {
  skillId: string;
  /** owner/name */
  repo: string;
  ref?: string;
  /** 仓库内 SKILL.md 路径，与 npx skills lock 同义 */
  skillPath: string;
  store: SourceStoreKind;
  installedAt?: string;
  updatedAt?: string;
  skillFolderHash?: string;
  /** 只在 GET skills/sources 里出现：lock 里有记录、但本机找不到对应技能目录 */
  orphan?: boolean;
}

/** 仓库列表里的一个仓库（GET skills/repos）。 */
export interface RepoRecord {
  repo: string;
  ref?: string;
  /** 只在仓库的这个子目录下发现技能（相对路径，正斜杠，不带首尾斜杠） */
  subPath?: string;
  preset: boolean;
}

/** 临时浏览一个仓库时的一个技能（POST skills/repo/browse）。 */
export interface BrowseSkill {
  skillPath: string;
  dirName: string;
  name?: string;
  description?: string;
  installedId?: string;
}

export interface BrowseResult {
  repo: string;
  ref: string;
  skills: BrowseSkill[];
}

/** 发现缓存里的一个技能（不含「是否已安装」——那个每次读取时现算）。 */
export interface DiscoverySkill {
  skillPath: string;
  dirName: string;
  name?: string;
  description?: string;
}

/** GET skills/discovery 里的一个仓库条目。 */
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

/** 汇总发现里的一个技能。 */
export interface DiscoveredSkill extends DiscoverySkill {
  repo: string;
  /** 安装时要带的分支（实际解析到的分支） */
  ref?: string;
  installedId?: string;
}

/** POST skills/repos/add · update · remove 的 data：新的仓库列表与发现视图（宿主已补扫）。 */
export interface RepoChange {
  repos: RepoRecord[];
  discovery: DiscoveryView;
}

/** GET skills/discovery 与 POST skills/discovery/refresh 的 data。 */
export interface DiscoveryView {
  /** false = 从未扫描过任何仓库（客户端据此自动扫一次） */
  cached: boolean;
  lastScannedAt?: string;
  repos: DiscoveryRepoView[];
  skills: DiscoveredSkill[];
}

export type Confidence = "high" | "medium" | "low";

/** 为无来源技能推测的候选来源（POST skills/sources/discover）。 */
export interface DiscoverCandidate {
  skillId: string;
  repo: string;
  ref?: string;
  skillPath: string;
  confidence: Confidence;
  reason: string;
}

export type UpdateStatus = "up-to-date" | "update-available" | "no-source" | "error";

export interface UpdateCheckItem {
  skillId: string;
  status: UpdateStatus;
  message?: string;
}

/** GitHub 凭据模式（只有模式，绝不含令牌）。 */
export type AuthMode = "env" | "gh" | "anonymous";

/** POST skills/updates/check 的 data。 */
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

/** POST skills/updates/apply 的 data。 */
export interface UpdateApplyResult {
  results: UpdateApplyItem[];
}

/** 安装位置。 */
export type InstallTarget = "user-agents" | "user-dsh" | "project-agents" | "project-dsh";

export interface InstallItemResult {
  skillPath: string;
  ok: boolean;
  skillId?: string;
  message?: string;
}

/** GET skills/search 的一条结果（skills.sh）。 */
export interface SearchResultItem {
  name: string;
  description?: string;
  repo: string;
  skillPath?: string;
  installs?: number;
}

/** GET skills/github-auth 的 data。 */
export interface GithubAuth {
  mode: AuthMode;
  rateLimitRemaining?: number;
}
