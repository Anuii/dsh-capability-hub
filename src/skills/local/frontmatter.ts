/**
 * 零依赖 frontmatter 解析与「只改一行」改写。
 *
 * 目标：严格复刻 DSH 官方 @deepseek-ai/dsh-skill-filesystem 的解析与校验语义
 * （证据：F4 §Q1.3/Q1.4，官方源码 parseFrontmatter / parseSkillFile / parseInvocationPolicy），
 * 同时把官方「静默丢弃」的结果翻译成中文诊断。
 *
 * 支持范围（F4 §Q4.1）：
 *  - L0：裸 --- 围栏（LF/CRLF）、顶层映射、单/双引号标量、纯标量、折叠块标量 > 与字面块标量 |、
 *        一级嵌套映射、官方布尔宽容度、行尾注释（空白 + #）、保留未知键、保留末尾换行有无。
 *  - L1：整行注释与空行（不参与语义但字节原样保留）、块序列、多行缩进续行（不崩）。
 *  - 注释语义与官方 yaml 2.9.1 一致（实测对拍见 test/skills/local/yaml-parity.mjs）：
 *    「#」只在行首、或紧跟空白、且不在引号内、不在流式集合内时才是注释；
 *    因此 a#b 是正文、引号标量里的 # 是正文、块标量（| 与 >）内容里的 # 也是正文。
 *  - L2：锚点/别名/显式 tag、流式集合、多文档、%YAML 指令、非 UTF-8 编码
 *        -> 不崩，标记 format.safeToToggle = false 并给诊断，绝不写回。
 */

import type { Diagnostic } from "../contract/local.ts";

export type ScalarValue = string | number | boolean | null;

export interface YamlMap {
  [key: string]: YamlValue;
}
export type YamlValue = ScalarValue | YamlValue[] | YamlMap;

export interface FmEntry {
  key: string;
  /** 原始行（不含行尾），用于诊断展示 */
  line: string;
  /** 值类型形态 */
  kind: "scalar" | "map" | "list" | "null";
  value: YamlValue;
  /** 该键所在行在 frontmatter 行数组中的下标（0 = 首行 --- 之后第一行） */
  lineIndex: number;
  /** 是否命中 L2 特性（命中即不可安全改写） */
  unsafe: string[];
}

export interface LineInfo {
  /** 行内容，不含行尾 */
  text: string;
  /** 该行使用的行尾：'\n' | '\r\n' | ''（文件末尾无换行） */
  eol: string;
  /** 在原文中的起始下标 */
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
  /** 首行 --- 的行下标（恒为 0 或 1） */
  openIndex: number;
  /** 闭合 --- 的行下标；不存在为 -1 */
  closeIndex: number;
  /** 失败原因（present=false 时） */
  failure?: "no-first-line" | "no-closing";
  /** frontmatter 区段内的行（不含围栏） */
  block: LineInfo[];
}

export interface FrontmatterParseResult {
  /** 顶层键 -> 值 */
  data: YamlMap;
  entries: Map<string, FmEntry>;
  /** 顶层键出现顺序 */
  order: string[];
  /** 解析错误（命中即官方丢弃） */
  errors: { code: string; message: string }[];
  /** L2 特性描述（命中即不可安全改写） */
  l2: string[];
  /** L1 特性描述 */
  l1: string[];
  /** 无错时 true */
  ok: boolean;
}

