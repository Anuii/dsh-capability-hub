/**
 * 提示词的设置形状（宿主模块自己的类型，ADR-0001 规则 1）。
 *
 * 谁来填：**外壳**（src/platform/host/prompt-settings.ts）读 DSH 的组合配置，按这里的形状
 * 经依赖注入交给本模块（modules.ts 是唯一的接线点）。形状声明放在模块里，外壳 import 它 ——
 * 这样「怎么读 DSH 配置」是外壳的职责，而「读出来的东西长什么样」只有一份定义。
 *
 * 五项都来自 DSH 的 dsh-agent-instructions 条目 config（读不到用 rules/names.ts 里的默认值）：
 *   instructionFileCandidates / localInstructionFileCandidates / projectRootMarkers / maxBytes / maxSourceBytes。
 * 全局层例外：DSH 写死只读 <dshHome>/AGENTS.md，与本设置无关。
 */

import {
  DEFAULT_INSTRUCTION_FILE_CANDIDATES,
  DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_SOURCE_BYTES,
  DEFAULT_PROJECT_ROOT_MARKERS,
  candidateNames,
} from "../rules/names.ts";

/** 一个配置来源（health / 诊断用）。 */
export interface PromptSettingsContribution {
  /** preset-spec = agent 预设的插件声明；entry = 组合树里的真实条目 */
  kind: "preset-spec" | "entry";
  id: string;
  /** preset-spec 时承载它的预设条目 id */
  parent?: string;
  disabled: boolean;
  /** 该来源是否被采用 */
  used: boolean;
  note?: string;
}

/** 提示词设置（外壳读 DSH 组合配置的结果）。 */
export interface PromptSettings {
  /** 项目层每层的查找顺序（instructionFileCandidates 接 localInstructionFileCandidates） */
  fileNames: string[];
  instructionFileCandidates: string[];
  localInstructionFileCandidates: string[];
  /** 往上找项目根时认这些标记（文件或目录都算） */
  projectRootMarkers: string[];
  maxBytes: number;
  maxSourceBytes: number;
  /** maxBytes 来自组合配置还是默认值 */
  source: "dsh-config" | "default";
  /**
   * 当前 profile 里所有 agent 预设都没有启用的 agent-instructions 条目
   * （例如 minimal 预设）：DSH 不会加载任何提示词。根层那条 disabled 不作数。
   */
  loaderDisabled: boolean;
  /** 中文说明（health 与界面 warnings 用） */
  notes: string[];
  contributions: PromptSettingsContribution[];
}

/** 默认设置：DSH 的 dsh-agent-instructions 源码默认值（拿不到 loader / 配置里没写时用）。 */
export function defaultPromptSettings(): PromptSettings {
  const instructionFileCandidates = [...DEFAULT_INSTRUCTION_FILE_CANDIDATES];
  const localInstructionFileCandidates = [...DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES];
  return {
    fileNames: candidateNames({ instructionFileCandidates, localInstructionFileCandidates }),
    instructionFileCandidates,
    localInstructionFileCandidates,
    projectRootMarkers: [...DEFAULT_PROJECT_ROOT_MARKERS],
    maxBytes: DEFAULT_MAX_BYTES,
    maxSourceBytes: DEFAULT_MAX_SOURCE_BYTES,
    source: "default",
    loaderDisabled: true,
    notes: [],
    contributions: [],
  };
}
