/**
 * MCP 页的**编辑**逻辑：服务器草稿与全局设置草稿、JSON 互转、校验、把宿主的错误路径映射回字段。
 *
 * 字段白名单、默认值与校验规则不在这里写：它们在 ../rules/，宿主落盘前也用同一份（ADR-0008）。
 * 这里只补「表单才有」的检查——数值框里填的不是数字、列表编辑器里留了空行。
 *
 * 两条贯穿全篇的规则（D-C1 / D-C3 / D-C5）：
 *   1. **默认值不落盘**：草稿 `values` 里只放「用户显式设置」的字段；键不存在 = 取默认值，「恢复默认」= 删键。
 *   2. **遮罩原样往返**：env / headers 的值在视图里是遮罩占位符；草稿原样保留它，提交时宿主按 originalName 合并回原值。
 *
 * 纯函数，不碰 DOM / React / 网络（见 test/mcp/client/draft.test.ts）。
 */

import { t } from "./strings.ts";
import {
  HIDDEN,
  NUMERIC_FIELDS,
  SERVER_FIELDS,
  SHARED_FIELDS,
  TRANSPORT_FIELDS,
  parseServerInput,
} from "../rules/server.ts";
import { DEFAULT_OUTPUT_GUARD, parseSettingsInput } from "../rules/settings.ts";
import { isPlainObject } from "../rules/values.ts";
import type { FieldError, McpSettings, ServerView, Transport } from "../contract/config.ts";

/* ---------------- 小工具 ---------------- */

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 数字或数字文本 → 数字（解析不了返回 undefined）。 */
export function toNumeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 字段值 → 输入框里的文本。 */
export function numericText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return String(value);
  return String(value);
}

/** 是不是「空值」（空串 / 空数组 / 空对象 / null / undefined = 未设置）。 */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "" && value !== HIDDEN;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/* ---------------- 草稿模型 ---------------- */

/**
 * 服务器草稿：`values` 里只有显式设置过的字段（键不存在 = 取默认值）。
 * 数值字段存字符串（用户可能还没输完），提交/转 JSON 时再转数字。
 */
export interface ServerDraft {
  values: Record<string, unknown>;
}

/** 新建草稿（serverName/transport 一定在，其余走默认值）。 */
export function emptyServerDraft(transport: Transport = "stdio"): ServerDraft {
  return { values: { serverName: "", transport } };
}

/** 从 ServerView（已遮罩）建草稿：只搬 setFields 里的字段 + serverName/transport。 */
export function draftFromView(view: ServerView): ServerDraft {
  const values: Record<string, unknown> = {};
  const raw = view as unknown as Record<string, unknown>;
  for (const field of SERVER_FIELDS) {
    if (!view.setFields.includes(field)) continue;
    if (field === "idleTimeout") {
      values.idleTimeout = view.idleTimeoutMin;
      continue;
    }
    if (field === "serverName" || field === "transport") continue;
    if (raw[field] !== undefined) values[field] = cloneValue(raw[field]);
  }
  values.serverName = view.serverName;
  values.transport = view.transport;
  return { values };
}

/** 从任意对象（JSON 模式 / 导入）建草稿：只保留白名单字段，数值字段转成文本。 */
export function draftFromValues(input: Record<string, unknown>): ServerDraft {
  const values: Record<string, unknown> = {};
  for (const field of SERVER_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    if (value === undefined || value === null) continue;
    values[field] = NUMERIC_FIELDS.includes(field) ? numericText(value) : cloneValue(value);
  }
  if (values.serverName === undefined) values.serverName = "";
  if (values.transport === undefined) values.transport = "stdio";
  return { values };
}

export function draftHas(draft: ServerDraft, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(draft.values, field);
}

export function draftValue(draft: ServerDraft, field: string): unknown {
  return draft.values[field];
}

/** 写入一个字段；空值（空串 / 空数组 / 空对象 / false 布尔）等于「回到默认值」，直接删键。 */
export function withField(draft: ServerDraft, field: string, value: unknown): ServerDraft {
  const values = { ...draft.values };
  const isFalseBoolean = typeof value === "boolean" && !value;
  if (isEmptyValue(value) || isFalseBoolean) {
    delete values[field];
    return { values };
  }
  values[field] = cloneValue(value);
  return { values };
}

/** 删除一个字段（恢复默认）。 */
export function withoutField(draft: ServerDraft, field: string): ServerDraft {
  const values = { ...draft.values };
  delete values[field];
  return { values };
}

/** 取某一行的 meta（没有就空对象）。 */
export function draftMeta(draft: ServerDraft): Record<string, unknown> {
  const meta = draft.values.meta;
  return isPlainObject(meta) ? meta : {};
}

/** 写某一行的 meta 子字段；meta 空了就整个删掉。 */
export function withMetaField(draft: ServerDraft, key: string, value: unknown): ServerDraft {
  const meta = { ...draftMeta(draft) };
  if (isEmptyValue(value)) delete meta[key];
  else meta[key] = cloneValue(value);
  return withField(draft, "meta", meta);
}