const INDENT = /^ */;
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/;
const BLOCK_HEADER = /^([|>])([+-]?)([0-9]*)([+-]?)[ \t]*$/;
const UNSAFE_INLINE = /^\s*(&|\*|\[|\{|!!|!<|!\S)/;

/* ---------------- 文档层 ---------------- */

function splitLines(raw: string): LineInfo[] {
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

/* ---------------- 标量解析 ---------------- */

/** 纯标量按 YAML 1.2 core schema 的极小解析：只认 true/false 与十进制整数，其余为字符串。 */
function plainScalar(text: string): ScalarValue {
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (/^-?[0-9]+$/.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) return n;
  }
  return text;
}

/** 标量 token 解析结果。 */
export interface ScalarParse {
  /** 解析出的值；流式集合会得到数组/对象（best-effort，命中即标 unsafe） */
  value: YamlValue;
  /** 命中的危险/高级 YAML 特性 */
  unsafe: string[];
}

/** 解析一行内的值 token（引号标量 / 纯标量 / 危险前缀）。 */
export function parseScalarToken(token: string): ScalarParse {
  const trimmed = token.trim();
  if (trimmed === "") return { value: null, unsafe: [] };
  const first = trimmed[0];
  if (first === "&") {
    const m = /^&[^\s]+(?:[ \t]+([\s\S]*))?$/.exec(trimmed);
    const inner = m?.[1] ?? "";
    const sub: ScalarParse = inner === "" ? { value: null, unsafe: [] } : parseScalarToken(inner);
    return { value: sub.value, unsafe: ["anchor", ...sub.unsafe] };
  }
  if (first === "*") return { value: trimmed, unsafe: ["alias"] };
  if (first === "[" || first === "{") {
    return { value: parseFlowCollection(trimmed), unsafe: ["flow-collection"] };
  }
  if (trimmed.startsWith("!!") || (first === "!" && trimmed.length > 1)) {
    const m = /^!(?:![^\s]*|[^\s]*)(?:[ \t]+([\s\S]*))?$/.exec(trimmed);
    const inner = m?.[1] ?? "";
    const sub: ScalarParse = inner === "" ? { value: null, unsafe: [] } : parseScalarToken(inner);
    return { value: sub.value, unsafe: ["tag", ...sub.unsafe] };
  }
  if (first === "'") {
    if (!trimmed.endsWith("'") || trimmed.length < 2)
      return { value: trimmed.slice(1), unsafe: ["unterminated-quote"] };
    return { value: trimmed.slice(1, -1).split("''").join("'"), unsafe: [] };
  }
  if (first === '"') {
    if (!trimmed.endsWith('"') || trimmed.length < 2)
      return { value: trimmed.slice(1), unsafe: ["unterminated-quote"] };
    const inner = trimmed.slice(1, -1);
    const unescaped = inner.replace(/\\[\\"nrt0\\/]|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/g, (m) => {
      switch (m) {
        case "\\\\":
          return "\\";
        case '\\"':
          return '"';
        case "\\n":
          return "\n";
        case "\\r":
          return "\r";
        case "\\t":
          return "\t";
        case "\\0":
          return "\0";
        case "\\/":
          return "/";
        default:
          if (m.startsWith("\\u")) return String.fromCharCode(parseInt(m.slice(2), 16));
          if (m.startsWith("\\x")) return String.fromCharCode(parseInt(m.slice(2), 16));
          return m;
      }
    });
    return { value: unescaped, unsafe: [] };
  }
  // 多行纯标量续行：本行以未闭合的引号开头的情形已在上方处理；此处按纯标量
  return { value: plainScalar(trimmed), unsafe: [] };
}

/** 流式集合的 best-effort 解析（只用于「读」；命中即标记不可改写）。 */
function parseFlowCollection(token: string): YamlValue {
  const close = token[0] === "[" ? "]" : "}";
  if (!token.endsWith(close) || token.length < 2) return token;
  const inner = token.slice(1, -1).trim();
  if (inner === "") return token[0] === "[" ? [] : {};
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote !== "") {
      current += ch;
      if (ch === quote && inner[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current !== "") parts.push(current);
  if (token[0] === "[") return parts.map((p) => parseScalarToken(p).value);
  const obj: YamlMap = {};
  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon < 0) {
      obj[part.trim()] = null;
      continue;
    }
    obj[part.slice(0, colon).trim()] = parseScalarToken(part.slice(colon + 1)).value;
  }
  return obj;
}

/* ---------------- 行尾注释（与官方 yaml 一致） ---------------- */

/**
 * 定位行尾注释的起点，返回 `#` 在 text 中的下标；没有注释返回 -1。
 *
 * 与官方 yaml 2.9.1 的规则一致：`#` 只有在「行首」或「前面是空白」时才开始注释，
 * 且必须不在单/双引号标量内部、不在流式集合（[ ] { }）内部。
 *  - `# c`        -> 0（整行/行尾注释）
 *  - `demo # c`   -> 5
 *  - `a#b`        -> -1（# 前面不是空白，属于正文）
 *  - `'a # b'`    -> -1（引号内）
 *  - `[a, # b]`   -> -1（流式集合内，本插件不解析其注释语义，整体标为 L2 不可改写）
 */
export function findCommentStart(text: string): number {
  let i = 0;
  let quote: "" | "'" | '"' = "";
  let depth = 0;
  let tokenStarted = false;
  while (i < text.length) {
    const ch = text[i] as string;
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i += 2;
          continue;
        }
        quote = "";
      }
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') quote = "";
      i += 1;
      continue;
    }
    if (ch === "#" && depth === 0 && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) return i;
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (!tokenStarted && (ch === "'" || ch === '"')) {
      quote = ch;
      tokenStarted = true;
      i += 1;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    tokenStarted = true;
    i += 1;
  }
  return -1;
}

