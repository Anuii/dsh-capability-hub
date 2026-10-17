/**
 * 提示词页客户端单测的夹具（纯数据，不碰 DOM / 网络）。
 *
 * 形状以 src/prompts/contract/prompts.ts 为准：这里只造数据，不改契约。
 */

import type {
  PromptFile,
  PromptLayer,
  PromptFileName,
  PromptsListResult,
} from "../../../src/prompts/contract/prompts.ts";

/** 造一个提示词文件（默认：启用、500 字节、有版本）。 */
export function makeFile(overrides: Partial<PromptFile> = {}): PromptFile {
  const name: PromptFileName = overrides.name ?? "AGENTS.md";
  const id = overrides.id ?? "C:\\proj\\" + name;
  return {
    id,
    name,
    path: overrides.path ?? id,
    displayPath: overrides.displayPath ?? name,
    disabled: false,
    size: 500,
    mtimeMs: 1_700_000_000_000,
    version: "0123456789abcdef",
    ...overrides,
  };
}

/** 造一层（默认：项目根，一个 AGENTS.md）。 */
export function makeLayer(overrides: Partial<PromptLayer> = {}): PromptLayer {
  const files = overrides.files ?? [makeFile()];
  return {
    scope: "project",
    dir: "C:\\proj",
    displayDir: ".",
    isProjectRoot: true,
    isWorkspace: false,
    canCreate: false,
    inGit: false,
    ...overrides,
    files,
  };
}

/** 造一份列表结果（默认：全局一层 + 项目根一层）。 */
export function makeList(overrides: Partial<PromptsListResult> = {}): PromptsListResult {
  return {
    layers: [
      makeLayer({
        scope: "global",
        dir: "C:\\home\\.dsh",
        displayDir: "~/.dsh",
        isProjectRoot: false,
        files: [
          makeFile({
            id: "C:\\home\\.dsh\\AGENTS.md",
            path: "C:\\home\\.dsh\\AGENTS.md",
            displayPath: "~/.dsh/AGENTS.md",
          }),
        ],
        canCreate: true,
      }),
      makeLayer({ inGit: true }),
    ],
    projectRoot: "C:\\proj",
    budget: { maxBytes: 65536, usedBytes: 500, source: "dsh-config" },
    warnings: [],
    ...overrides,
  };
}
