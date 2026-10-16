/**
 * 预算估算（纯函数；ADR-0008）。
 *
 * 照契约注释描述的 DSH 规则做近似：
 *   - 只算会加载的文件（启用、非重复、非过大）；
 *   - 每个文件按「内容字节 + 头部」计费，头部近似为 `Instructions from: <displayPath>\n\n`；
 *   - 合计超过 maxBytes 时，从最前（最宽泛的全局层）开始标 omitted，直到剩下的放得下；
 *   - 只剩最后一个仍放不下时标它 truncated。
 *
 * 这是估算（界面会写「约」），不是 DSH 的逐字节实现。规则不 import 任何包，宿主与浏览器都能跑。
 */

import type { PromptFileName } from "../contract/prompts.ts";

/** 会被 DSH 加载的一个候选文件。 */
export interface BudgetCandidate {
  name: PromptFileName;
  /** 显示路径（头部里用的那个） */
  displayPath: string;
  /** 文件内容字节数 */
  bytes: number;
}

export type BudgetMark = "omitted" | "truncated";

export interface BudgetEstimate {
  /** 全部候选文件的估算合计（内容字节 + 每个文件的头部） */
  usedBytes: number;
  /** 与 candidates 等长：每个文件的预算结论（undefined = 照常加载） */
  marks: (BudgetMark | undefined)[];
  /** 被省略的文件数 */
  omitted: number;
  /** 是否有一个文件被截断 */
  truncated: boolean;
}

/** DSH 渲染每个文件时加的头部（近似）。 */
export function instructionHeader(displayPath: string): string {
  return "Instructions from: " + displayPath + "\n\n";
}

/** 字符串的 UTF-8 字节数（TextEncoder 在宿主与浏览器里都是全局对象）。 */
export function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** 一个候选文件的估算成本。 */
export function costOf(candidate: BudgetCandidate): number {
  return candidate.bytes + byteLengthOf(instructionHeader(candidate.displayPath));
}

/** 按上面的规则估算：返回合计与每个文件的预算结论。 */
export function estimateBudget(candidates: readonly BudgetCandidate[], maxBytes: number): BudgetEstimate {
  const costs = candidates.map(costOf);
  const usedBytes = costs.reduce((sum, value) => sum + value, 0);
  const marks: (BudgetMark | undefined)[] = candidates.map(() => undefined);
  let omitted = 0;
  let truncated = false;
  if (usedBytes > maxBytes && candidates.length > 0) {
    let remaining = usedBytes;
    let index = 0;
    // 从最前开始丢，但永远留下最后一个（DSH 至少保留一个文件，超了就截断它）
    while (remaining > maxBytes && index < candidates.length - 1) {
      remaining -= costs[index] ?? 0;
      marks[index] = "omitted";
      omitted += 1;
      index += 1;
    }
    if (remaining > maxBytes) {
      marks[index] = "truncated";
      truncated = true;
    }
  }
  return { usedBytes, marks, omitted, truncated };
}
