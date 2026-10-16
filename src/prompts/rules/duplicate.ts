/**
 * 同层重复判定（纯函数；ADR-0008）。
 *
 * DSH 的规则：同一层目录里，去掉首尾空白后内容相同的提示词只加载先出现的那个。
 * 规则本身只比较摘要，不碰内容 —— 摘要由宿主在读文件时算好传进来（规则不 import 任何包）。
 */

import type { PromptFileName } from "../contract/prompts.ts";

/** 参与重复判定的一个文件：DSH 只比较启用、未过大的那些。 */
export interface DuplicateCandidate {
  name: PromptFileName;
  /** 「去掉首尾空白后的内容」的摘要（宿主算） */
  digest: string;
}

/**
 * 按出现顺序返回每个文件的 duplicateOf：
 * 值是同一层里第一个与它摘要相同、且出现更早的文件名；没有就是 undefined。
 */
export function duplicatesOf(candidates: readonly DuplicateCandidate[]): (PromptFileName | undefined)[] {
  const firstSeen = new Map<string, PromptFileName>();
  const out: (PromptFileName | undefined)[] = [];
  for (const candidate of candidates) {
    const earlier = firstSeen.get(candidate.digest);
    if (earlier === undefined) {
      firstSeen.set(candidate.digest, candidate.name);
      out.push(undefined);
    } else {
      out.push(earlier);
    }
  }
  return out;
}
