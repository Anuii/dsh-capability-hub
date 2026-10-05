/**
 * DSH 判断「技能能否加载」的规则（复刻 @deepseek-ai/dsh-skill-filesystem 的 parseSkillFile / parseInvocationPolicy），
 * 并把 DSH「静默丢弃」的结果翻成中文诊断。YAML 的取值来自 DSH 同一个 yaml 库（yaml-block.ts）。
 */

import type { Buffer } from "node:buffer";
import type { Diagnostic } from "../../contract/local.ts";
import type { YamlLib } from "../../contract/yaml.ts";
import { blockSource, decodeDocument, type FrontmatterDoc } from "./document.ts";
import { readBlock, type BlockRead, type TopEntry } from "./yaml-block.ts";

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
export function frontmatterBoolean(data: Record<string, unknown>, key: string): BooleanFieldResult {
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
  data: Record<string, unknown>;
  entries: Map<string, TopEntry>;
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

export function evaluate(yaml: YamlLib, buffer: Buffer): EvaluationResult {
  const { doc, validUtf8 } = decodeDocument(buffer);
  const diagnostics: Diagnostic[] = [];
  const empty: Record<string, unknown> = {};
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

  const parsed = readBlock(yaml, blockSource(doc).text);
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

  const safeToToggle = safeToRewrite(parsed, doc);

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

/** 是否允许「只改一行」启停：解析成功、无 BOM、无高级特性、行尾统一、区段里没有制表符。 */
export function safeToRewrite(parsed: BlockRead, doc: FrontmatterDoc): boolean {
  if (!parsed.ok) return false;
  if (doc.bom) return false;
  if (parsed.l2.length > 0) return false;
  if (doc.eol === "mixed") return false;
  return !doc.block.some((line) => line.text.includes("\t"));
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