/**
 * 草稿 → 提交给服务端的对象（数值字段转数字，serverName 去空白）。
 *
 * 提交时按**当前传输方式**裁掉无关字段（stdio 不带 url/headers，http 不带 command/args/env/…），
 * 但草稿本身保留它们 —— 这样用户在两种传输方式之间来回切换时不会丢已填的内容。
 */
export function draftToSubmit(draft: ServerDraft): Record<string, unknown> {
  const transport: Transport = draft.values.transport === "streamable-http" ? "streamable-http" : "stdio";
  const allowed = new Set<string>([...SHARED_FIELDS, ...TRANSPORT_FIELDS[transport]]);
  const out: Record<string, unknown> = {};
  for (const field of SERVER_FIELDS) {
    if (!draftHas(draft, field)) continue;
    if (!allowed.has(field)) continue;
    const value = draft.values[field];
    if (field === "serverName") {
      out.serverName = typeof value === "string" ? value.trim() : value;
      continue;
    }
    if (NUMERIC_FIELDS.includes(field)) {
      const parsed = toNumeric(value);
      if (parsed !== undefined) out[field] = parsed;
      continue;
    }
    out[field] = cloneValue(value);
  }
  if (out.serverName === undefined) out.serverName = "";
  if (out.transport === undefined) out.transport = "stdio";
  return out;
}

/** 草稿 → JSON 文本（键顺序固定，遮罩值原样保留）。 */
export function draftToJsonText(draft: ServerDraft): string {
  return JSON.stringify(draftToSubmit(draft), null, 2);
}

/** JSON 文本 → 草稿（只解析，不做业务校验）。 */
export function parseJsonServer(text: string): {
  draft?: ServerDraft;
  values?: Record<string, unknown>;
  error?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!isPlainObject(parsed)) return { error: t("mcp.json.needObject") };
  return { values: parsed, draft: draftFromValues(parsed) };
}

/* ---------------- 校验 ---------------- */

export interface ValidateDraftOptions {
  /** 已占用的服务器名（应包含除被编辑服务器之外的全部名字）。 */
  existingNames?: readonly string[];
  /** 被编辑服务器的原名。 */
  originalName?: string;
}

function numericErrorText(field: string): string {
  if (field === "toolCallTimeoutMs") return "必须是数字（≤0 表示不设超时）。";
  if (field === "idleTimeout") return "必须是不小于 0 的整数（分钟，0 表示不回收）。";
  return "必须是不小于 0 的整数（毫秒）。";
}

/** 只有表单才有的问题：数值框里不是数字、列表编辑器里留了空行（这些在提交体里已经看不出来）。 */
function draftOnlyErrors(draft: ServerDraft): FieldError[] {
  const errors: FieldError[] = [];
  const values = draft.values;
  for (const field of NUMERIC_FIELDS) {
    if (draftHas(draft, field) && toNumeric(values[field]) === undefined) {
      errors.push({ path: "server." + field, message: numericErrorText(field) });
    }
  }
  for (const field of ["args", "includeTools", "excludeTools"] as const) {
    const list = values[field];
    if (!Array.isArray(list)) continue;
    list.forEach((item, index) => {
      if (typeof item === "string" && item.trim() === "") {
        errors.push({
          path: "server." + field + "[" + String(index) + "]",
          message: "第 " + String(index + 1) + " 项不能为空。",
        });
      }
    });
  }
  if (isPlainObject(values.searchKeywords)) {
    for (const [tool, list] of Object.entries(values.searchKeywords)) {
      if (tool.trim() === "") errors.push({ path: "server.searchKeywords", message: "工具名不能为空。" });
      if (Array.isArray(list) && list.some((item) => typeof item === "string" && item.trim() === "")) {
        errors.push({ path: "server.searchKeywords." + tool, message: "关键词不能为空。" });
      }
    }
  }
  const tags = draftMeta(draft).tags;
  if (Array.isArray(tags) && tags.some((item) => typeof item === "string" && item.trim() === "")) {
    errors.push({ path: "server.meta.tags", message: "标签不能为空。" });
  }
  return errors;
}

/**
 * 校验草稿：表单自己的检查 + 与宿主同一份规则（对提交体做校验）。
 * 返回的 path 形如 "server.<field>"，可被 fieldOfPath 映射回字段；同一路径只报表单那条。
 */
export function validateDraft(draft: ServerDraft, opts: ValidateDraftOptions = {}): FieldError[] {
  const own = draftOnlyErrors(draft);
  const rules = parseServerInput(draftToSubmit(draft), {
    ...(opts.existingNames === undefined ? {} : { existingNames: opts.existingNames }),
    ...(opts.originalName === undefined ? {} : { originalName: opts.originalName }),
  }).errors;
  const taken = new Set(own.map((error) => error.path));
  return [...own, ...rules.filter((error) => !taken.has(error.path))];
}

