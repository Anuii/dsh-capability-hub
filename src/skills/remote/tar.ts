/**
 * 最小 tar 读取器（只依赖 node: 内置模块）。
 *
 * 支持范围（覆盖 GitHub codeload tar.gz 的实际形态）：
 *   - ustar 头（512 字节），name(100) + prefix(155) 拼接长路径
 *   - pax 扩展头（type 'x' / 'g'）的 path 记录 —— GNU long name（type 'L'）也支持
 *   - 普通文件（'0' / NUL）、目录（'5'）、符号链接（'2'，仅记录目标，不写盘）
 *   - 八进制与 base-256 的 size 字段
 * 不支持：sparse 文件、加密、多卷 —— codeload 不会产出这些。
 */

import { describeUnsafePath, safeRelativePath } from "./safepath.ts";
import { upstream } from "../../shared/errors.ts";

export const TAR_BLOCK_SIZE = 512;

export interface TarEntry {
  /** 归档内路径，/ 分隔，已剥离 codeload 的 <repo>-<ref>/ 根前缀 */
  path: string;
  /** 目录 / 普通文件 / 符号链接（pax 头不产出条目） */
  type: "file" | "dir" | "symlink";
  /** 普通文件的字节；其余为空 */
  data: Buffer;
  /** 符号链接目标（type=symlink 时有值） */
  linkTarget?: string;
}

function readCString(buf: Buffer): string {
  const idx = buf.indexOf(0);
  const slice = idx === -1 ? buf : buf.subarray(0, idx);
  return slice.toString("utf8");
}

/** 八进制（含前导空格 / 尾随 NUL 与空格）；base-256（高位为 0x80）也支持。 */
function parseNumericField(buf: Buffer): number {
  if (buf.length === 0) return 0;
  if ((buf[0]! & 0x80) !== 0) {
    // base-256
    let value = 0;
    for (let i = 0; i < buf.length; i++) {
      value = value * 256 + (i === 0 ? buf[i]! & 0x7f : buf[i]!);
    }
    return value;
  }
  const text = buf.toString("latin1").replace(/\0/g, " ").trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

/** 解析 pax 扩展头的内容块（记录形如 "<len> <key>=<value>\n"）。 */
export function parsePaxRecords(block: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < block.length) {
    const space = block.indexOf(0x20, offset);
    if (space === -1) break;
    const lenText = block.toString("latin1", offset, space);
    const len = Number.parseInt(lenText, 10);
    if (!Number.isFinite(len) || len <= 0 || offset + len > block.length) break;
    const record = block.toString("utf8", space + 1, offset + len - 1);
    const eq = record.indexOf("=");
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset += len;
  }
  return out;
}

const TYPE_DIR = "5";
const TYPE_FILE = "0";
const TYPE_FILE_ALT = "\0";
const TYPE_SYMLINK = "2";
const TYPE_PAX_LOCAL = "x";
const TYPE_PAX_GLOBAL = "g";
const TYPE_GNU_LONGNAME = "L";

/**
 * 从已解压的 tar 字节里读出全部普通文件、目录与符号链接。
 * 会剥离 GitHub codeload 归档的第一级根目录（形如 "repo-<ref>/"）。
 */
export function readTarEntries(tarBytes: Buffer, options: { stripRoot?: boolean } = {}): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pax: Record<string, string> = {};
  let gnuLongName: string | undefined;

  while (offset + TAR_BLOCK_SIZE <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (header.every((b) => b === 0)) break; // 归档末尾的零块

    const typeByte = String.fromCharCode(header[156]!);
    const rawName = readCString(header.subarray(0, 100));
    const prefix = readCString(header.subarray(345, 500));
    const headerName = prefix === "" ? rawName : `${prefix}/${rawName}`;
    const size = parseNumericField(header.subarray(124, 136));
    const dataStart = offset;
    const dataEnd = dataStart + size;
    const padded = size + ((TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE);
    offset = dataStart + padded;
    if (dataEnd > tarBytes.length) break; // 截断的归档，安全停止

    const data = tarBytes.subarray(dataStart, Math.min(dataEnd, tarBytes.length));

    if (typeByte === TYPE_PAX_LOCAL || typeByte === TYPE_PAX_GLOBAL) {
      pax = { ...pax, ...parsePaxRecords(data) };
      continue;
    }
    if (typeByte === TYPE_GNU_LONGNAME) {
      gnuLongName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }

    const name = gnuLongName ?? pax["path"] ?? headerName;
    const linkTarget = typeByte === TYPE_SYMLINK ? readCString(header.subarray(157, 257)) : undefined;
    gnuLongName = undefined;
    pax = {};

    if (name === "" || name.endsWith("/")) {
      if (typeByte === TYPE_DIR || name.endsWith("/")) {
        const dirName = name.replace(/\/+$/, "");
        if (dirName !== "") entries.push({ path: dirName, type: "dir", data: Buffer.alloc(0) });
      }
      continue;
    }
    if (typeByte === TYPE_FILE || typeByte === TYPE_FILE_ALT) {
      entries.push({ path: name, type: "file", data });
    } else if (typeByte === TYPE_SYMLINK) {
      entries.push({ path: name, type: "symlink", data: Buffer.alloc(0), linkTarget });
    }
    // 其余类型（硬链接 '1'、字符/块设备、fifo）本插件不关心，直接忽略
  }

  if (options.stripRoot === false || entries.length === 0) return entries;
  const first = entries[0]!;
  // codeload 归档的第一条永远是根目录（"<repo>-<ref>/"）；若不是目录则不做剥离，
  // 避免把一条平铺文件名误当根。
  if (first.type !== "dir") return entries;
  const root = first.path.split("/")[0]!;
  if (root === "" || (root === first.path && first.path.includes("/"))) return entries;
  const rootPrefix = `${root}/`;
  const stripped: TarEntry[] = [];
  for (const entry of entries) {
    if (!entry.path.startsWith(rootPrefix)) continue;
    const path = entry.path.slice(rootPrefix.length);
    if (path === "") continue;
    stripped.push({ ...entry, path });
  }
  return stripped.length === 0 ? entries : stripped;
}

