/**
 * 本地技能（skills-local）的契约（ADR-0002）：只有类型。
 *
 * 用在两条 seam 上：
 *   - HTTP：GET skills/list · skills/view · skills/trash 等的响应形状，客户端（src/skills/client）直接用；
 *   - 进程内：外壳把 SkillsLocalApi 注入远程技能模块，把 LockStash 注入本地技能模块。
 */

export type DiagnosticLevel = "error" | "warning" | "info";

/** 一条体检记录。code 稳定（可编程判断），message 为中文、可直接展示。 */
export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
}

/** 技能目录 id：user-agents / user-dsh / project-agents / project-dsh / custom-<n> / bundled。 */
export type RootId = string;

/** 文件格式特征（决定能否安全地「只改一行」）。 */
export interface SkillFormat {
  /** 全文行尾风格；同时出现 CRLF 与裸 LF 时为 mixed */
  eol: "lf" | "crlf" | "mixed";
  /** 文件是否以 UTF-8 BOM 开头（DSH 会因此完全忽略该技能） */
  bom: boolean;
  /** 是否可以用「只改一行」的方式安全改写 frontmatter */
  safeToToggle: boolean;
}

/** 一个技能（GET skills/list 的 skills[]）。 */
export interface SkillSummary {
  /** "<rootId>:<dirName>"，例如 "user-agents:grilling" */
  id: string;
  rootId: RootId;
  dirName: string;
  /** 技能目录绝对路径；平铺技能为该 .md 文件本身的绝对路径 */
  path: string;
  name?: string;
  description?: string;
  /** 所在技能目录是否可写（决定能否启停 / 删除） */
  writable: boolean;
  /** 解析后的 disable-model-invocation（缺省 false） */
  modelInvocationDisabled: boolean;
  /** 解析后的 user-invocable；键不存在时为 null */
  userInvocable: boolean | null;
  /** 按 DSH 的规则能否被加载 */
  loadable: boolean;
  /** loadable && !modelInvocationDisabled && !shadowedBy */
  modelVisible: boolean;
  /** 被哪个技能遮蔽（跨技能目录同名，优先级高者胜） */
  shadowedBy?: string;
  diagnostics: Diagnostic[];
  format: SkillFormat;
  /** DSH 不认识的 frontmatter 键（如 argument-hint、license），改写时绝不删除 */
  extraKeys: string[];
  mtimeMs: number;
}

/** 一个技能目录（GET skills/list 的 roots[]）。 */
export interface RootInfo {
  rootId: RootId;
  path: string;
  exists: boolean;
  writable: boolean;
  precedence: number;
}

/** GET skills/list 的 data。 */
export interface ListResult {
  roots: RootInfo[];
  skills: SkillSummary[];
  warnings: string[];
}

export type TrashReason = "delete" | "update" | "replace";

/** 回收站条目（GET skills/trash 的 items[]）。 */
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

/** 查看面板里的一个文件条目。 */
export interface SkillViewFile {
  /** 相对技能目录的路径，统一用 / 分隔 */
  path: string;
  size: number;
  isDir: boolean;
}

/** GET skills/view 的 data。 */
export interface SkillView {
  skill: SkillSummary;
  /** SKILL.md 原文（保留 BOM / CRLF 的 utf8 解码结果） */
  content: string;
  files: SkillViewFile[];
}

/** 远程技能模块实现、注入本地技能模块：删除 / 恢复技能时把 npx skills 的 lock 条目一起取走 / 放回。 */
export interface LockStash {
  /** 移除并返回原条目 */
  take(skill: { rootId: string; dirName: string; path: string }): Promise<unknown | undefined>;
  /** 原样放回（覆盖） */
  put(skill: { rootId: string; dirName: string; path: string }, entry: unknown): Promise<void>;
}

export interface MoveToTrashOptions {
  workspace?: string;
  reason: TrashReason;
  /** reason=update/replace 时由调用方传入；reason=delete 时忽略（本地技能模块自己去 take） */
  lockEntry?: unknown;
}

/** 本地技能模块的进程内接口（外壳注入远程技能模块）。 */
export interface SkillsLocalApi {
  list(opts: { workspace?: string }): Promise<ListResult>;
  get(id: string, opts: { workspace?: string }): Promise<SkillSummary | undefined>;
  setEnabled(id: string, enabled: boolean, opts: { workspace?: string }): Promise<SkillSummary>;
  moveToTrash(id: string, opts: MoveToTrashOptions): Promise<TrashItem>;
  rootPath(rootId: RootId, opts: { workspace?: string }): string | undefined;
  /** 查看：SKILL.md 原文 + 目录文件清单 */
  view(id: string, opts: { workspace?: string }): Promise<SkillView>;
  trashList(): Promise<TrashItem[]>;
  restore(trashId: string, opts: { replace?: boolean; workspace?: string }): Promise<SkillSummary>;
  purge(trashId?: string): Promise<number>;
}
