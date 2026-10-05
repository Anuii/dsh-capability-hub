/**
 * 启动命令检查（D-C4：只查，不执行）。
 *
 * - 命令含路径分隔符（或盘符、./、../）时：按原样解析（相对路径以 cwd 为基准）后检查文件是否存在。
 * - 否则：在 PATH 的每个目录里依次尝试原命令名与 PATHEXT 后缀，返回第一个命中项。
 */

import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';

import type { CommandCheckOptions } from './types.ts';
import type { CommandCheckResult } from '../contract/config.ts';

export type { CommandCheckOptions } from './types.ts';
export type CheckCommandOptions = CommandCheckOptions;

function splitPathEnv(pathEnv: string | undefined, platform: NodeJS.Platform): string[] {
  if (pathEnv === undefined || pathEnv === '') return [];
  const parts = pathEnv.split(delimiter).filter((p) => p !== '');
  if (platform === 'win32') return parts.map((p) => p.replace(/^"|"$/g, ''));
  return parts;
}

function extensions(raw: string | undefined, platform: NodeJS.Platform): string[] {
  const source = raw === undefined || raw === '' ? (platform === 'win32' ? '.COM;.EXE;.BAT;.CMD' : '') : raw;
  return source
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e !== '')
    .map((e) => (e.startsWith('.') ? e : '.' + e));
}

async function isFile(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    const st = await stat(target);
    return st.isFile();
  } catch {
    return false;
  }
}

/** 带列表式候选的检查，方便测试与诊断。 */
export async function checkCommandCandidates(command: string, opts: CheckCommandOptions = {}): Promise<string[]> {
  const platform = opts.platform ?? process.platform;
  const cwd = opts.cwd ?? process.cwd();
  const trimmed = command.trim();
  if (trimmed === '') return [];

  const hasSeparator = trimmed.includes('/') || trimmed.includes('\\') || isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed);
  const candidates: string[] = [];
  if (hasSeparator) {
    candidates.push(isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed));
    return candidates;
  }

  const wanted = extensions(opts.pathExt ?? process.env.PATHEXT, platform);
  const dirs = splitPathEnv(opts.pathEnv ?? process.env.PATH, platform);
  const lowered = trimmed.toLowerCase();
  const hasKnownExt = wanted.some((ext) => lowered.endsWith(ext.toLowerCase()));
  for (const dir of dirs) {
    candidates.push(join(dir, trimmed));
    if (!hasKnownExt) for (const ext of wanted) candidates.push(join(dir, trimmed + ext));
  }
  return candidates;
}

export async function checkCommand(command: string, opts: CheckCommandOptions = {}): Promise<CommandCheckResult> {
  const candidates = await checkCommandCandidates(command, opts);
  for (const candidate of candidates) {
    if (await isFile(candidate)) return { found: true, resolvedPath: candidate };
  }
  return { found: false };
}

export { sep };
