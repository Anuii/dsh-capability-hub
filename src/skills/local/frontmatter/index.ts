/**
 * SKILL.md frontmatter：判断（evaluate）与「只改一行」的启停改写（rewriteDisableModelInvocation）。
 *
 * YAML 用 DSH 自带的同一个 yaml 库（外壳加载后注入，ADR-0006）：DSH 能不能加载一个技能，
 * 这里的判断就与它一致。内部分层：document.ts（字节与行）→ yaml-block.ts（yaml 解析 + 改写闸门）
 * → rules.ts（DSH 的校验链与中文诊断）/ toggle.ts（改写）。
 */

import type { Buffer } from "node:buffer";
import type { YamlLib } from "../../contract/yaml.ts";
import { evaluate, type EvaluationResult } from "./rules.ts";
import { rewriteDisableModelInvocation, type ToggleResult } from "./toggle.ts";

export interface Frontmatter {
  evaluate(buffer: Buffer): EvaluationResult;
  rewriteDisableModelInvocation(buffer: Buffer, enabled: boolean): ToggleResult;
}

export function createFrontmatter(yaml: YamlLib): Frontmatter {
  return {
    evaluate: (buffer) => evaluate(yaml, buffer),
    rewriteDisableModelInvocation: (buffer, enabled) => rewriteDisableModelInvocation(yaml, buffer, enabled),
  };
}

export { SKILL_NAME_PATTERN, KNOWN_KEYS } from "./rules.ts";
export type { EvaluationResult } from "./rules.ts";
export type { ToggleResult } from "./toggle.ts";
