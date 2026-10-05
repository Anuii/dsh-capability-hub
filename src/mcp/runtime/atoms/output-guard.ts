/**
 * 输出护栏（D-D6、F3-Q6）。
 *
 * 规则：
 * - **保头部**而不是尾部：MCP 结果通常以摘要开头，其余模型可以用 read/grep 去取。
 * - **先按行、再按字节**：先切字节会留下半行，行数统计会报错。
 * - 字节切割要**回退 UTF-8 续字节**（0b10xxxxxx），保证最后一个字符完整。
 * - 超出时把**完整内容**写进 spill 文件（单文件上限 16 MiB），并在结果末尾告诉模型路径。
 * - 只保护「服务器写的」内容；网关自己的 status/search/错误文本按构造就有界，不过护栏。
 */
import { join } from "node:path";
import { SPILL_KEEP_FILES, SPILL_MAX_BYTES } from "../constants.ts";
import { atomicWriteFile, ensureDir, listDir, removeFile } from "./fsx.ts";

export interface OutputGuardSettings {
  enabled: boolean;
  maxBytes: number;
  maxLines: number;
}

export interface GuardOutcome {
  text: string;
  truncated: boolean;
  originalLines: number;
  originalBytes: number;
  shownLines: number;
  shownBytes: number;
  spillPath?: string;
}

/** 按字节截断并回退掉被切开的 UTF-8 续字节。 */
export function cutAtBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

/** 按行保留头部。 */
export function cutAtLines(text: string, maxLines: number): { text: string; lines: number } {
  if (maxLines <= 0) return { text: "", lines: 0 };
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, lines: lines.length };
  return { text: lines.slice(0, maxLines).join("\n"), lines: maxLines };
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
  return count;
}

/** 格式化为 KiB / MiB（中文文案里用它，避免超长数字）。 */
export function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MiB";
  return (bytes / 1024).toFixed(1) + " KiB";
}

export interface SpillWriter {
  /** 写一份完整内容并返回路径；失败抛错。 */
  write(text: string): Promise<string>;
  /** 删掉自己写过的所有文件（dispose 时调用）。 */
  cleanup(): Promise<void>;
}

export function createSpillWriter(spillDir: string): SpillWriter {
  const written = new Set<string>();

  async function prune(): Promise<void> {
    const entries = (await listDir(spillDir)).filter((entry) => entry.isFile && entry.name.startsWith("output-"));
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of entries.slice(SPILL_KEEP_FILES)) {
      await removeFile(entry.path).catch(() => undefined);
    }
  }

  return {
    async write(text: string) {
      await ensureDir(spillDir);
      const name = "output-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10) + ".txt";
      const path = join(spillDir, name);
      const bytes = Buffer.from(text, "utf8");
      if (bytes.length > SPILL_MAX_BYTES) {
        const head = cutAtBytes(text, SPILL_MAX_BYTES);
        const note = "\n\n[能力中心：该结果超过 " + humanBytes(SPILL_MAX_BYTES) + " 上限，spill 文件本身已被截断]\n";
        await atomicWriteFile(path, head + note);
      } else {
        await atomicWriteFile(path, text);
      }
      written.add(path);
      await prune();
      return path;
    },
    async cleanup() {
      for (const path of written) await removeFile(path).catch(() => undefined);
      written.clear();
    },
  };
}

export interface SpillLike {
  write(text: string): Promise<string>;
}

/**
 * 施加护栏。
 * @param text 服务器写的内容（已经整理成文本）
 * @param settings 护栏设置
 * @param spill 写 spill 的能力；不传则超出时只提示「无法保存」
 */
export async function applyOutputGuard(
  text: string,
  settings: OutputGuardSettings,
  spill?: SpillLike,
): Promise<GuardOutcome> {
  const originalBytes = Buffer.byteLength(text, "utf8");
  const originalLines = countLines(text);
  if (!settings.enabled) {
    return {
      text,
      truncated: false,
      originalLines,
      originalBytes,
      shownLines: originalLines,
      shownBytes: originalBytes,
    };
  }
  const maxBytes = settings.maxBytes > 0 ? settings.maxBytes : 0;
  const maxLines = settings.maxLines > 0 ? settings.maxLines : 0;
  if (maxBytes === 0 && maxLines === 0) {
    return {
      text,
      truncated: false,
      originalLines,
      originalBytes,
      shownLines: originalLines,
      shownBytes: originalBytes,
    };
  }

  let trimmed = text;
  let truncated = false;
  if (maxLines > 0) {
    const byLines = cutAtLines(trimmed, maxLines);
    if (byLines.lines < originalLines) truncated = true;
    trimmed = byLines.text;
  }
  if (maxBytes > 0 && Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    trimmed = cutAtBytes(trimmed, maxBytes);
    truncated = true;
  }
  if (!truncated) {
    return {
      text,
      truncated: false,
      originalLines,
      originalBytes,
      shownLines: originalLines,
      shownBytes: originalBytes,
    };
  }

  const shownLines = countLines(trimmed);
  const shownBytes = Buffer.byteLength(trimmed, "utf8");
  const head =
    "\n\n[能力中心：MCP 输出已被截断——原始 " +
    originalLines +
    " 行 / " +
    humanBytes(originalBytes) +
    "，此处只显示前 " +
    shownLines +
    " 行 / " +
    humanBytes(shownBytes) +
    "。";
  let notice: string;
  let spillPath: string | undefined;
  if (spill) {
    try {
      spillPath = await spill.write(text);
      notice = head + "完整内容已保存到：" + spillPath + "（可用 read 带 offset/limit 读取，或直接用 grep 搜索）。]";
    } catch (err) {
      notice = head + "完整内容未能保存：" + (err as Error).message + "]";
    }
  } else {
    notice = head + "完整内容未能保存。]";
  }
  return { text: trimmed + notice, truncated: true, originalLines, originalBytes, shownLines, shownBytes, spillPath };
}