/* ---------------- 错误映射 ---------------- */

/** 服务端 `server.env.KEY` / `server.args[0]` / `settings.x.y` → 表单里的字段 id。 */
export function fieldOfPath(path: string): string {
  if (typeof path !== "string" || path === "") return "__form";
  if (path.startsWith("settings.")) return path;
  if (path === "settings") return "settings";
  const trimmed = path.startsWith("server.") ? path.slice("server.".length) : path;
  if (trimmed === "" || trimmed === "server") return "__form";
  const bracket = trimmed.indexOf("[");
  const head = bracket === -1 ? trimmed : trimmed.slice(0, bracket);
  const dot = head.indexOf(".");
  if (dot === -1) return head;
  const outer = head.slice(0, dot);
  if (outer === "meta") return head;
  return outer;
}

/** FieldError[] → 「字段 id → 消息列表」。 */
export function groupErrors(errors: readonly FieldError[] | undefined): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const error of errors ?? []) {
    if (error === null || typeof error !== "object") continue;
    const path = typeof error.path === "string" ? error.path : "";
    const message = typeof error.message === "string" ? error.message : "";
    if (message === "") continue;
    const field = fieldOfPath(path);
    const key = field === "__form" ? "__form" : field;
    groups[key] = [...(groups[key] ?? []), message];
  }
  return groups;
}

export function errorsFor(groups: Record<string, string[]>, field: string): string[] {
  return groups[field] ?? [];
}

/* ---------------- 全局设置 ---------------- */

/** 全局设置草稿：键存在 = 用户设置过（其余走默认值）。 */
export interface SettingsDraft {
  values: Record<string, unknown>;
}

export function settingsDraftFrom(settings: McpSettings, settingsSet: readonly string[]): SettingsDraft {
  const set = new Set(settingsSet);
  const values: Record<string, unknown> = {};
  if (set.has("idleTimeout")) values.idleTimeout = String(settings.idleTimeoutMin);
  if (set.has("failureBackoffMs")) values.failureBackoffMs = String(settings.failureBackoffMs);
  if (set.has("outputGuard")) {
    values["outputGuard.enabled"] = settings.outputGuard.enabled;
    values["outputGuard.maxBytes"] = String(settings.outputGuard.maxBytes);
    values["outputGuard.maxLines"] = String(settings.outputGuard.maxLines);
  }
  return { values };
}

export function settingsHas(draft: SettingsDraft, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(draft.values, field);
}

export function withSetting(draft: SettingsDraft, field: string, value: unknown): SettingsDraft {
  const values = { ...draft.values };
  if (value === undefined || value === null) delete values[field];
  else values[field] = value;
  return { values };
}

export function withoutSetting(draft: SettingsDraft, field: string): SettingsDraft {
  const values = { ...draft.values };
  delete values[field];
  return { values };
}

/** 设置草稿 → 提交体（只含设置过的项）。 */
export function settingsToSubmit(draft: SettingsDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const idle = toNumeric(draft.values.idleTimeout);
  if (settingsHas(draft, "idleTimeout") && idle !== undefined) out.idleTimeout = idle;
  const backoff = toNumeric(draft.values.failureBackoffMs);
  if (settingsHas(draft, "failureBackoffMs") && backoff !== undefined) out.failureBackoffMs = backoff;

  const guardKeys = ["outputGuard.enabled", "outputGuard.maxBytes", "outputGuard.maxLines"];
  if (guardKeys.some((key) => settingsHas(draft, key))) {
    const maxBytes = toNumeric(draft.values["outputGuard.maxBytes"]);
    const maxLines = toNumeric(draft.values["outputGuard.maxLines"]);
    const enabled = draft.values["outputGuard.enabled"];
    out.outputGuard = {
      enabled: typeof enabled === "boolean" ? enabled : DEFAULT_OUTPUT_GUARD.enabled,
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(maxLines === undefined ? {} : { maxLines }),
    };
  }
  return out;
}

/** 校验设置草稿（path = 设置字段 id）：数值框里不是数字由这里报，其余与宿主同一份规则。 */
export function validateSettingsDraft(draft: SettingsDraft): FieldError[] {
  const own: FieldError[] = [];
  for (const [field, label] of [
    ["idleTimeout", "必须是不小于 0 的整数（分钟，0 表示不回收）。"],
    ["failureBackoffMs", "必须是不小于 0 的整数（毫秒）。"],
    ["outputGuard.maxBytes", "必须是大于 0 的整数（字节）。"],
    ["outputGuard.maxLines", "必须是大于 0 的整数（行）。"],
  ] as const) {
    if (settingsHas(draft, field) && toNumeric(draft.values[field]) === undefined) {
      own.push({ path: "settings." + field, message: label });
    }
  }
  const taken = new Set(own.map((error) => error.path));
  return [...own, ...parseSettingsInput(settingsToSubmit(draft)).errors.filter((error) => !taken.has(error.path))];
}