/**
 * 便捷：从 tar 条目里取出某个目录下的全部普通文件（相对该目录）。
 *
 * FIX-5：这里是「tar 路径 → 落盘相对路径」的唯一出口，因此统一在这里校验 ——
 * 目录本身必须是安全的相对路径，每一条 rel 也必须安全（见 safepath.ts）；
 * 只要有一条不合格就抛 UPSTREAM（中文说明是哪条路径、为什么），由调用方整体拒绝
 * 本次安装/更新/浏览。符号链接（type='symlink'）从一开始就不在返回集里，永远不会被写盘。
 */
export function filesUnderDirectory(entries: TarEntry[], dir: string): { rel: string; data: Buffer }[] {
  const normalized = dir.replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized !== "") safeRelativePath(normalized, "上游归档里的技能目录路径");
  const prefix = normalized === "" ? "" : `${normalized}/`;
  return entries
    .filter((e) => e.type === "file" && e.path.startsWith(prefix))
    .map((e) => {
      const rel = e.path.slice(prefix.length);
      const reason = describeUnsafePath(rel);
      if (reason !== undefined) {
        throw upstream(`上游归档里的文件路径 "${e.path}" 不安全（${reason}），已拒绝本次安装/更新。`);
      }
      return { rel, data: e.data };
    });
}

/**
 * 在归档里定位某个技能目录。先按 skillPath 的目录直接命中；
 * 未命中时按目录名唯一匹配（上游把技能挪了分类目录时仍能找回）。
 */
export function locateSkillDirectory(
  entries: TarEntry[],
  skillPath: string,
  options: { allowRoot?: boolean } = {},
): { dirName: string; path: string } | undefined {
  const normalized = skillPath.replace(/\\/g, "/").replace(/^\/+/, "");
  // 注意："SKILL.md" 本身（没有目录段）就是仓库根 —— 与 sourceurl.ts 的 skillDirOf 同一判据
  const folder = /^SKILL\.md$/i.test(normalized) ? "" : normalized.replace(/\/SKILL\.md$/i, "").replace(/\/+$/, "");
  // FIX-6（D-1）：skillPath === "SKILL.md" 表示技能就在仓库根（npx skills 的写法）——
  // 此时技能目录是仓库根，dirName 为空串。只给显式允许的调用方（检查/应用更新）；
  // 安装不允许（会把整个仓库写进技能根本身）。
  if (folder === "") {
    if (options.allowRoot === true && entryExists(entries, "SKILL.md")) return { dirName: "", path: "" };
    return undefined;
  }
  if (entryExists(entries, `${folder}/SKILL.md`)) {
    return { dirName: folder.split("/").pop() ?? folder, path: folder };
  }
  const base = folder === "" ? "" : (folder.split("/").pop() ?? folder);
  if (base === "") return undefined;
  const matches = entries.filter(
    (e) => e.type === "file" && /\/SKILL\.md$/i.test(e.path) && (e.path.split("/").at(-2) ?? "") === base,
  );
  if (matches.length !== 1) return undefined;
  const dir = matches[0]!.path.replace(/\/SKILL\.md$/i, "");
  return { dirName: base, path: dir };
}

function entryExists(entries: TarEntry[], path: string): boolean {
  const needle = path.toLowerCase();
  return entries.some((e) => e.type === "file" && e.path.toLowerCase() === needle);
}
