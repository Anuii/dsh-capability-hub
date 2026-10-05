/**
 * 路径安全（FIX-5）：tar 条目路径、用户提交的 skillPath、技能目录名的统一校验点。
 * 只依赖 node: 内置模块。
 *
 * 威胁模型（Windows 上真实可利用）：
 *   1. git 允许文件名里出现反斜杠（例如一个文件就叫 \`a\..\..\evil.txt\`），GitHub 打包时
 *      这个名字原样进 tar；它在 Linux 上只是一个普通文件名，而 Windows 上 \`path.join\`
 *      会把反斜杠当目录分隔符 —— 于是写到目标目录之外。
 *   2. tar 条目路径（含 pax 头的 path 记录）里的 ".." 段、绝对路径、盘符、Windows 保留
 *      设备名（CON/NUL/COM1…）、以空格或点结尾的段 —— 落盘位置都会与预期不符。
 *
 * 处置原则：**整体拒绝**。发现任何一条不安全路径，就拒绝本次安装/更新（抛 UPSTREAM /
 * BAD_REQUEST，中文说明是哪条路径、为什么）。不做「跳过坏条目、装剩下的一半」的折中：
 * 技能内容不完整同样危险。
 */

import path from "node:path";
import { upstream } from "./errors.ts";

/** Windows 保留设备名（不区分大小写；带扩展名的形式 —— 如 NUL.txt —— 同样保留） */
const WINDOWS_RESERVED_NAMES = new Set<string>([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/** NUL 与其它控制字符（含 DEL） */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 盘符形态（C: / c:），tar 里出现即视为绝对路径 */
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * 判断一个「相对路径」是否安全：安全返回 undefined，否则返回中文原因。
 * 按 "/" 分段逐段检查，任一段不合格即整体不安全。
 */
export function describeUnsafePath(rel: string): string | undefined {
  if (typeof rel !== "string") return "不是字符串";
  if (rel === "") return "空路径";
  if (CONTROL_CHARS.test(rel)) return "含 NUL 或其它控制字符";
  if (DRIVE_LETTER.test(rel)) return "形如盘符的路径";
  if (rel.startsWith("/") || rel.startsWith("\\\\")) return "绝对路径";
  for (const segment of rel.split("/")) {
    if (segment === "") return "含空的路径段";
    if (segment === "." || segment === "..") return '含 "." 或 ".." 路径段';
    if (segment.includes("\\")) return "含反斜杠（Windows 上会被当作目录分隔符）";
    if (segment.includes(":")) return "含冒号（盘符或 NTFS 备用数据流）";
    if (/[. ]$/.test(segment)) return "路径段以点或空格结尾（Windows 上会被静默截断）";
    const base = segment.split(".")[0]!.toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(base)) return "是 Windows 保留设备名（" + base + "）";
  }
  return undefined;
}

/** 布尔版。 */
export function isSafeRelativePath(rel: string): boolean {
  return describeUnsafePath(rel) === undefined;
}

/** 单段名（技能目录名 / 文件名）版本：额外要求「恰好一段」，即不含 "/"。 */
export function describeUnsafeSegmentName(name: string): string | undefined {
  if (typeof name !== "string") return "不是字符串";
  if (name.includes("/")) return '不是单段名（含 "/"）';
  return describeUnsafePath(name);
}

export function isSafeSegmentName(name: string): boolean {
  return describeUnsafeSegmentName(name) === undefined;
}

/** 校验并原样返回该相对路径；不安全就抛 UPSTREAM。 */
export function safeRelativePath(rel: string, context = "上游归档路径"): string {
  const reason = describeUnsafePath(rel);
  if (reason !== undefined) {
    throw upstream(context + ' "' + rel + '" 不安全（' + reason + "），已拒绝：本插件不会把内容写到技能目录之外。");
  }
  return rel;
}

/** 校验技能目录名（安装目标名的最后一段）；不安全就抛 UPSTREAM。 */
export function safeSegmentName(name: string, context = "技能目录名"): string {
  const reason = describeUnsafeSegmentName(name);
  if (reason !== undefined) {
    throw upstream(context + ' "' + name + '" 不安全（' + reason + "），已拒绝。");
  }
  return name;
}

/**
 * 纵深防御：确认 absPath 落在 targetDir 之内（先 path.resolve，再 path.relative）。
 *
 * 判定用的是「等于 '..' 或以 '..' + 分隔符开头」而不是 \`startsWith('..')\` ——
 * 后者会把合法的相对名字（如 \`..foo\`，本函数的另一个调用方允许它）误判成越界。
 */
export function assertPathInsideDirectory(targetDir: string, absPath: string, context = "写入路径"): void {
  const root = path.resolve(targetDir);
  const target = path.resolve(absPath);
  const rel = path.relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw upstream(context + " " + target + " 不在 " + root + " 之内，已拒绝写入。");
  }
}
