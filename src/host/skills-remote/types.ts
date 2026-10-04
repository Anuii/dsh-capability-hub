/**
 * skills-remote（T2）对外契约类型（PLAN §3.1 / §3.4）。
 *
 * 按 PLAN §2「功能模块之间不得互相 import；需要的类型在自己目录内按本契约结构化定义」，
 * 这里逐字段结构化重现 HubContext / SkillsLocalApi / LockStash，不 import T0、T1 的代码。
 */

/* ---------- 宿主上下文（PLAN §3.1） ---------- */

export interface HubLogger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export interface HubContext {
  /** 默认 os.homedir()；dev profile 用插件配置 devOverrides.homeDir 指向夹具 */
  homeDir: string;
  /** DSH 数据根（默认 <homeDir>/.dsh） */
  dshHome: string;
  /** <dshHome>/storages/dsh-capability-hub */
  hubHome: string;
  profileName: string;
  logger: HubLogger;
  /** 只读根，可为空数组 */
  customSkillDirs: string[];
  /** 只读根，可缺失 */
  bundledSkillDir?: string;
}

export interface RouteRequest {
  query: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
}

export type RouteHandler = (req: RouteRequest) => Promise<unknown>;

export interface HubModule {
  routes: Record<string, RouteHandler>;
  dispose?(): void | Promise<void>;
}

/* ---------- skills-local（PLAN §3.3）的消费子集 ---------- */

export type RootId = string;

export interface Diagnostic {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface SkillSummary {
  id: string;
  rootId: RootId;
  dirName: string;
  path: string;
  name?: string;
  description?: string;
  writable: boolean;
  modelInvocationDisabled: boolean;
  userInvocable: boolean | null;
  loadable: boolean;
  modelVisible: boolean;
  shadowedBy?: string;
  diagnostics: Diagnostic[];
  format: { eol: 'lf' | 'crlf' | 'mixed'; bom: boolean; safeToToggle: boolean };
  extraKeys: string[];
  mtimeMs: number;
}

export interface RootInfo {
  rootId: RootId;
  path: string;
  exists: boolean;
  writable: boolean;
  precedence: number;
}

export interface ListResult {
  roots: RootInfo[];
  skills: SkillSummary[];
  warnings: string[];
}

export interface TrashItem {
  trashId: string;
  skillId: string;
  rootId: RootId;
  dirName: string;
  originalPath: string;
  name?: string;
  reason: 'delete' | 'update' | 'replace';
  deletedAt: string;
  hasLockEntry: boolean;
}

/** 由 skills-remote 实现，接线时注入 skills-local。 */
export interface LockStash {
  take(skill: { rootId: string; dirName: string; path: string }): Promise<unknown | undefined>;
  put(skill: { rootId: string; dirName: string; path: string }, entry: unknown): Promise<void>;
}

export interface SkillsLocalApi {
  list(opts: { workspace?: string }): Promise<ListResult>;
  get(id: string, opts: { workspace?: string }): Promise<SkillSummary | undefined>;
  setEnabled(id: string, enabled: boolean, opts: { workspace?: string }): Promise<SkillSummary>;
  moveToTrash(
    id: string,
    opts: { workspace?: string; reason: 'delete' | 'update' | 'replace'; lockEntry?: unknown }
  ): Promise<TrashItem>;
  rootPath(rootId: RootId, opts: { workspace?: string }): string | undefined;
  /** 恢复回收站条目（T2 的「更新失败回滚」需要；实际由 T1 实现，测试用假实现） */
  restore(trashId: string, opts: { replace?: boolean; workspace?: string }): Promise<SkillSummary>;
}

/* ---------- skills-remote 自身（PLAN §3.4 / §3.7） ---------- */

export type SourceStoreKind = 'skill-lock' | 'hub';

/** 契约 §3.4 的对外条目 */
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
}

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

export interface RepoRecord {
  repo: string;
  ref?: string;
  preset: boolean;
}

export interface RepoReposFile {
  version: number;
  repos: RepoRecord[];
  [key: string]: unknown;
}

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

export interface DiscoverCandidate {
  skillId: string;
  repo: string;
  ref?: string;
  skillPath: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export type UpdateStatus = 'up-to-date' | 'update-available' | 'no-source' | 'error';

export interface UpdateCheckItem {
  skillId: string;
  status: UpdateStatus;
  message?: string;
}

export interface UpdateCheckResult {
  results: UpdateCheckItem[];
  auth: 'env' | 'gh' | 'anonymous';
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

export type InstallTarget = 'user-agents' | 'user-dsh' | 'project-agents' | 'project-dsh';

/** 需要项目级根的目标 */
export const PROJECT_TARGETS: InstallTarget[] = ['project-agents', 'project-dsh'];

/** 与 npx skills 的 lock 写在同一位置的根（其余根写 hubHome/skills/sources.json） */
export const LOCK_BACKED_ROOT = 'user-agents';

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