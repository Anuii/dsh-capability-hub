/**
 * 文件系统小工具：原子写、目录创建、大小写不敏感路径比较。
 * 运行时只用 node: 内置模块。
 */
import { mkdir, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
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
