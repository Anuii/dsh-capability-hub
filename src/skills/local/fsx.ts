/**
 * 文件系统底座：路径存在性、原子写、整目录/整文件移动、递归枚举。
 * 只依赖 node: 内置模块。
 */

import fs from "node:fs/promises";
import path from "node:path";

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function statOrUndefined(p: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.stat(p);
  } catch {
    return undefined;
  }
}

export interface ReadTextResult {
  /** 原始字节 */
  buffer: Buffer;
  /** 按 UTF-8 解码（非法字节以 U+FFFD 替代） */
  text: string;
  /** 是否是合法 UTF-8 */
  validUtf8: boolean;
  mtimeMs: number;
}

export async function readFileText(p: string): Promise<ReadTextResult | undefined> {
  let buffer: Buffer;
  let st: import("node:fs").Stats;
  try {
    buffer = await fs.readFile(p);
    st = await fs.stat(p);
  } catch {
    return undefined;
  }
  let validUtf8 = true;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    validUtf8 = false;
    text = buffer.toString("utf8");
  }
  return { buffer, text, validUtf8, mtimeMs: st.mtimeMs };
}

/** 同目录临时文件 + rename 的原子写；失败清理临时文件。 */
export async function atomicWriteFile(file: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const suffix = `${process.pid.toString(36)}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(dir, `.${base}.${suffix}.tmp`);
  const handle = await fs.open(tmp, "wx");
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

/** 递归复制（保留目录结构；不跟随符号链接）。 */
export async function copyPath(src: string, dest: string): Promise<void> {
  const st = await fs.lstat(src);
  if (st.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src);
    for (const name of entries) await copyPath(path.join(src, name), path.join(dest, name));
    return;
  }
  if (st.isSymbolicLink()) {
    const target = await fs.readlink(src);
    await fs.symlink(target, dest);
    return;
  }
  await fs.copyFile(src, dest);
}

export async function removePath(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

/** 整个条目（目录或文件）移动到 dest；跨盘时复制后删除。返回是否走了复制回退。 */
export async function movePath(src: string, dest: string): Promise<{ copied: boolean }> {
  try {
    await fs.rename(src, dest);
    return { copied: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw error;
    await copyPath(src, dest);
    await removePath(src);
    return { copied: true };
  }
}

export interface WalkEntry {
  /** 相对 root 的路径，/ 分隔 */
  path: string;
  size: number;
  isDir: boolean;
}

export interface WalkOptions {
  /** 最多返回多少项 */
  max: number;
  /** 这些目录名整体跳过（既不列出也不深入） */
  skipDirs?: string[];
  /** 最大深度，防御性上限 */
  maxDepth?: number;
}

/** 递归枚举目录内容（含子目录项本身）。不深入符号链接目录，避免环。 */
export async function walkEntries(root: string, options: WalkOptions): Promise<WalkEntry[]> {
  const skip = new Set(options.skipDirs ?? []);
  const maxDepth = options.maxDepth ?? 12;
  const out: WalkEntry[] = [];

  async function visit(dir: string, prefix: string, depth: number): Promise<void> {
    if (out.length >= options.max || depth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= options.max) return;
      if (skip.has(entry.name)) continue;
      const childRel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const childAbs = path.join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isLink = entry.isSymbolicLink();
      let size = 0;
      if (isLink) {
        const st = await statOrUndefined(childAbs);
        isDir = st?.isDirectory() ?? false;
        size = st?.isFile() ? Number(st.size) : 0;
      } else if (entry.isFile()) {
        const st = await statOrUndefined(childAbs);
        size = st ? Number(st.size) : 0;
      }
      out.push({ path: childRel, size, isDir });
      if (isDir && !isLink) await visit(childAbs, childRel, depth + 1);
    }
  }

  await visit(root, "", 1);
  return out;
}
