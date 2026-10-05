/**
 * 文件系统小工具：原子写、目录创建、大小写不敏感路径比较。
 * 运行时只用 node: 内置模块。
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname } from "node:path";
import { errorText } from "../../../shared/error-text.ts";

/** 是否为 Windows（大小写不敏感路径语义）。 */
export const IS_WINDOWS = process.platform === "win32";

/** 路径比较用的规范化形式。 */
export function pathKey(p: string): string {
  const normalized = p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 原子写：先写同目录临时文件再 rename（同卷 rename 是原子的）。
 * 绝不用「截断后直接写」——并发读方会看到半个文件。
 */
export async function atomicWriteFile(filePath: string, text: string, mode = 0o600): Promise<void> {
  await ensureDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmp, "w", mode);
    await handle.writeFile(text, { encoding: "utf8" });
    await handle.sync().catch(() => undefined);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  try {
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true, recursive: false }).catch((err) => {
    throw new Error(`删除文件失败：${path} — ${errorText(err)}`);
  });
}

export interface DirEntryInfo {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  isFile: boolean;
}

export async function listDir(dir: string): Promise<DirEntryInfo[]> {
  const { readdir } = await import("node:fs/promises");
  // readdir 有重载：ReturnType 取到的是 Buffer 版本；这里按默认 encoding（'utf8'）标注为字符串名版本。
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: DirEntryInfo[] = [];
  for (const entry of entries) {
    const full = `${dir}${IS_WINDOWS ? "\\" : "/"}${entry.name}`;
    let size = 0;
    let mtimeMs = 0;
    try {
      const info = await stat(full);
      size = info.size;
      mtimeMs = info.mtimeMs;
    } catch {
      continue;
    }
    result.push({ name: entry.name, path: full, size, mtimeMs, isFile: entry.isFile() });
  }
  return result;
}
