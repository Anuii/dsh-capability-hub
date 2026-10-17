/**
 * 提示词（AGENTS.md / CLAUDE.md）的契约（ADR-0002）：只有类型，宿主模块 prompts/files 与界面 prompts/client 共用。
 *
 * 术语：「提示词」= DSH 的 dsh-agent-instructions 加载的 AGENTS.md / CLAUDE.md 一类文件（不叫「指令」「系统提示词」）。
 *
 * DSH 的加载规则（dsh-agent-instructions，已查实）：
 *   - 全局：只有 <dshHome>/AGENTS.md 一个（DSH 不读 ~/.claude/CLAUDE.md、~/.codex/AGENTS.md）；
 *   - 项目：从项目根（自工作区往上第一个含 .git 的目录；没有就是工作区本身）到工作区的每一层目录，
 *     每层依次找 AGENTS.md、CLAUDE.md、AGENTS.local.md、CLAUDE.local.md，存在的都加载；
 *     同一层里去掉首尾空白后内容相同的只保留先出现的那个；
 *   - 顺序：全局 → 项目根 → … → 工作区（越往后越具体）；单个文件超过 1 MiB 不加载；
 *   - 预算：渲染后合计不超过 maxBytes（dsh-base 默认 65536）；超出时先丢最前面的（最宽泛的），
 *     只剩最后一个仍超出时截断它。
 *
 * 路由（相对 /api/dsh-capability-hub/）：
 *   GET  prompts/list?workspace=                      → PromptsListResult
 *   GET  prompts/view?id=&workspace=                  → PromptView
 *   POST prompts/save        { id, content, baseVersion, workspace? }  → { file: PromptFile }
 *        baseVersion 与磁盘当前版本不同 → 409 CONFLICT（文件在别处被改过，界面提示重新加载）；
 *        覆盖前的内容先进插件回收站（reason "save"）。
 *   POST prompts/create      { location, workspace? }  → { file: PromptFile }   只建 AGENTS.md；已存在（含 .disabled）→ 409
 *   POST prompts/set-enabled { id, enabled, workspace? } → { file: PromptFile }
 *        停用 = 原地改名 <原名>.disabled；启用 = 改回；目标名已存在 → 409，什么都不动。
 *   GET  prompts/trash                                → { items: PromptTrashItem[] }
 *   POST prompts/trash/restore { trashId, workspace? } → { file: PromptFile }
 *        把旧内容写回原文件（文件现在是停用状态就写回 .disabled 那个；都不存在就按原名新建）；
 *        写回前当前内容同样先进回收站。
 *   POST prompts/trash/purge   { trashId? }           → { purged: number }   不带 trashId = 清空
 * 安全：id 只能是本次发现出来的提示词路径（全局层或项目根到工作区的某一层里的四个文件名之一，或其 .disabled），
 * 任何别的路径一律 400/404，绝不读写。
 */

/**
 * DSH 认的提示词文件名。
 *
 * **0.8.0 起不再写死**：名字来自 DSH 的组合配置（agent-instructions 条目的
 * instructionFileCandidates 与 localInstructionFileCandidates），本插件与 DSH 用同一份配置；
 * 配置读不到时用 DSH 的默认值 AGENTS.md、CLAUDE.md、AGENTS.local.md、CLAUDE.local.md。
 * 全局层例外：DSH 写死只读 <dshHome>/AGENTS.md。新建只允许 AGENTS.md。
 */
export type PromptFileName = string;

/** 一个提示词文件。 */
export interface PromptFile {
  /** 稳定 id：原名（启用态文件名）的绝对路径；停用时 id 不变 */
  id: string;
  /** 原名 */
  name: PromptFileName;
  /** 当前磁盘上的绝对路径（停用时是 <原名>.disabled） */
  path: string;
  /** 显示路径：全局 "~/.dsh/AGENTS.md"；项目里相对项目根，如 "AGENTS.md"、"packages/a/CLAUDE.md" */
  displayPath: string;
  disabled: boolean;
  size: number;
  mtimeMs: number;
  /** 内容版本（内容 sha256 的前 16 位十六进制），保存时做冲突检测 */
  version: string;
  /** 同一层里去掉首尾空白后与更早的文件相同 → DSH 只加载那一个；值是那个文件的原名 */
  duplicateOf?: PromptFileName;
  /** 超过 DSH 单文件上限（1 MiB），DSH 不加载 */
  tooLarge?: boolean;
  /** 按预算估算会被 DSH 省略或截断（只对启用、非重复、非过大的文件给出） */
  budget?: "omitted" | "truncated";
}

/** 一层：全局，或项目根到工作区之间的某个目录。 */
export interface PromptLayer {
  scope: "global" | "project";
  /** 目录绝对路径 */
  dir: string;
  /** 显示：全局 "~/.dsh"；项目层相对项目根，根本身是 "." */
  displayDir: string;
  isProjectRoot: boolean;
  isWorkspace: boolean;
  /** 按加载顺序（四个文件名的顺序） */
  files: PromptFile[];
  /**
   * 这一层能否新建 AGENTS.md（目录存在，AGENTS.md 在当前候选文件名里，且 AGENTS.md 与
   * AGENTS.md.disabled 都不存在；只有全局、项目根、工作区三层可能为 true）
   */
  canCreate: boolean;
  /**
   * 这一层的目录在 git 仓库里（项目根由 projectRootMarkers 命中）。启停是原地改名，为 true 时
   * 确认框多一句「git 会显示文件被改名」。
   *
   * **全局层恒为 false**：全局提示词在 DSH 主目录里，不属于任何项目，git 不会记录它的改名。
   */
  inGit: boolean;
}

/** GET prompts/list 的 data。 */
export interface PromptsListResult {
  /** 全局层在前，然后从项目根到工作区；没有工作区时只有全局层 */
  layers: PromptLayer[];
  /** 项目根绝对路径（有工作区时） */
  projectRoot?: string;
  budget: {
    /** DSH 的提示词预算（字节） */
    maxBytes: number;
    /** 估算：会加载的文件合计字节（启用、非重复、非过大） */
    usedBytes: number;
    /** maxBytes 来自 DSH 的组合配置，还是取不到时用默认值 65536 */
    source: "dsh-config" | "default";
  };
  /** 当前 profile 里 DSH 的提示词加载被关掉了（组合配置里 agent-instructions 条目 disabled） */
  loaderDisabled?: boolean;
  /** 中文提示（例如工作区目录不存在） */
  warnings: string[];
}

/** GET prompts/view 的 data。 */
export interface PromptView {
  file: PromptFile;
  /** 原文（utf8 解码，保留 BOM 与行尾） */
  content: string;
}

/** 新建位置。 */
export type PromptCreateLocation = "global" | "project-root" | "workspace";

/** 回收站条目（GET prompts/trash 的 items[]）。 */
export interface PromptTrashItem {
  trashId: string;
  /** 被覆盖的那个文件的 id（原名绝对路径） */
  fileId: string;
  displayPath: string;
  reason: "save" | "restore";
  /** ISO 时间 */
  savedAt: string;
  size: number;
}
