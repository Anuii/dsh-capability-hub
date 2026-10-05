/**
 * SKILL.md 的文档层：编码、BOM、行尾、按行切分、frontmatter 围栏（首行裸 --- 到下一行裸 ---）。
 *
 * 与 DSH（@deepseek-ai/dsh-skill-filesystem 的 parseFrontmatter）一致：首行必须恰好是 ---，
 * 闭合围栏是之后第一行恰好是 --- 的行；BOM 会让首行不再是裸 ---（DSH 因此忽略该技能）。
 * 这一层不解析 YAML，只负责字节与行。
 */

export interface LineInfo {
  /** 行内容，不含行尾 */
  text: string;
  /** 该行使用的行尾：'\n' | '\r\n' | ''（文件末尾无换行） */
  eol: string;
  /** 在正文（去掉 BOM 后）中的起始下标 */
  start: number;
}

export interface FrontmatterDoc {
  /** 原始文本（含 BOM 与原始行尾） */
  raw: string;
  bom: boolean;
  eol: "lf" | "crlf" | "mixed";
  /** 按行切分（保留每行原本的 EOL） */
  lines: LineInfo[];
  /** frontmatter 是否成立（首行裸 --- 且找到闭合 ---） */
  present: boolean;
  /** 首行 --- 的行下标（恒为 0 或 -1） */
  openIndex: number;
  /** 闭合 --- 的行下标；不存在为 -1 */
  closeIndex: number;
  /** 失败原因（present=false 时） */
  failure?: "no-first-line" | "no-closing";
  /** frontmatter 区段内的行（不含围栏） */
  block: LineInfo[];
}

export function splitLines(raw: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\n") {
      const hasCr = i > start && raw[i - 1] === "\r";
      lines.push({ text: raw.slice(start, hasCr ? i - 1 : i), eol: hasCr ? "\r\n" : "\n", start });
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  if (start < raw.length) lines.push({ text: raw.slice(start), eol: "", start });
  return lines;
}

export function detectEol(raw: string): "lf" | "crlf" | "mixed" {
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const lf = (raw.match(/(^|[^\r])\n/g) ?? []).length;
  if (crlf === 0) return "lf";
  if (lf === 0) return "crlf";
  return "mixed";
}

export function decodeDocument(buffer: Buffer): { doc: FrontmatterDoc; validUtf8: boolean } {
  let validUtf8 = true;
  let text: string;
  try {
    // ignoreBOM: true —— 必须保留 BOM 字符，否则无法复刻官方「BOM 导致不加载」的行为
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    validUtf8 = false;
    text = buffer.toString("utf8");
  }
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const allLines = splitLines(body);
  const openIndex = allLines.length > 0 && allLines[0].text === "---" ? 0 : -1;
  let closeIndex = -1;
  if (openIndex === 0) {
    for (let i = 1; i < allLines.length; i += 1) {
      if (allLines[i].text === "---") {
        closeIndex = i;
        break;
      }
    }
  }
  const doc: FrontmatterDoc = {
    raw: text,
    bom,
    eol: detectEol(body),
    lines: allLines,
    present: openIndex === 0 && closeIndex > 0,
    openIndex,
    closeIndex,
    block: openIndex === 0 && closeIndex > 0 ? allLines.slice(1, closeIndex) : [],
  };
  if (!doc.present) doc.failure = openIndex !== 0 ? "no-first-line" : "no-closing";
  return { doc, validUtf8 };
}

/** 去掉 BOM 之后的正文（行的 start 都以它为准）。 */
export function bodyOf(doc: FrontmatterDoc): string {
  return doc.bom ? doc.raw.slice(1) : doc.raw;
}

/** frontmatter 区段的源码与它在正文里的起点（交给 yaml 解析的就是这一段，与 DSH 相同）。 */
export function blockSource(doc: FrontmatterDoc): { text: string; start: number } {
  if (!doc.present) return { text: "", start: 0 };
  const body = bodyOf(doc);
  const start = doc.lines[1]!.start;
  return { text: body.slice(start, doc.lines[doc.closeIndex]!.start), start };
}
