/**
 * 文件系统底座：存在性判断、原子写、目录复制、递归枚举。
 * 只依赖 node: 内置模块。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPathInsideDirectory, safeRelativePath } from './safepath.ts';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** 同目录临时文件 + rename 的原子写；失败清理临时文件。 */
export async function atomicWriteFile(file: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const suffix = `${process.pid.toString(36)}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(dir, `.${base}.${suffix}.tmp`);
  await fs.mkdir(dir, { recursive: true });
  const handle = await fs.open(tmp, 'wx');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    try {
      await fs.unlink(tmp);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw error;
  }
}

export async function removePath(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

export async function readJsonFile<T>(p: string): Promise<T | undefined> {
  const text = await readTextFile(p);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** 写入一份 JSON（2 空格缩进，和 npx skills 的写盘形态一致，不带末尾换行）。 */
export async function writeJsonFile(p: string, value: unknown): Promise<void> {
  await atomicWriteFile(p, JSON.stringify(value, null, 2));
}

/** 递归枚举普通文件（相对路径统一 / 分隔），跳过 skipDirs（任意层级）。 */
export interface WalkedFile {
  rel: string;
  abs: string;
}

export async function walkFiles(root: string, skipDirs: string[] = ['.git', 'node_modules']): Promise<WalkedFile[]> {
  const skip = new Set(skipDirs);
  const out: WalkedFile[] = [];

  async function visit(dir: string, prefix: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        await visit(childAbs, childRel);
      } else if (entry.isFile()) {
        out.push({ rel: childRel, abs: childAbs });
      }
    }
  }

  await visit(root, '');
  return out;
}

/**
 * 把 tar 中某个技能目录的文件写盘（覆盖式；调用方保证目标目录此前不存在或已清空）。
 *
 * FIX-5：**先校验、后写盘** —— 先把全部条目校验完（相对路径安全 + 目标确实落在 targetDir 内），
 * 只有全部合格才开始创建目录与写文件。任何一条不合格就抛 UPSTREAM，此时**一个文件都不写**、
 * 一个目录都不建（避免留下半成品目录）。安装的 destDir 与更新的 staging/targetDir 都走这里。
 */
export async function writeDirectoryFiles(
  targetDir: string,
  files: { rel: string; data: Buffer }[]
): Promise<void> {
  const root = path.resolve(targetDir);
  // 第一遍：只校验，不落盘
  const planned: { abs: string; data: Buffer }[] = [];
  for (const file of files) {
    safeRelativePath(file.rel, '待写入的文件路径');
    const abs = path.join(root, ...file.rel.split('/'));
    assertPathInsideDirectory(root, abs, '待写入的文件路径');
    planned.push({ abs, data: file.data });
  }
  // 第二遍：全部合格才写
  await fs.mkdir(root, { recursive: true });
  for (const item of planned) {
    await fs.mkdir(path.dirname(item.abs), { recursive: true });
    await fs.writeFile(item.abs, item.data);
  }
}