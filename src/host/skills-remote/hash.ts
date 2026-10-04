/**
 * 目录内容 SHA-256 —— 与 npx skills CLI 的 computeSkillFolderHash 语义一致。
 *
 * 算法（复刻自 vercel-labs/skills src/local-lock.ts:145-184，本地 clone 逐行核对）：
 *   递归收集技能目录下的普通文件（跳过任意层级的 .git 与 node_modules）→ 按相对路径
 *   `localeCompare` 排序 → 依次 hash.update(relativePath)、hash.update(content) → hex。
 *   相对路径统一 / 分隔。
 *
 * ★ 重要事实（本任务实测确认，F6-Q3 未提到）：npx skills 在 Windows 上安装时用的是
 *   git clone（core.autocrlf=true），落盘内容被转成 CRLF；而 GitHub codeload 的 tar.gz
 *   里是仓库原始字节（本机 mattpocock/skills 原始就是 LF）。两者字节不同，内容哈希必不同。
 *   实测：把上游 tar 内的文件先做 LF→CRLF 规范化，再套上述算法，
 *   本机 ~/.agents/.skill-lock.json 的 6 条 skillFolderHash **6/6 吻合**。
 *
 * 因此本项目采用如下判定（判定与记录分离，见 hash.ts 的 describeFolderHash）：
 *   - 计算哈希时同时算 two 份：raw（字节原样）与 normalized（文本文件 LF→CRLF，与 npx skills 落盘一致）
 *   - 记录（写 lock）时写 normalized —— 与 npx skills 兼容，它下次 check 不会误判
 *   - 比较时只要 raw 或 normalized 任一相等，即认为「无更新」—— 既不会因为换行风格
 *     误报「有更新」，也能识别真正的上游改动
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { walkFiles } from './fsx.ts';
import { filesUnderDirectory, type TarEntry } from './tar.ts';

/** 默认跳过清单 —— 与 npx skills 完全一致（只有这两个） */
export const HASH_SKIP_DIRS = ['.git', 'node_modules'];

/** 纯二进制样本判定阈值：前 8000 字节里出现 NUL 即视为二进制 */
const BINARY_SNIFF_BYTES = 8000;

export function isProbablyBinary(data: Buffer): boolean {
  const limit = Math.min(data.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i++) if (data[i] === 0) return true;
  return false;
}

/** LF → CRLF（文本文件用；与 git core.autocrlf=true 的落盘结果一致） */
export function toCrlf(data: Buffer): Buffer {
  const text = data.toString('binary');
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  if (normalized === text) return data;
  return Buffer.from(normalized, 'binary');
}

/** CRLF / 裸 CR → LF */
export function toLf(data: Buffer): Buffer {
  const text = data.toString('binary');
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized === text) return data;
  return Buffer.from(normalized, 'binary');
}

export interface HashFile {
  /** 相对技能目录的路径，/ 分隔 */
  rel: string;
  data: Buffer;
}

function stableSort(files: HashFile[]): HashFile[] {
  return [...files].sort((a, b) => a.rel.localeCompare(b.rel));
}

function sha256Of(files: HashFile[], normalize: 'none' | 'crlf'): string {
  const hash = createHash('sha256');
  for (const file of stableSort(files)) {
    let data = file.data;
    if (normalize === 'crlf' && !isProbablyBinary(data)) data = toCrlf(data);
    hash.update(file.rel);
    hash.update(data);
  }
  return hash.digest('hex');
}

export interface FolderHash {
  /** 原始字节哈希（npx skills 算法在本机 Windows 上的等价形态） */
  raw: string;
  /** 文本文件 LF→CRLF 后的哈希（= npx skills 在 Windows 落盘后的实际值） */
  normalized: string;
  /** 参与哈希的文件数 */
  fileCount: number;
}

export function hashFiles(files: HashFile[]): FolderHash {
  return {
    raw: sha256Of(files, 'none'),
    normalized: sha256Of(files, 'crlf'),
    fileCount: files.length,
  };
}

/** 计算本地目录的内容哈希。 */
export async function hashLocalDirectory(dir: string): Promise<FolderHash> {
  const walked = await walkFiles(dir, HASH_SKIP_DIRS);
  const files: HashFile[] = [];
  for (const file of walked) {
    files.push({ rel: file.rel, data: await readFile(file.abs) });
  }
  return hashFiles(files);
}

/** 计算 tar 内某个技能目录的内容哈希。 */
export function hashTarDirectory(entries: TarEntry[], dir: string): FolderHash {
  const files = filesUnderDirectory(entries, dir).map((f) => ({ rel: f.rel, data: f.data }));
  return hashFiles(files);
}

/**
 * 记录进 lock 的哈希值：优先用 normalized（与 npx skills 兼容），
 * 若上游内容本身不是文本（normalized 与 raw 相同）也自然一致。
 */
export function recordedHash(folder: FolderHash): string {
  return folder.normalized;
}

/** 比较上游与记录值：raw 或 normalized 任一相等即视为无变化。 */
export function hashesEqual(
  upstream: Pick<FolderHash, 'raw' | 'normalized'>,
  recorded: string | undefined
): boolean {
  if (!recorded) return false;
  return upstream.raw === recorded || upstream.normalized === recorded;
}
