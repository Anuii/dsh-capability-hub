/**
 * 技能形态判定：目录型 vs 平铺 .md（FIX-2）。
 *
 * 背景：
 * skills-local 对「技能根下直接放 <name>.md」的平铺技能，SkillSummary.dirName 是文件名
 * （含 .md），SkillSummary.path 就是那个 .md 文件本身，而不是目录。
 *
 * 调度者决定（FIX-2）：**平铺 .md 技能不支持来源登记、检查更新和更新**，一律给出明确的
 * 中文说明，绝不改动文件。理由：这类技能很少见（用户现有的 31 个技能都是目录型），
 * npx skills 的来源模型以目录为单位，强行支持会引入转换风险。
 *
 * 本文件只做「一个形态判断」，所有调用点复用同一个函数与同一句文案，避免各处各写一份
 * 判断（discover / register / check / apply 四处都依赖它）。
 */

import fs from "node:fs/promises";

/** 平铺技能的统一中文说明（要求 2/4/5 必须逐字一致） */
export const FLAT_SKILL_UNSUPPORTED_MESSAGE =
  "平铺 .md 技能不支持来源登记与更新，只有目录型技能（<名称>/SKILL.md）支持。";

/** 判断形态所需的最小字段（SkillSummary 的子集） */
export interface SkillShape {
  dirName: string;
  path: string;
}

/** 命名形态兜底：dirName 以 .md 结尾（path 读不到时用它判断） */
export function isFlatDirName(dirName: string): boolean {
  return typeof dirName === "string" && /\.md$/i.test(dirName.trim());
}

type PathKind = "file" | "dir" | "missing";

async function pathKind(p: string): Promise<PathKind> {
  if (typeof p !== "string" || p.trim() === "") return "missing";
  try {
    const stats = await fs.stat(p);
    return stats.isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

/**
 * 是不是平铺 .md 技能。
 *   - path 指向**文件** → 是（FIX-1 之后平铺技能的 path 就是那个 .md 文件）
 *   - path 指向**目录** → 不是（即使 dirName 恰好以 .md 结尾）
 *   - path 读不到（技能已被删掉等） → 退回 dirName 的命名形态
 */
export async function isFlatSkill(skill: SkillShape): Promise<boolean> {
  const kind = await pathKind(skill.path);
  if (kind === "file") return true;
  if (kind === "dir") return false;
  return isFlatDirName(skill.dirName);
}