/** 值 token 与行尾注释的切分结果。 */
export interface ValueCommentSplit {
  /** 值 token 原文（若存在注释，则不含注释前的空白；否则只去掉行尾空白） */
  value: string;
  /** 行尾注释原文（含它以左的空白），没有注释时是空串或行尾空白——两者都原样保留以便逐字节回写 */
  comment: string;
}

/** 把「冒号之后的部分」切成 值 token + 行尾注释。 */
export function splitValueComment(rest: string): ValueCommentSplit {
  const hash = findCommentStart(rest);
  if (hash < 0) {
    const value = rest.trimEnd();
    return { value, comment: rest.slice(value.length) };
  }
  let start = hash;
  while (start > 0 && (rest[start - 1] === " " || rest[start - 1] === "\t")) start -= 1;
  return { value: rest.slice(0, start), comment: rest.slice(start) };
}

function indentOf(text: string): number {
  const m = INDENT.exec(text);
  return m === null ? 0 : m[0].length;
}

/** 折叠/字面块标量取值（F4 §Q4.1 第 5 条）。 */
export function blockScalarValue(kind: "|" | ">", chomp: string, contentLines: string[]): string {
  let commonIndent = -1;
  for (const line of contentLines) {
    if (line.trim() === "") continue;
    const ind = indentOf(line);
    if (commonIndent < 0 || ind < commonIndent) commonIndent = ind;
  }
  const dedent = commonIndent > 0 ? commonIndent : 0;
  const stripped = contentLines.map((l) => (l.trim() === "" ? "" : l.slice(Math.min(dedent, indentOf(l)))));
  let text: string;
  if (kind === "|") {
    text = stripped.join("\n");
  } else {
    const parts: string[] = [];
    let pendingBreaks = 0;
    let first = true;
    for (const line of stripped) {
      if (line === "") {
        pendingBreaks += 1;
        continue;
      }
      if (!first) parts.push(pendingBreaks > 0 ? "\n".repeat(pendingBreaks) : " ");
      first = false;
      pendingBreaks = 0;
      parts.push(line);
    }
    text = parts.join("");
  }
  const trailingBlank = /\n*$/.exec(text)?.[0].length ?? 0;
  const core = text.slice(0, text.length - trailingBlank);
  if (chomp === "-") return core;
  if (chomp === "+") return text + "\n";
  return core + "\n";
}

/* ---------------- frontmatter 块解析 ---------------- */

