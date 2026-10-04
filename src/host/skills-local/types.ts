/**
 * skills-local 对外契约类型（PLAN §3.1 / §3.3）。
 *
 * 按 PLAN §2「功能模块之间不得互相 import；需要的类型在自己目录内按本契约结构化定义」，
 * 这里按契约逐字段结构化定义，不 import T0 或其他模块的类型。
 */

export type DiagnosticLevel = 'error' | 'warning' | 'info';

/** 一条体检/诊断记录。code 稳定（可编程判断），message 为中文、可直接展示给用户。 */
export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
}

export type RootId = string;

/** 文件格式特征（决定能否安全地「只改一行」）。 */
export interface SkillFormat {
  /** 全文行尾风格；同时出现 CRLF 与裸 LF 时为 mixed */
  eol: 'lf' | 'crlf' | 'mixed';
  /** 文件是否以 UTF-8 BOM 开头（DSH 官方会因此完全忽略该技能） */
  bom: boolean;
  /** 是否可以用「只改一行」的方式安全改写 frontmatter */
  safeToToggle: boolean;
}

export interface SkillSummary {
  /** "<rootId>:<dirName>"，例如 "user-agents:grilling" */
  id: string;
  rootId: RootId;
  dirName: string;
  /** 技能目录绝对路径；平铺 .md 技能为该 .md 文件本身的绝对路径 */
  path: string;
  name?: string;
  description?: string;
  /** 所在根是否可写（决定能否启停/删除） */
  writable: boolean;
  /** 解析后的 disable-model-invocation（缺省 false） */
  modelInvocationDisabled: boolean;
  /** 解析后的 user-invocable；键不存在时为 null */
  userInvocable: boolean | null;
  /** 按 DSH 官方规则能否被加载 */
  loadable: boolean;
  /** loadable && !modelInvocationDisabled && !shadowedBy */
  modelVisible: boolean;
  /** 被哪个技能遮蔽（跨根同名，优先级小者胜）——值是被遮蔽者的对手 id */
  shadowedBy?: string;
  diagnostics: Diagnostic[];
  format: SkillFormat;
  /** DSH 不认识的 frontmatter 键（如 argument-hint、license），改写时绝不删除 */
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

export type TrashReason = 'delete' | 'update' | 'replace';

export interface TrashItem {
  trashId: string;
  skillId: string;
  rootId: RootId;
  dirName: string;
  originalPath: string;
  name?: string;
  reason: TrashReason;
  deletedAt: string;
  hasLockEntry: boolean;
}

/** 由 skills-remote（T2）实现，接线时注入 skills-local。 */
export interface LockStash {
  /** 移除并返回原条目 */
  take(skill: { rootId: string; dirName: string; path: string }): Promise<unknown | undefined>;
  /** 原样放回（覆盖） */
  put(skill: { rootId: string; dirName: string; path: string }, entry: unknown): Promise<void>;
}

export interface SkillViewFile {
  /** 相对技能目录的路径，统一用 / 分隔 */
  path: string;
  size: number;
  isDir: boolean;
}

export interface SkillView {
  skill: SkillSummary;
  /** SKILL.md 原文（保留 BOM / CRLF 等原始字节的 utf8 解码结果） */
  content: string;
  files: SkillViewFile[];
}

export interface ListResult {
  roots: RootInfo[];
  skills: SkillSummary[];
  warnings: string[];
}

export interface MoveToTrashOptions {
  workspace?: string;
  reason: TrashReason;
  /** reason=update/replace 时由调用方传入；reason=delete 时忽略（自己去 take） */
  lockEntry?: unknown;
}

export interface SkillsLocalApi {
  list(opts: { workspace?: string }): Promise<ListResult>;
  get(id: string, opts: { workspace?: string }): Promise<SkillSummary | undefined>;
  setEnabled(id: string, enabled: boolean, opts: { workspace?: string }): Promise<SkillSummary>;
  moveToTrash(id: string, opts: MoveToTrashOptions): Promise<TrashItem>;
  /** reason=delete：自己调用 LockStash.take 并把条目存进回收站；reason=update/replace：使用调用方传入的 lockEntry */
  rootPath(rootId: RootId, opts: { workspace?: string }): string | undefined;
  /** 查看：SKILL.md 原文 + 目录文件清单 */
  view(id: string, opts: { workspace?: string }): Promise<SkillView>;
  trashList(): Promise<TrashItem[]>;
  restore(trashId: string, opts: { replace?: boolean; workspace?: string }): Promise<SkillSummary>;
  purge(trashId?: string): Promise<number>;
}

/* ---- 宿主上下文（PLAN §3.1） ---- */

export interface HubLogger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export interface HubContext {
  /** 默认 os.homedir()；dev profile 用 devOverrides.homeDir 指向夹具 */
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
