/**
 * 宿主各模块共用的文件小工具（只给宿主用：import 规则禁止界面引用 shared/node/）。
 *
 * atomicWriteFile 是唯一的「写一个文件」方式：同目录隐藏临时文件 → 写入 → 刷盘 → rename（同卷原子）。
 * 读方要么看到旧文件，要么看到新文件，绝不会看到写了一半的；失败时清掉临时文件，不掩盖原始错误。
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

/** 读 UTF-8 文本；不存在或读不了返回 undefined。 */
export async function readTextFile(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

/** 删除文件或整个目录；不存在不算错。 */
export async function removePath(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true });
}

export interface AtomicWriteOptions {
  /** 新文件的权限；含敏感值的文件用 0o600（Windows 上基本不生效，但在别的系统上要对） */
  mode?: number;
}

/** 原子写（见文件头）；父目录不存在时先建。 */
export async function atomicWriteFile(
  file: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const dir = path.dirname(file);
  const suffix =
    process.pid.toString(36) + "." + Date.now().toString(36) + "." + Math.random().toString(36).slice(2, 8);
  const tmp = path.join(dir, "." + path.basename(file) + "." + suffix + ".tmp");
  await fs.mkdir(dir, { recursive: true });
  const handle = await fs.open(tmp, "wx", options.mode);
  try {
    await handle.writeFile(data);
    // 有的文件系统不支持 fsync：刷盘失败不拦写入
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