export function parseFrontmatterBlock(block: LineInfo[]): FrontmatterParseResult {
  const st: BlockState = {
    data: {},
    entries: new Map(),
    order: [],
    duplicates: [],
    errors: [],
    l2: [],
    l1: [],
  };
  let i = 0;

  while (i < block.length) {
    const line = block[i];
    const text = line.text;
    const trimmed = text.trim();

    if (trimmed === "") {
      push(st.l1, "blank-line");
      i += 1;
      continue;
    }
    if (trimmed.startsWith("#")) {
      push(st.l1, "comment");
      i += 1;
      continue;
    }
    const leading = INDENT.exec(text)?.[0] ?? "";
    if (text.length > leading.length && text[leading.length] === "\t") {
      push(st.l2, "indentation-tab");
      addError(st, "YAML_INVALID", "frontmatter 中出现了制表符缩进，yaml 库会解析失败，DSH 将忽略该技能。");
      i += 1;
      continue;
    }
    const indent = leading.length;

    if (indent > 0) {
      // 嵌套内容（嵌套映射 / 块序列 / 续行）：不解析内部语义，但绝不重排
      push(st.l1, "nested-indent");
      i += 1;
      continue;
    }

    const keyMatch = KEY_LINE.exec(text);
    if (keyMatch === null) {
      if (text.startsWith("- ") || text === "-") {
        addError(
          st,
          "YAML_UNSUPPORTED",
          "frontmatter 顶层出现了块序列（- item），yaml 会解析成数组，DSH 要求 frontmatter 是映射，因此该技能会被忽略。",
        );
        i += 1;
        continue;
      }
      if (trimmed === "---" || trimmed.startsWith("%YAML")) {
        push(st.l2, "multi-document");
        addError(st, "YAML_UNSUPPORTED", "frontmatter 内出现多文档分隔符或 %YAML 指令，当前解析器不支持。");
        i += 1;
        continue;
      }
      if (text.includes("\t")) {
        push(st.l2, "indentation-tab");
        addError(st, "YAML_INVALID", "frontmatter 中出现了制表符缩进，yaml 库会解析失败，DSH 将忽略该技能。");
        i += 1;
        continue;
      }
      addError(st, "YAML_INVALID", "frontmatter 存在无法识别的行：" + text.slice(0, 60));
      i += 1;
      continue;
    }

    const key = keyMatch[1];
    const rest = keyMatch[2];
    const keyLineIndex = i;
    i += 1;
    // 值 token 与行尾注释分开：`name: demo # c` 的 name 必须是 demo（官方 yaml 的语义）
    const restValue = splitValueComment(rest).value;
    const restTrim = restValue.trim();
    const sameLineHeader = restTrim === "" ? null : BLOCK_HEADER.exec(restTrim);
    if (sameLineHeader !== null) {
      const kind = sameLineHeader[1] as "|" | ">";
      const chomp = sameLineHeader[2] !== "" ? sameLineHeader[2] : sameLineHeader[4] !== "" ? sameLineHeader[4] : "";
      const contentLines: string[] = [];
      let j = i;
      while (j < block.length) {
        const nt = block[j].text;
        if (nt.trim() !== "" && indentOf(nt) <= indent) break;
        contentLines.push(nt);
        j += 1;
      }
      i = j;
      while (contentLines.length > 0 && (contentLines[contentLines.length - 1] ?? "").trim() === "") contentLines.pop();
      setTop(st, key, keyLineIndex, text, "scalar", blockScalarValue(kind, chomp, contentLines), []);
      continue;
    }
    if (restTrim !== "") {
      const parsed = parseScalarToken(restValue);
      for (const u of parsed.unsafe) push(st.l2, u);
      setTop(st, key, keyLineIndex, text, "scalar", parsed.value, parsed.unsafe);
      continue;
    }

    // 值在后续行：块标量 / 嵌套映射 / 块序列 / 纯 null
    const nested: LineInfo[] = [];
    let j = i;
    while (j < block.length) {
      const nt = block[j].text;
      if (nt.trim() === "") {
        nested.push(block[j]);
        j += 1;
        continue;
      }
      if (indentOf(nt) <= indent) break;
      nested.push(block[j]);
      j += 1;
    }
    const contentStart = i;
    i = j;

    const firstContent = nested.find((l) => l.text.trim() !== "");
    const firstContentToken =
      firstContent === undefined ? "" : splitValueComment(firstContent.text.trim()).value.trim();
    const header = firstContent === undefined ? null : BLOCK_HEADER.exec(firstContentToken);
    if (header !== null && firstContent === nested[0]) {
      const kind = header[1] as "|" | ">";
      const chomp = header[2] !== "" ? header[2] : header[4] !== "" ? header[4] : "";
      const contentLines = nested.slice(1).map((l) => l.text);
      while (contentLines.length > 0 && (contentLines[contentLines.length - 1] ?? "").trim() === "") contentLines.pop();
      const value = blockScalarValue(kind, chomp, contentLines);
      setTop(st, key, keyLineIndex, text, "scalar", value, []);
      continue;
    }

    const meaningful = nested.filter((l) => l.text.trim() !== "" && !l.text.trim().startsWith("#"));
    const seqLike =
      meaningful.length > 0 && meaningful.every((l) => l.text.trim().startsWith("- ") || l.text.trim() === "-");
    if (seqLike) {
      const list: YamlValue[] = meaningful.map(
        (l) => parseScalarToken(splitValueComment(l.text.trim().slice(1)).value).value,
      );
      setTop(st, key, keyLineIndex, text, "list", list, []);
      continue;
    }

    const child: YamlMap = {};
    let childCount = 0;
    for (const nl of meaningful) {
      const cm = KEY_LINE.exec(nl.text.trim());
      if (cm === null) continue;
      const parsed = parseScalarToken(splitValueComment(cm[2]).value);
      for (const u of parsed.unsafe) push(st.l2, u);
      child[cm[1]] = parsed.value;
      childCount += 1;
    }
    if (childCount > 0) {
      setTop(st, key, keyLineIndex, text, "map", child, []);
    } else {
      setTop(st, key, keyLineIndex, text, "null", null, []);
    }
  }

  for (const key of st.duplicates) {
    addError(
      st,
      "YAML_DUPLICATE_KEY",
      "frontmatter 中出现重复的顶层键「" + key + "」，yaml 库默认会因此解析失败，DSH 将忽略该技能。",
    );
  }

  if (st.entries.size === 0) {
    addError(st, "YAML_NOT_MAP", "frontmatter 没有解析出任何键值，yaml 库会得到 null，DSH 将忽略该技能。");
  }
  const errors = st.errors;
  return {
    data: st.data,
    entries: st.entries,
    order: st.order,
    errors,
    l2: unique(st.l2),
    l1: unique(st.l1),
    ok: errors.length === 0,
  };
}

