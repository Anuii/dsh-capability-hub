/**
 * 外部工具接管检测（D-B11）。
 *
 * 设计原则：只报告有证据的信号，宁缺毋滥 —— 不能仅凭「目录里有 SKILL.md」就报警。
 *
 * 0.9.0 起这里只保留两条**通用**的符号链接警告：技能根是链接、技能是链接。
 * 原先「读某个第三方工具的配置文件判断统一存储」的专属检测已移除：它绑定具体工具，
 * 工具一改名/换格式就失效，还会给出不准确的推断。文案也不再指向具体工具，一律说「外部工具」。
 */

import fs from "node:fs/promises";
import type { HubContext } from "../../platform/contract/host.ts";
import type { RootSpec } from "./scan.ts";

export interface ExternalManagementInput {
  /**
   * 宿主上下文。0.9.0 起本文件不再读 homeDir 下的任何第三方配置，
   * 保留这个字段是因为调用方（api.ts）仍按此契约传参。
   */
  ctx: HubContext;
  specs: RootSpec[];
  /** 根本身是链接的 rootId 集合 */
  linkedRoots: Set<string>;
  /** skillId -> 链接目标 */
  linkedSkills: Map<string, string>;
}

export async function collectWarnings(input: ExternalManagementInput): Promise<string[]> {
  const out: string[] = [];
  const { specs } = input;

  for (const spec of specs) {
    if (!input.linkedRoots.has(spec.rootId)) continue;
    let target = "";
    try {
      target = await fs.readlink(spec.path);
    } catch {
      target = "未知目标";
    }
    out.push(
      "技能根「" +
        spec.path +
        "」是一个指向「" +
        target +
        "」的符号链接/目录联接。" +
        "这通常意味着该目录被外部工具接管，" +
        "本插件对其中技能的启停与删除会真实作用在链接目标上，请确认后再操作。",
    );
  }

  if (input.linkedSkills.size > 0) {
    const samples = [...input.linkedSkills.keys()].slice(0, 5).join("、");
    const more = input.linkedSkills.size > 5 ? " 等 " + String(input.linkedSkills.size) + " 个" : "";
    out.push(
      "检测到技能目录是符号链接/目录联接：" + samples + more + "。这些技能可能由外部工具分发，改动会写入链接目标。",
    );
  }

  return out;
}
