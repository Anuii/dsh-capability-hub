/**
 * 提示词模块自己的文件小工具。
 *
 * 两条口径（与 DSH / 契约注释对齐）：
 *   1. 读取按 UTF-8 解码，**保留 BOM**（Buffer.toString("utf8") 不会吃掉 U+FEFF），
 *      行尾原样保留；界面拿到的原文可以逐字节写回。
 *   2. 版本 = 内容字节的 sha256 前 16 位十六进制；过大的文件用流式哈希，不把内容读进内存。
 */

import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const VERSION_LENGTH = 16;

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 内容版本：sha256 前 16 位十六进制。 */
export function versionOf(data: Buffer | string): string {
  return sha256Hex(data).slice(0, VERSION_LENGTH);
}

export interface RawRead {
  buffer: Buffer;
  /** UTF-8 解码的原文（保留 BOM） */
  text: string;
  size: number;
  mtimeMs: number;
}

/** 读一个普通文件的原始字节与原文；读不到（不存在、是目录、没权限）返回 undefined。 */
export async function readRaw(file: string): Promise<RawRead | undefined> {
  let buffer: Buffer;
  let stat: import("node:fs").Stats;
  try {
    buffer = await fs.readFile(file);
    stat = await fs.stat(file);
  } catch {
    return undefined;
  }
  return { buffer, text: buffer.toString("utf8"), size: buffer.length, mtimeMs: stat.mtimeMs };
}

/** 流式算内容版本（常量内存），供超过 1 MiB 的文件用。 */
export async function streamedVersion(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex").slice(0, VERSION_LENGTH);
}

/** 跟随符号链接的 stat；拿不到返回 undefined。 */
export async function statFollow(file: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.stat(file);
  } catch {
    return undefined;
  }
}

/** 是否是普通文件（符号链接跟随；目录不算）。 */
export async function isRegularFile(file: string): Promise<boolean> {
  const stat = await statFollow(file);
  return stat !== undefined && stat.isFile();
}

/** 是否是目录（符号链接跟随）。 */
export async function isDirectory(file: string): Promise<boolean> {
  const stat = await statFollow(file);
  return stat !== undefined && stat.isDirectory();
}
