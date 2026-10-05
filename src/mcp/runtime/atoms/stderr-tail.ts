/**
 * 子进程 stderr 尾部捕获（F3-Q6 StderrTail）+ 统一解码（FIX-4）。
 *
 * 目的：debug=false 时 stdio 用 'pipe'（而不是 SDK 默认的 'inherit'），
 * 这样服务器启动失败时才有东西可解释——否则任何诊断都不可能。
 * 摘要是「最后几条非空行」，且整体字节数有上限。
 *
 * FIX-4（Windows 中文系统 stderr 乱码）：
 * Windows 中文系统上 cmd.exe 用 GBK（代码页 936）输出「不是内部或外部命令…」，
 * 而它到达我们手里的是**字节**。因此：
 *   1. 一律**先攒字节、最后解码**（绝不能逐块解码，否则跨块的多字节字符会被切断）；
 *   2. 截尾按**字节**截，并跳过被切掉一半的字符的头；
 *   3. 解码顺序：严格 UTF-8（fatal，成功即用）→ win32 上回退 GBK → 非 fatal UTF-8。
 */
import { MAX_STDERR_CAPTURE, STDERR_SUMMARY_LINES } from '../constants.ts';

/* ---------- 字节 → 文本（FIX-4） ---------- */

let gbkUnavailable = false;

/** 严格 UTF-8：失败返回 undefined（不抛）。 */
function decodeUtf8Strict(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** GBK（Node/Electron 自带 full-icu 支持；环境不支持时返回 undefined）。 */
function decodeGbk(bytes: Uint8Array): string | undefined {
  if (gbkUnavailable) return undefined;
  try {
    const text = new TextDecoder('gbk').decode(bytes);
    // 非 fatal 的 GBK 解码器会把「被切掉一半的字符」变成一个替换字符，去掉它
    return text.replace(/^\uFFFD+/, '');
  } catch {
    gbkUnavailable = true;
    return undefined;
  }
}

/** 跳过开头的 UTF-8 续字节（10xxxxxx）—— 按字节截尾时可能把多字节字符切一半。 */
function trimLeadingContinuationBytes(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return start === 0 ? bytes : bytes.subarray(start);
}

/**
 * 把 stderr 的**字节**解码成文本（FIX-4）。
 * 调用方必须先攒够字节（或攒好尾部字节）再调用它，不要逐块调用。
 */
export function decodeStderrBytes(bytes: Uint8Array | undefined): string {
  if (bytes === undefined || bytes.length === 0) return '';
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 1) 严格 UTF-8 成功即用：合法的 UTF-8 文本绝不受影响
  const strict = decodeUtf8Strict(buffer);
  if (strict !== undefined) return strict;
  // 1b) 按字节截尾可能把 UTF-8 多字节字符切在中间：跳过开头的续字节（10xxxxxx）再试一次。
  //     只有「跳完之后确实是合法 UTF-8」才采用，因此不会把 GBK 数据误当成 UTF-8。
  const trimmed = trimLeadingContinuationBytes(buffer);
  if (trimmed.length !== buffer.length) {
    const retried = decodeUtf8Strict(trimmed);
    if (retried !== undefined) return retried;
  }
  // 2) Windows 中文系统的 stderr 常是 GBK（cmd.exe 的代码页 936）。
  //    这里用**原始字节**（不用上面那份为 UTF-8 准备的裁剪结果），避免误伤 GBK 的前导字节。
  if (process.platform === 'win32') {
    const gbk = decodeGbk(buffer);
    if (gbk !== undefined) return gbk;
  }
  // 3) 最后才用非 fatal 的 UTF-8（坏字节变 U+FFFD，至少不抛错）
  return new TextDecoder('utf-8', { fatal: false }).decode(trimmed).replace(/^\uFFFD+/, '');
}

/** 任意 chunk（Buffer / Uint8Array / string）→ 字节。 */
export function stderrChunkToBytes(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  return Buffer.from(String(chunk), 'utf8');
}

/** 追加并只保留**尾部**的 limit 个字节（先追加再切，避免单个超大 chunk 冲破上限）。 */
export function appendCappedBytes(current: Buffer, chunk: unknown, limit: number): Buffer {
  const bytes = stderrChunkToBytes(chunk);
  if (bytes.length === 0) return current;
  const next = current.length === 0 ? bytes : Buffer.concat([current, bytes]);
  return next.length > limit ? next.subarray(next.length - limit) : next;
}

/* ---------- 捕获 ---------- */

export class StderrTail {
  /** 只保留尾部字节：解码推迟到读取时，跨块的多字节字符因此不会被切断（FIX-4）。 */
  #bytes: Buffer = Buffer.alloc(0);

  push(chunk: unknown): void {
    this.#bytes = appendCappedBytes(this.#bytes, chunk, MAX_STDERR_CAPTURE);
  }

  /** 全部已捕获文本（尾部，最多 MAX_STDERR_CAPTURE 个**字节**）。 */
  text(): string {
    return decodeStderrBytes(this.#bytes);
  }

  /** 最后几条非空行，用得最少的字符重新组装。 */
  summary(): string {
    const lines = this.text()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines.slice(-STDERR_SUMMARY_LINES).join(' — ');
  }

  /** 把 stderr 摘要拼进错误消息，格式与参考实现一致：<msg> (stderr: a — b — c)。 */
  withStderrTail(message: string): string {
    const tail = this.summary();
    return tail ? `${message} (stderr: ${tail})` : message;
  }
}
