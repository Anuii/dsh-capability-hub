/**
 * 宿主 skills-local 契约的**客户端镜像**（PLAN §3.7 的 HTTP 形状）。
 *
 * 为什么不 import 宿主类型：宿主半与浏览器半是两份产物，客户端不应该把 Node 侧模块
 * 拉进 bundle（PLAN §2：功能模块之间不得互相 import）。这里按 HTTP 响应逐字段复制，
 * 源头是 src/host/skills-local/types.ts 与 module.ts —— 改契约时两处一起改。
 */

export type DiagnosticLevel = "error" | "warning" | "info";

/** 一条体检记录。code 稳定，message 是可直接展示的中文。 */
export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
}

export type RootId = string;

/** 文件格式特征（决定能否「只改一行」启停）。 */
export interface SkillFormat {
  eol: "lf" | "crlf" | "mixed";
  bom: boolean;
  safeToToggle: boolean;
}

/** 一个技能（GET skills/list 的 skills[]）。 */
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
  format: SkillFormat;
  extraKeys: string[];
  mtimeMs: number;
}

/** 一个技能根（GET skills/list 的 roots[]）。 */
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

/** 回收站条目。 */
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
  path: string;
  size: number;
  isDir: boolean;
}

/** GET skills/view 的 data。 */
export interface SkillView {
  skill: SkillSummary;
  /** SKILL.md 原文（保留 BOM / CRLF 的原始解码结果） */
  content: string;
  files: SkillViewFile[];
}
