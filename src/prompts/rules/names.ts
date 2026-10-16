/**
 * 提示词的文件名、项目根标记与默认值（纯函数，宿主与界面共用；ADR-0008）。
 *
 * **名字不写死**：DSH 的 dsh-agent-instructions 条目 config 里给
 *   instructionFileCandidates（默认 ["AGENTS.md","CLAUDE.md"]）、
 *   localInstructionFileCandidates（默认 ["AGENTS.local.md","CLAUDE.local.md"]）、
 *   projectRootMarkers（默认 [".git"]）、maxBytes（默认 65536）、maxSourceBytes（默认 1048576）；
 * 本插件读同一份配置（外壳的 prompt-settings.ts 负责读，经依赖注入交给宿主模块），读不到就用这里的默认值。
 * 全局层例外：DSH 写死只读 <dshHome>/AGENTS.md。
 *
 * 停用 = 原地改名 `<原名>.disabled`（本插件独有的做法，DSH 只认原名）。
 * 只依赖契约里的类型与全局对象，不 import 任何包，宿主与浏览器都能跑。
 */

/** DSH 的默认：项目层先找这些。 */
export const DEFAULT_INSTRUCTION_FILE_CANDIDATES: readonly string[] = ["AGENTS.md", "CLAUDE.md"];
/** DSH 的默认：项目层再找这些（同目录的本地覆盖）。 */
export const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES: readonly string[] = ["AGENTS.local.md", "CLAUDE.local.md"];
/** DSH 的默认：往上找项目根时认这些标记（文件或目录都算）。 */
export const DEFAULT_PROJECT_ROOT_MARKERS: readonly string[] = [".git"];
/** DSH 的默认预算（dsh-base 的 65536）。 */
export const DEFAULT_MAX_BYTES = 65536;
/** DSH 的单文件上限（1 MiB）：超过就不加载。 */
export const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024;

/** 新建只允许这一个文件名。 */
export const CREATE_FILE_NAME = "AGENTS.md";

/** 全局层永远只有这一个（DSH 写死，不读配置）。 */
export const GLOBAL_FILE_NAME = "AGENTS.md";

/** 停用后缀：原地改名 `<原名>.disabled`。 */
export const DISABLED_SUFFIX = ".disabled";

/** 项目层每层的查找顺序 = instructionFileCandidates 再接 localInstructionFileCandidates。 */
export function candidateNames(config: {
  instructionFileCandidates: readonly string[];
  localInstructionFileCandidates: readonly string[];
}): string[] {
  return [...config.instructionFileCandidates, ...config.localInstructionFileCandidates];
}

/** 停用态的文件名。 */
export function disabledNameOf(name: string): string {
  return name + DISABLED_SUFFIX;
}
