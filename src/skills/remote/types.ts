/**
 * 远程技能模块内部的类型：磁盘文件形状（lock、sources.json、仓库列表、发现缓存）与注入点。
 * HTTP 形状在 ../contract/remote.ts，宿主上下文在 platform/contract/host.ts（ADR-0002）。
 */

import type { SkillsLocalApi as LocalApi } from "../contract/local.ts";
import type { RepoRecord, DiscoverySkill, InstallTarget } from "../contract/remote.ts";

/** 远程技能模块用到的本地技能接口子集（外壳注入；测试用假实现）。 */
export type SkillsLocalPort = Pick<LocalApi, "list" | "get" | "setEnabled" | "moveToTrash" | "rootPath" | "restore">;

/* ---------- skills-remote 自身（PLAN §3.4 / §3.7） ---------- */

/** hubHome/skills/sources.json 中一条记录的完整形态（含定位信息） */
export interface HubStoreEntry {
  skillId: string;
  rootId: string;
  dirName: string;
  repo: string;
  ref?: string;
  skillPath: string;
  skillFolderHash?: string;
  installedAt?: string;
  updatedAt?: string;
}

/** <homeDir>/.agents/.skill-lock.json 的结构（npx skills v3；未知字段原样保留） */
export interface SkillLockEntry {
  source: string;
  sourceType: string;
  sourceUrl: string;
  ref?: string;
  skillPath?: string;
  /** upsert 在上游未给出目录哈希时会把这个键整个移出（读侧同样按可缺失处理） */
  skillFolderHash?: string;
  installedAt: string;
  updatedAt: string;
  pluginName?: string;
  sourceBaseUrl?: string;
  wellKnownDigest?: string;
  [key: string]: unknown;
}

export interface SkillLockFile {
  version: number;
  skills: Record<string, SkillLockEntry>;
  [key: string]: unknown;
}

/** <hubHome>/skills/sources.json 的结构 */
export interface HubStoreFile {
  version: number;
  /** key = "<rootId>/<dirName>" */
  entries: Record<string, HubStoreEntry>;
  [key: string]: unknown;
}

export interface RepoReposFile {
  version: number;
  repos: RepoRecord[];
  [key: string]: unknown;
}

/** 发现缓存里一个仓库的上次扫描结果（<hubHome>/skills/discovery.json） */
export interface DiscoveryCacheEntry {
  repo: string;
  /** 扫描时使用的配置（与仓库列表当前配置不同 → stale） */
  ref?: string;
  subPath?: string;
  /** 实际解析到的分支（未配置分支时是默认分支） */
  resolvedRef?: string;
  scannedAt: string;
  skills: DiscoverySkill[];
  /** 本次扫描失败的中文原因（已打码）；失败时 skills 为空 */
  error?: string;
}

export interface DiscoveryCacheFile {
  version: number;
  /** key = 仓库名小写 */
  repos: Record<string, DiscoveryCacheEntry>;
  [key: string]: unknown;
}

/** 需要项目级根的目标 */
export const PROJECT_TARGETS: InstallTarget[] = ["project-agents", "project-dsh"];

/** 与 npx skills 的 lock 写在同一位置的根（其余根写 hubHome/skills/sources.json） */
export const LOCK_BACKED_ROOT = "user-agents";

/**
 * 工厂第三可选参数：注入点（测试与宿主替换用）。
 * 契约要求 createSkillsRemoteModule(ctx, deps) 可用，所以这里全部可选。
 */
export interface RemoteOptions {
  /** 替换全局 fetch（测试用假实现） */
  fetchImpl?: typeof fetch;
  /** 注入 gh 令牌提供者（默认执行 gh auth token，5 秒超时） */
  ghTokenProvider?: () => Promise<string | undefined>;
  /** 注入 GITHUB_TOKEN 读取（默认读环境变量） */
  envTokenProvider?: () => string | undefined;
  /** 时钟（测试用） */
  now?: () => Date;
  /** 凭据缓存开关，默认 true */
  cacheAuth?: boolean;
}
