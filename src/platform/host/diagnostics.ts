/**
 * 启动报告（boot.json）里的「技能目录来源」一节：技能目录为什么是现在这几个。
 *
 * 只读、永不抛错。技能目录拿不到时只能记空，但「为什么拿不到」要能看出来：
 * 是来源被停用、表达式推不出来，还是组合树的形状变了（DSH 升级后先看这里）。
 */

import { compositionTree, type EntryTreeNode } from "./composition.ts";
import type { SkillProviderScan } from "./skill-roots.ts";

export interface SkillSourceDiagnostics {
  /** 逐来源的贡献、去重后的目录、预设表达式的推导过程 */
  skillProviders: SkillProviderScan;
  /** 组合树的结构快照（3 层，每层最多 40 个） */
  tree: EntryTreeNode | undefined;
  /** 环境变量 DSH_BUNDLED_SKILL_DIR（null = 未设置） */
  bundledEnv: string | null;
}

export function skillSourceDiagnostics(
  ctx: unknown,
  scan: SkillProviderScan,
  env: Record<string, string | undefined> = process.env,
): SkillSourceDiagnostics {
  let tree: EntryTreeNode | undefined;
  try {
    tree = compositionTree(ctx);
  } catch {
    tree = undefined;
  }
  const bundled = env.DSH_BUNDLED_SKILL_DIR;
  return { skillProviders: scan, tree, bundledEnv: typeof bundled === "string" && bundled !== "" ? bundled : null };
}