interface BlockState {
  data: YamlMap;
  entries: Map<string, FmEntry>;
  order: string[];
  duplicates: string[];
  errors: { code: string; message: string }[];
  l2: string[];
  l1: string[];
}

function push(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function addError(st: BlockState, code: string, message: string, once = false): void {
  if (st.errors.some((e) => e.code === code && (once || e.message === message))) return;
  if (st.errors.length > 30) return;
  st.errors.push({ code, message });
}

function setTop(
  st: BlockState,
  key: string,
  lineIndex: number,
  line: string,
  kind: FmEntry["kind"],
  value: YamlValue,
  unsafe: string[],
): void {
  if (Object.hasOwn(st.data, key)) {
    push(st.duplicates, key);
    return;
  }
  st.data[key] = value;
  st.order.push(key);
  st.entries.set(key, { key, line, kind, value, lineIndex, unsafe: unsafe.slice() });
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

/* ---------------- 官方校验链复刻 ---------------- */

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const LEGACY_KEYS: { key: string; canonical: string }[] = [
  { key: "disableModelInvocation", canonical: "disable-model-invocation" },
  { key: "modelInvocable", canonical: "disable-model-invocation" },
  { key: "userInvocable", canonical: "user-invocable" },
];

/** DSH 认识的 frontmatter 键（其余进 extraKeys，绝不删除）。 */
export const KNOWN_KEYS = new Set([
  "name",
  "description",
  "whenToUse",
  "metadata",
  "disable-model-invocation",
  "user-invocable",
]);

export interface BooleanFieldResult {
  present: boolean;
  value?: boolean;
  invalid?: boolean;
}

/** 复刻官方 frontmatterBoolean 的宽容度（F4 §Q1.4）。 */
export function frontmatterBoolean(data: YamlMap, key: string): BooleanFieldResult {
  if (!Object.hasOwn(data, key)) return { present: false };
  const value = data[key];
  if (typeof value === "boolean") return { present: true, value };
  if (value === 1 || value === "1") return { present: true, value: true };
  if (value === 0 || value === "0") return { present: true, value: false };
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true" || lower === "yes" || lower === "on") return { present: true, value: true };
    if (lower === "false" || lower === "no" || lower === "off") return { present: true, value: false };
  }
  return { present: true, invalid: true };
}

export interface EvaluationResult {
  doc: FrontmatterDoc | undefined;
  validUtf8: boolean;
  present: boolean;
  data: YamlMap;
  entries: Map<string, FmEntry>;
  order: string[];
  name?: string;
  description?: string;
  modelInvocationDisabled: boolean;
  userInvocable: boolean | null;
  loadable: boolean;
  extraKeys: string[];
  safeToToggle: boolean;
  diagnostics: Diagnostic[];
  /** 解析失败大类（用于格式化改写前的自检） */
  hardFailure: boolean;
}

export function evaluateFrontmatter(buffer: Buffer): EvaluationResult {
  const { doc, validUtf8 } = decodeDocument(buffer);
  const diagnostics: Diagnostic[] = [];
  const empty: YamlMap = {};
  const base: EvaluationResult = {
    doc,
    validUtf8,
    present: false,
    data: empty,
    entries: new Map(),
    order: [],
    modelInvocationDisabled: false,
    userInvocable: null,
    loadable: false,
    extraKeys: [],
    safeToToggle: false,
    diagnostics,
    hardFailure: true,
  };

  if (doc.bom) {
    diagnostics.push({
      level: "error",
      code: "BOM_PRESENT",
      message:
        "文件以 UTF-8 BOM 开头。DSH 要求 frontmatter 首行是裸 ---，BOM 会让整份 frontmatter 失效，该技能会被完全忽略（模型侧不可见）。",
    });
  }
  if (!validUtf8) {
    diagnostics.push({
      level: "error",
      code: "NOT_UTF8",
      message: "文件不是合法的 UTF-8 编码，无法安全解析 frontmatter。",
    });
    return base;
  }
  if (!doc.present) {
    diagnostics.push({
      level: "error",
      code: doc.failure === "no-closing" ? "FRONTMATTER_UNCLOSED" : "FRONTMATTER_MISSING",
      message:
        doc.failure === "no-closing"
          ? "frontmatter 只有开头的 --- 而没有闭合的 ---（闭合围栏必须是行首独立的 ---）。"
          : "文件第一行不是裸的 ---，DSH 解析不到 frontmatter，该技能会被完全忽略。",
    });
    return { ...base, present: false };
  }

  const parsed = parseFrontmatterBlock(doc.block);
  for (const err of parsed.errors) {
    diagnostics.push({ level: "error", code: err.code, message: err.message });
  }
  for (const f of parsed.l2) {
    diagnostics.push({
      level: "warning",
      code: "YAML_L2_FEATURE",
      message: "frontmatter 使用了高级 YAML 特性（" + describeL2(f) + "），为保证字节级安全，本插件不会改写该文件。",
    });
  }
  for (const f of parsed.l1) {
    diagnostics.push({
      level: "info",
      code: "YAML_L1_FEATURE",
      message: "frontmatter 含有" + describeL1(f) + "，已保留但不会重排。",
    });
  }

  const data = parsed.data;
  const nameValue = data.name;
  const descriptionValue = data.description;
  const name = typeof nameValue === "string" && nameValue.length > 0 ? nameValue : undefined;
  const description =
    typeof descriptionValue === "string" && descriptionValue.length > 0 ? descriptionValue : undefined;

  let loadable = parsed.ok && !doc.bom;

  if (name === undefined) {
    diagnostics.push({
      level: "error",
      code: "SKILL_NAME_MISSING",
      message: "frontmatter 缺少 name，或 name 不是非空字符串；DSH 会完全忽略该技能。",
    });
    loadable = false;
  } else if (!SKILL_NAME_PATTERN.test(name)) {
    diagnostics.push({
      level: "error",
      code: "SKILL_NAME_INVALID",
      message:
        "name「" +
        name +
        "」不符合 DSH 的技能名规则（只允许小写字母、数字，以及作为分隔的单个连字符）。DSH 会完全忽略该技能。",
    });
    loadable = false;
  }
  if (description === undefined) {
    diagnostics.push({
      level: "error",
      code: "SKILL_DESCRIPTION_MISSING",
      message: "frontmatter 缺少 description，或 description 不是非空字符串；DSH 会完全忽略该技能。",
    });
    loadable = false;
  }

  for (const legacy of LEGACY_KEYS) {
    if (Object.hasOwn(data, legacy.key)) {
      diagnostics.push({
        level: "error",
        code: "LEGACY_KEY_PRESENT",
        message:
          "使用了已废弃的驼峰键「" +
          legacy.key +
          "」；DSH 只认「" +
          legacy.canonical +
          "」，出现该键会让整个技能被丢弃。",
      });
      loadable = false;
    }
  }

  const disableField = frontmatterBoolean(data, "disable-model-invocation");
  if (disableField.invalid) {
    diagnostics.push({
      level: "error",
      code: "BOOLEAN_INVALID",
      message:
        "disable-model-invocation 的取值「" +
        String(data["disable-model-invocation"]) +
        "」不是合法布尔；DSH 会因此丢弃整个技能（合法值：true/false、1/0、true/yes/on、false/no/off，大小写不敏感）。",
    });
    loadable = false;
  }
  const userField = frontmatterBoolean(data, "user-invocable");
  if (userField.invalid) {
    diagnostics.push({
      level: "error",
      code: "BOOLEAN_INVALID",
      message:
        "user-invocable 的取值「" +
        String(data["user-invocable"]) +
        "」不是合法布尔；DSH 会因此丢弃整个技能（合法值：true/false、1/0、true/yes/on、false/no/off，大小写不敏感）。",
    });
    loadable = false;
  }

  if (Object.hasOwn(data, "metadata")) {
    const meta = data.metadata;
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
      diagnostics.push({
        level: "warning",
        code: "METADATA_IGNORED",
        message: "metadata 不是普通映射（object），DSH 会忽略它（不影响技能能否加载）。",
      });
    } else if (parsed.entries.get("metadata")?.kind !== "map") {
      diagnostics.push({
        level: "warning",
        code: "METADATA_IGNORED",
        message: "metadata 不是普通映射（object），DSH 会忽略它（不影响技能能否加载）。",
      });
    }
  }

  const extraKeys: string[] = [];
  for (const key of parsed.order) {
    if (KNOWN_KEYS.has(key)) continue;
    if (LEGACY_KEYS.some((l) => l.key === key)) continue;
    extraKeys.push(key);
    const entry = parsed.entries.get(key);
    const shown =
      entry === undefined
        ? ""
        : entry.kind === "map"
          ? "（嵌套映射）"
          : entry.kind === "list"
            ? "（块序列）"
            : "=" + JSON.stringify(entry.value);
    diagnostics.push({
      level: "info",
      code: "EXTRA_KEY",
      message: "DSH 不认识 frontmatter 键「" + key + "」" + shown + "，本插件会原样保留、不会删除。",
    });
  }

  // whenToUse：可选 camelCase，非空字符串才生效
  if (Object.hasOwn(data, "whenToUse")) {
    const wt = data.whenToUse;
    if (typeof wt !== "string" || wt.length === 0) {
      diagnostics.push({
        level: "warning",
        code: "WHEN_TO_USE_IGNORED",
        message: "whenToUse 不是非空字符串，DSH 会静默忽略它。",
      });
    }
  }

  const safeToToggle = evaluatedSafeToToggle(parsed, doc);

  return {
    doc,
    validUtf8,
    present: true,
    data,
    entries: parsed.entries,
    order: parsed.order,
    name,
    description,
    modelInvocationDisabled: disableField.present ? disableField.value === true : false,
    userInvocable: userField.present ? (userField.invalid ? null : userField.value === true) : null,
    loadable,
    extraKeys,
    safeToToggle,
    diagnostics,
    hardFailure: !parsed.ok,
  };
}

