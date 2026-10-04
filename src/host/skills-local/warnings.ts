/**
 * 外部工具接管检测（D-B11）。
 *
 * 设计原则：只报告有证据的信号，宁缺毋滥 —— 不能仅凭「目录里有 SKILL.md」就报警。
 * 参考 F6 §Q5.1 特别提醒：CC Switch 自 v3.13.0 起可把技能主副本放到 ~/.agents/skills
 * 并用软链接/复制分发到各应用目录，会与本插件形成写冲突。
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import type { HubContext } from './types.ts';
import type { RootSpec } from './scan.ts';

export interface ExternalManagementInput {
  ctx: HubContext;
  specs: RootSpec[];
  /** 根本身是链接的 rootId 集合 */
  linkedRoots: Set<string>;
  /** skillId -> 链接目标 */
  linkedSkills: Map<string, string>;
}

interface CcSwitchSettings {
  skillStorageLocation?: string;
  skillSyncMethod?: string;
}

async function readCcSwitchSettings(homeDir: string): Promise<CcSwitchSettings | undefined> {
  try {
    const text = await fs.readFile(path.join(homeDir, '.cc-switch', 'settings.json'), 'utf8');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const out: CcSwitchSettings = {};
    if (typeof parsed.skillStorageLocation === 'string') out.skillStorageLocation = parsed.skillStorageLocation;
    if (typeof parsed.skillSyncMethod === 'string') out.skillSyncMethod = parsed.skillSyncMethod;
    return out;
  } catch {
    return undefined;
  }
}

/** 判断某个技能根是否落在 CC Switch 的统一存储位置上。 */
function isUnifiedAgentsRoot(spec: RootSpec, homeDir: string): boolean {
  const target = path.resolve(path.join(homeDir, '.agents', 'skills'));
  return path.resolve(spec.path).toLowerCase() === target.toLowerCase();
}

export async function collectWarnings(input: ExternalManagementInput): Promise<string[]> {
  const out: string[] = [];
  const { ctx, specs } = input;

  for (const spec of specs) {
    if (!input.linkedRoots.has(spec.rootId)) continue;
    let target = '';
    try {
      target = await fs.readlink(spec.path);
    } catch {
      target = '未知目标';
    }
    out.push(
      '技能根「' + spec.path + '」是一个指向「' + target + '」的符号链接/目录联接。' +
        '这通常意味着该目录被外部工具（如 CC Switch 的存储位置切换）接管，' +
        '本插件对其中技能的启停与删除会真实作用在链接目标上，请确认后再操作。',
    );
  }

  if (input.linkedSkills.size > 0) {
    const samples = [...input.linkedSkills.keys()].slice(0, 5).join('、');
    const more = input.linkedSkills.size > 5 ? ' 等 ' + String(input.linkedSkills.size) + ' 个' : '';
    out.push('检测到技能目录是符号链接/目录联接：' + samples + more + '。这些技能可能由外部工具（如 CC Switch）分发，改动会写入链接目标。');
  }

  const cc = await readCcSwitchSettings(ctx.homeDir);
  if (cc !== undefined && cc.skillStorageLocation === 'unified') {
    const affected = specs.filter((s) => isUnifiedAgentsRoot(s, ctx.homeDir));
    if (affected.length > 0) {
      const method = cc.skillSyncMethod === 'symlink' ? '软链接' : cc.skillSyncMethod === 'copy' ? '复制' : '自动（软链接优先）';
      out.push(
        '检测到 CC Switch 正在使用「统一」技能存储位置（' + affected[0].path + '），同步方式为' + method + '。' +
          '该工具会自行同步/覆盖技能目录，与本插件的启停状态可能互相覆盖。' +
          '建议只在一处管理这些技能，或在 CC Switch 中切换存储位置避开该目录。',
      );
    }
  }

  return out;
}
