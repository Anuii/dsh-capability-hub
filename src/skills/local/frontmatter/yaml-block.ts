/**
 * 用 DSH 自带的 yaml 库解析 frontmatter 区段（ADR-0006）：取值与 DSH 判断「能否加载」完全一致，
 * 另外整理出两类给本插件自己用的信息——
 *   - 「只改一行」需要的位置：每个顶层键的值在源码里的范围（只有单行的纯量 / 引号标量才有）；
 *   - 安全闸门：高级特性（锚点、别名、显式标签、流式集合、%YAML 指令、制表符缩进）一律不改写。
 * 解析失败时 DSH 会丢弃整个技能，这里把 yaml 的报错翻成中文诊断。
 */

import type { Node as YamlNode, Pair, Scalar } from "yaml";
import type { YamlLib } from "../../contract/yaml.ts";

/** 一个顶层键。 */
export interface TopEntry {
  key: string;
  kind: "scalar" | "map" | "list" | "null";
  value: unknown;
  /** 值在区段源码里的 [起, 止)；只有单行的纯量 / 引号标量才有（其余形态不做「只改一行」） */
  valueRange?: [number, number];
}

export interface BlockRead {
  /** 没有任何解析错误（DSH 能拿到一个映射） */
  ok: boolean;
  data: Record<string, unknown>;
  entries: Map<string, TopEntry>;
  /** 顶层键的出现顺序 */
  order: string[];
  errors: { code: string; message: string }[];
  /** 不允许改写的高级特性（describeL2 的代码） */
  l2: string[];
  /** 只是提示的形态：空行、整行注释、缩进内容 */
  l1: string[];
}

/** 值写在后面几行的顶层键：冒号后为空（或只有注释），或是块标量头 | / >。 */
const OPENS_BLOCK = /^[A-Za-z][A-Za-z0-9_-]*:[ \t]*(?:[|>][+-]?[0-9]*[+-]?)?[ \t]*(?:#.*)?$/;

const TAB_MESSAGE = "frontmatter 中出现了制表符缩进，yaml 库会解析失败，DSH 将忽略该技能。";

function pushOnce(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/** 解析 frontmatter 区段（text 就是 DSH 交给 yaml.parse 的那一段）。 */
export function readBlock(yaml: YamlLib, text: string): BlockRead {
  const errors: { code: string; message: string }[] = [];
  const l1: string[] = [];
  const l2: string[] = [];
  const addError = (code: string, message: string): void => {
    if (!errors.some((entry) => entry.code === code && entry.message === message)) errors.push({ code, message });
  };

  // 逐行的形态：只是提示，不影响取值。顶层键的值写在后面几行（嵌套映射、块序列、块标量）时，
  // 这些缩进行与其中的空行属于那个值，不算提示；顶层的空行、整行注释、无处归属的缩进行才算。
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop(); // 区段以换行结尾，split 会多出一个空串
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (line.startsWith("%")) pushOnce(l2, "multi-document");
    if (trimmed === "") {
      pushOnce(l1, "blank-line");
      continue;
    }
    if (trimmed.startsWith("#")) {
      pushOnce(l1, "comment");
      continue;
    }
    if (/^[ \t]/.test(line)) {
      pushOnce(l1, "nested-indent");
      continue;
    }
    if (OPENS_BLOCK.test(line)) {
      while (i + 1 < lines.length && (lines[i + 1]!.trim() === "" || /^[ \t]/.test(lines[i + 1]!))) i += 1;
    }
  }

  const document = yaml.parseDocument(text);
  for (const error of document.errors) {
    const line = error.linePos?.[0]?.line;
    if (error.code === "TAB_AS_INDENT") {
      pushOnce(l2, "indentation-tab");
      addError("YAML_INVALID", TAB_MESSAGE);
    } else if (l2.includes("multi-document") && error.code === "MISSING_CHAR") {
      addError("YAML_UNSUPPORTED", "frontmatter 内出现多文档分隔符或 %YAML 指令，DSH 的 yaml 解析会失败。");
    } else if (error.code !== "DUPLICATE_KEY") {
      addError(
        "YAML_INVALID",
        "frontmatter" +
          (line === undefined ? "" : " 第 " + String(line) + " 行") +
          "不是合法的 YAML，DSH 会忽略该技能（yaml：" +
          error.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "") +
          "）。",
      );
    }
  }

  // 高级特性：DSH 照样能读，但本插件不改写这种文件
  yaml.visit(document, {
    Alias() {
      pushOnce(l2, "alias");
    },
    Node(_key, node) {
      if (node.anchor !== undefined) pushOnce(l2, "anchor");
      if (node.tag !== undefined) pushOnce(l2, "tag");
      if ((yaml.isMap(node) || yaml.isSeq(node)) && node.flow === true) pushOnce(l2, "flow-collection");
    },
  });

  const entries = new Map<string, TopEntry>();
  const order: string[] = [];
  const contents = document.contents;
  if (yaml.isMap(contents)) {
    const seen = new Set<string>();
    for (const item of contents.items as Pair<unknown, unknown>[]) {
      const key = yaml.isScalar(item.key) ? String((item.key as Scalar).value) : String(item.key);
      if (seen.has(key)) {
        addError(
          "YAML_DUPLICATE_KEY",
          "frontmatter 中出现重复的顶层键「" + key + "」，yaml 库默认会因此解析失败，DSH 将忽略该技能。",
        );
        continue;
      }
      seen.add(key);
      order.push(key);
      entries.set(key, describe(yaml, key, item.value, text));
    }
  } else if (yaml.isSeq(contents)) {
    addError(
      "YAML_UNSUPPORTED",
      "frontmatter 顶层是块序列（- item），yaml 会解析成数组，DSH 要求 frontmatter 是映射，因此该技能会被忽略。",
    );
  } else if (errors.length === 0) {
    addError("YAML_NOT_MAP", "frontmatter 没有解析出任何键值，yaml 库会得到 null，DSH 将忽略该技能。");
  }

  let data: Record<string, unknown> = {};
  try {
    const value = document.toJS() as unknown;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) data = value as Record<string, unknown>;
  } catch {
    // 有解析错误时尽力而为；ok=false 已经说明 DSH 会丢弃该技能
  }
  return { ok: errors.length === 0, data, entries, order, errors, l1, l2 };
}

function describe(yaml: YamlLib, key: string, node: unknown, text: string): TopEntry {
  if (yaml.isMap(node)) return { key, kind: "map", value: node.toJSON() };
  if (yaml.isSeq(node)) return { key, kind: "list", value: node.toJSON() };
  if (!yaml.isScalar(node)) return { key, kind: "null", value: null };
  const scalar = node as Scalar & YamlNode;
  const value = scalar.value;
  const [start, end] = scalar.range ?? [0, 0];
  const singleLine =
    (scalar.type === "PLAIN" || scalar.type === "QUOTE_DOUBLE" || scalar.type === "QUOTE_SINGLE") &&
    end > start &&
    !/[\r\n]/.test(text.slice(start, end));
  return {
    key,
    kind: value === null ? "null" : "scalar",
    value,
    ...(singleLine ? { valueRange: [start, end] as [number, number] } : {}),
  };
}
