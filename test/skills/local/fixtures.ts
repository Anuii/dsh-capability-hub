/**
 * 测试夹具：全部在 os.tmpdir() 下自建，绝不触碰真实用户目录。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { HubContext, HubLogger, LockStash } from '../../../src/skills/local/types.ts';

export const QUIET_LOGGER: HubLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface TempArea {
  root: string;
  homeDir: string;
  dshHome: string;
  hubHome: string;
  workspace: string;
  cleanup(): Promise<void>;
}

export async function makeTempArea(label: string): Promise<TempArea> {
  const root = path.join(os.tmpdir(), 'abilities-t1', label + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
  const homeDir = path.join(root, 'home');
  const dshHome = path.join(homeDir, '.dsh');
  const hubHome = path.join(dshHome, 'storages', 'dsh-capability-hub');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(hubHome, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  return {
    root,
    homeDir,
    dshHome,
    hubHome,
    workspace,
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

export function makeCtx(area: TempArea, overrides: Partial<HubContext> = {}): HubContext {
  const ctx: HubContext = {
    homeDir: area.homeDir,
    dshHome: area.dshHome,
    hubHome: area.hubHome,
    profileName: 'test',
    logger: QUIET_LOGGER,
    customSkillDirs: [],
  };
  return { ...ctx, ...overrides };
}

export function agentsRoot(area: TempArea): string {
  return path.join(area.homeDir, '.agents', 'skills');
}

export function dshSkillsRoot(area: TempArea): string {
  return path.join(area.dshHome, 'skills');
}

/** 写入技能目录：<root>/<dirName>/SKILL.md（可附加其他文件）。 */
export async function writeSkill(
  root: string,
  dirName: string,
  content: string | Buffer,
  extras: Record<string, string> = {},
): Promise<string> {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), content);
  for (const [rel, text] of Object.entries(extras)) {
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
  return dir;
}

/**
 * 写入平铺技能：<root>/<fileName>（fileName 形如 "solo.md"）。
 * 与官方「一层深：<dir>/SKILL.md 或 <name>.md」中的后者对应。
 */
export async function writeFlatSkill(root: string, fileName: string, content: string | Buffer): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const file = path.join(root, fileName);
  await fs.writeFile(file, content);
  return file;
}

export interface DirFingerprintEntry {
  /** 相对 root 的路径，/ 分隔 */
  rel: string;
  kind: 'dir' | 'file';
  /** 文件内容 sha256（目录没有该字段） */
  sha256?: string;
}

/**
 * 对整个目录做「相对路径 + 类型 + 内容哈希」指纹，
 * 用于断言「除被操作的那一个条目外，其余逐字节不变」。
 */
export async function fingerprintDir(root: string): Promise<DirFingerprintEntry[]> {
  const out: DirFingerprintEntry[] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push({ rel, kind: 'dir' });
        await visit(abs, rel);
      } else {
        out.push({ rel, kind: 'file', sha256: createHash('sha256').update(await fs.readFile(abs)).digest('hex') });
      }
    }
  }
  await visit(root, '');
  return out;
}

export function sha256Of(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function skillMd(name: string, description: string, extraLines: string[] = [], eol = '\n'): string {
  const lines = ['---', 'name: ' + name, 'description: ' + description, ...extraLines, '---', '', '# ' + name];
  return lines.join(eol) + eol;
}

/** 记录 take/put 调用的 LockStash 桩。 */
export interface LockStashStub extends LockStash {
  calls: { op: 'take' | 'put'; rootId: string; dirName: string; path: string; entry?: unknown }[];
  entries: Map<string, unknown>;
}

export function makeLockStashStub(seed: Record<string, unknown> = {}): LockStashStub {
  const entries = new Map<string, unknown>(Object.entries(seed));
  const calls: LockStashStub['calls'] = [];
  return {
    entries,
    calls,
    async take(skill) {
      calls.push({ op: 'take', rootId: skill.rootId, dirName: skill.dirName, path: skill.path });
      const key = skill.rootId + ':' + skill.dirName;
      const entry = entries.get(key);
      entries.delete(key);
      return entry;
    },
    async put(skill, entry) {
      calls.push({ op: 'put', rootId: skill.rootId, dirName: skill.dirName, path: skill.path, entry });
      entries.set(skill.rootId + ':' + skill.dirName, entry);
    },
  };
}

export async function readText(file: string): Promise<string> {
  return await fs.readFile(file, 'utf8');
}

export async function readBytes(file: string): Promise<Buffer> {
  return await fs.readFile(file);
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 找出两个 Buffer 第一处不同的字节下标；完全相同返回 -1。 */
export function firstDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** 把 Buffer 按行切片，便于逐行比对。 */
export function sliceLines(buf: Buffer): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  let start = 0;
  let index = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x0a) {
      out.push({ index: index++, text: buf.subarray(start, i).toString('utf8') });
      start = i + 1;
    }
  }
  if (start < buf.length) out.push({ index, text: buf.subarray(start).toString('utf8') });
  return out;
}