/** 是否允许「只改一行」启停：解析必须成功、无 BOM、无 L2 特性、行尾统一、无制表符。 */
/**
 * 是否是 frontmatter 里的顶层键行：0 缩进、键名后紧跟冒号（键名与冒号之间不允许空白，
 * 保证解析契约一致；缩进的子键不匹配）。
 */
export function isTopLevelKeyLine(lineText: string, key: string): boolean {
  if (!lineText.startsWith(key)) return false;
  const rest = lineText.slice(key.length);
  return rest.startsWith(":") && (INDENT.exec(lineText)?.[0] ?? "").length === 0;
}

/** 是否允许「只改一行」启停：解析必须成功、无 BOM、无 L2 特性、行尾统一、无制表符。 */
export function evaluatedSafeToToggle(parsed: FrontmatterParseResult, doc: FrontmatterDoc): boolean {
  if (!parsed.ok) return false;
  if (doc.bom) return false;
  if (parsed.l2.length > 0) return false;
  if (doc.eol === "mixed") return false;
  for (const line of doc.block) {
    if (line.text.includes("\t")) return false;
  }
  return true;
}

function describeL2(code: string): string {
  switch (code) {
    case "anchor":
      return "锚点 &";
    case "alias":
      return "别名 *";
    case "flow-collection":
      return "流式集合 [ ] / { }";
    case "tag":
      return "显式标签 ! / !!";
    case "block-sequence":
      return "块序列";
    case "multi-document":
      return "多文档分隔";
    case "indentation-tab":
      return "制表符缩进";
    case "unterminated-quote":
      return "未闭合的引号";
    default:
      return code;
  }
}

function describeL1(code: string): string {
  switch (code) {
    case "blank-line":
      return "空行";
    case "comment":
      return "注释";
    case "nested-indent":
      return "缩进的嵌套内容";
    default:
      return code;
  }
}

/* ---------------- 只改一行的启停改写 ---------------- */

export interface ToggleResult {
  ok: boolean;
  /** 新文件内容（ok=true 时有效） */
  content: Buffer;
  changed: boolean;
  /** ok=false 的原因（中文） */
  reason?: string;
}

/**
 * 把顶层（0 缩进）的 disable-model-invocation 改为 enabled ? false : true。
 * - 查找范围**只限 frontmatter 区段**（首行 --- 之后到闭合 --- 之前）；正文里出现的同名行
 *   （例如文档里的用法示例）绝不被当作设置，也绝不被改写。
 * - 只替换该行的「值 token」：冒号后的空白、行尾注释（# 之后的内容）、行尾空白、
 *   其余字节（含 BOM、原 EOL、末尾换行有无）逐字不变。
 * - enabled 且键不存在 -> 不改文件（changed=false）。
 * - 停用且键不存在 -> 在闭合 --- 之前插入一行，用原文件的 EOL 风格。
 */
export function rewriteDisableModelInvocation(buffer: Buffer, enabled: boolean): ToggleResult {
  const { doc, validUtf8 } = decodeDocument(buffer);
  if (!validUtf8) return { ok: false, content: buffer, changed: false, reason: "文件不是合法 UTF-8，无法安全改写。" };
  if (doc.bom)
    return { ok: false, content: buffer, changed: false, reason: "文件以 BOM 开头，直接改写会破坏 frontmatter 语义。" };
  if (!doc.present) {
    return {
      ok: false,
      content: buffer,
      changed: false,
      reason:
        doc.failure === "no-closing"
          ? "frontmatter 没有闭合的 ---，无法定位改写位置。"
          : "文件第一行不是裸 ---，没有可改写的 frontmatter。",
    };
  }
  const parsed = parseFrontmatterBlock(doc.block);
  if (!parsed.ok)
    return { ok: false, content: buffer, changed: false, reason: "frontmatter 当前不能被安全解析，已拒绝改写。" };
  if (parsed.l2.length > 0)
    return { ok: false, content: buffer, changed: false, reason: "frontmatter 使用了高级 YAML 特性，已拒绝改写。" };
  if (doc.eol === "mixed")
    return {
      ok: false,
      content: buffer,
      changed: false,
      reason: "文件混用了 LF 与 CRLF 行尾，已拒绝改写以免扩大破坏。",
    };

  const bodyText = doc.bom ? doc.raw.slice(1) : doc.raw;
  const all = splitLines(bodyText);
  const want = enabled ? "false" : "true";
  const target = "disable-model-invocation";

  // 只认 frontmatter 区段内的顶层行（下标范围 1 .. doc.closeIndex-1，即 doc.block）。
  // 解析器给出的 lineIndex 是权威位置；若解析器没记录（例如形态异常），退化为在区段内按
  // 「0 缩进 + 键名 + 冒号」精确匹配，绝不到正文里去找。
  const entry = parsed.entries.get(target);
  let hitIndex = -1;
  if (entry !== undefined && entry.kind !== "map" && entry.kind !== "list") {
    const candidate = 1 + entry.lineIndex;
    if (candidate > 0 && candidate < doc.closeIndex && isTopLevelKeyLine(all[candidate]?.text ?? "", target)) {
      hitIndex = candidate;
    }
  }
  if (hitIndex < 0) {
    for (let i = 1; i < doc.closeIndex; i += 1) {
      if (isTopLevelKeyLine(all[i].text, target)) {
        hitIndex = i;
        break;
      }
    }
  }

  if (hitIndex < 0) {
    if (enabled) return { ok: true, content: buffer, changed: false };
    const eol = doc.eol === "crlf" ? "\r\n" : "\n";
    const closeLine = all[doc.closeIndex];
    const insertText = target + ": true" + (closeLine.eol === "" ? eol : closeLine.eol);
    const insertAt = closeLine.start;
    const out = bodyText.slice(0, insertAt) + insertText + bodyText.slice(insertAt);
    return { ok: true, content: Buffer.from((doc.bom ? "\uFEFF" : "") + out, "utf8"), changed: true };
  }

  const line = all[hitIndex];
  const colon = line.text.indexOf(":");
  const rest = line.text.slice(colon + 1);
  // 行尾注释不参与取值判断，但必须原样留在原地：'true # note' -> 'false # note'
  const split = splitValueComment(rest);
  const currentValue = split.value.trim();
  const currentBool = frontmatterBoolean({ [target]: parseScalarToken(currentValue).value }, target);
  if (currentBool.invalid) {
    return {
      ok: false,
      content: buffer,
      changed: false,
      reason: "disable-model-invocation 当前取值「" + currentValue + "」非法，DSH 会丢弃该技能；请先手工修正。",
    };
  }
  const isDisabled = currentBool.value === true;
  if (isDisabled === !enabled) {
    return { ok: true, content: buffer, changed: false };
  }

  // 只替换「值 token」这一段：冒号、冒号后的空白、行尾注释、行尾空白全部逐字节保留。
  const lead = (/^[ \t]*/.exec(rest)?.[0] ?? "").length;
  const valueStart = line.start + colon + 1 + lead;
  const valueEnd = line.start + colon + 1 + split.value.length;
  const out = bodyText.slice(0, valueStart) + want + bodyText.slice(valueEnd);
  if (out === bodyText) return { ok: true, content: buffer, changed: false };
  return { ok: true, content: Buffer.from((doc.bom ? "\uFEFF" : "") + out, "utf8"), changed: true };
}
