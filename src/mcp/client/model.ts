/**
 * MCP 标签页的**纯逻辑**（草稿模型、默认值/已设置、JSON 互转、校验镜像、错误路径映射、排序、全局设置）。
 *
 * 这里刻意不碰 DOM、不碰 React、不发请求：全部可以用 node:test 直接测
 * （见 test/mcp/client/model.test.ts）。文案一律走 strings.ts 的 t()，
 * 所以测试断言的是界面上真正会出现的字。
 *
 * 两条贯穿全篇的规则（对应 D-C1 / D-C3 / D-C5）：
 *   1. **默认值不落盘**：草稿 `values` 里只放「用户显式设置」的字段；
 *      键不存在 = 取默认值。「恢复默认」就是从 `values` 里删掉这个键。
 *   2. **遮罩原样往返**：env / headers 的值在视图里是 "***hidden***"；
 *      草稿原样保留它，提交时由服务端按 originalName 合并回原值。
 */

import { t } from "./strings.ts";
import type { FieldError, Lifecycle, McpSettings, ServerView, Transport } from "../contract/config.ts";
import type { RuntimeFailureView, RuntimeServerView, RuntimeStatus } from "../contract/runtime.ts";

/** 遮罩占位符（与宿主 src/mcp/config/mask.ts 的 HIDDEN 一致）。 */
export const HIDDEN_VALUE = "***hidden***";

/** 与宿主 schema.ts 同一套正则与枚举（改一处要改两处）。 */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const TRANSPORTS: readonly Transport[] = ["stdio", "streamable-http"];
export const LIFECYCLES: readonly Lifecycle[] = ["lazy", "lazy-keep-alive", "eager", "keep-alive"];

/** 服务器字段顺序（= 宿主 SERVER_FIELDS，也是 JSON 模式里的键顺序）。 */
export const SERVER_FIELD_ORDER: readonly string[] = [
  "serverName",
  "transport",
  "command",
  "args",
  "env",
  "envFrom",
  "allowEmpty",
  "envFromTimeoutMs",
  "cwd",
  "url",
  "headers",
  "toolCallTimeoutMs",
  "lifecycle",
  "idleTimeout",
  "includeTools",
  "excludeTools",
  "searchKeywords",
  "disabled",
  "debug",
  "meta",
];

/** 数值型字段（草稿里存字符串，提交时转成数字）。 */
export const NUMERIC_FIELDS: readonly string[] = ["envFromTimeoutMs", "toolCallTimeoutMs", "idleTimeout"];

/** 与传输方式相关的字段（切换传输方式时会被裁剪）。 */
export const TRANSPORT_FIELDS: Record<Transport, readonly string[]> = {
  stdio: ["command", "args", "cwd", "env", "envFrom", "allowEmpty", "envFromTimeoutMs"],
  "streamable-http": ["url", "headers"],
};

/** 两种传输方式都适用的字段。 */
export const SHARED_FIELDS: readonly string[] = [
  "serverName",
  "transport",
  "toolCallTimeoutMs",
  "lifecycle",
  "idleTimeout",
  "includeTools",
  "excludeTools",
  "searchKeywords",
  "disabled",
  "debug",
  "meta",
];

/** 全局设置默认值（与宿主 schema.ts 的 SETTINGS_DEFAULTS / DEFAULT_OUTPUT_GUARD 一致）。 */
export const SETTINGS_DEFAULTS = {
  idleTimeoutMin: 10,
  outputGuard: { enabled: true, maxBytes: 51200, maxLines: 2000 },
  failureBackoffMs: 60000,
} as const;

/* ---------------- 小工具 ---------------- */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  if (typeof value === "string") return value.trim() === "" && value !== HIDDEN_VALUE;
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
  for (const field of SERVER_FIELD_ORDER) {
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
  for (const field of SERVER_FIELD_ORDER) {
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
  for (const field of SERVER_FIELD_ORDER) {
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

/* ---------------- 校验（宿主 schema.ts 的镜像） ---------------- */

export interface ValidateDraftOptions {
  /** 已占用的服务器名（应包含除被编辑服务器之外的全部名字）。 */
  existingNames?: readonly string[];
  /** 被编辑服务器的原名。 */
  originalName?: string;
}

/** 校验草稿；返回的 path 形如 "server.<field>"，可被 fieldOfPath 映射回字段。 */
export function validateDraft(draft: ServerDraft, opts: ValidateDraftOptions = {}): FieldError[] {
  const errors: FieldError[] = [];
  const values = draft.values;

  const serverName = typeof values.serverName === "string" ? values.serverName : "";
  if (serverName.trim() === "") {
    errors.push({ path: "server.serverName", message: t("mcp.field.serverName") + "不能为空。" });
  } else if (!SERVER_NAME_RE.test(serverName)) {
    errors.push({ path: "server.serverName", message: "只能包含字母、数字、下划线、连字符，长度 1–32。" });
  } else {
    const occupied = (opts.existingNames ?? []).filter((name) => name !== opts.originalName);
    if (occupied.includes(serverName)) {
      errors.push({ path: "server.serverName", message: "服务器名称「" + serverName + "」已存在。" });
    }
  }

  const transport = values.transport;
  if (transport !== "stdio" && transport !== "streamable-http") {
    errors.push({ path: "server.transport", message: "传输方式只能是 stdio 或 streamable-http。" });
  }

  for (const field of NUMERIC_FIELDS) {
    if (!draftHas(draft, field)) continue;
    const parsed = toNumeric(values[field]);
    if (parsed === undefined) {
      errors.push({ path: "server." + field, message: numericErrorText(field) });
      continue;
    }
    if (field === "toolCallTimeoutMs") continue;
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      errors.push({ path: "server." + field, message: numericErrorText(field) });
    }
  }

  const envFrom = isPlainObject(values.envFrom) ? (values.envFrom as Record<string, unknown>) : {};
  if (draftHas(draft, "envFrom") && transport !== "stdio") {
    errors.push({ path: "server.envFrom", message: "envFrom 只能用于 stdio 传输的服务器。" });
  }
  for (const [key, value] of Object.entries(envFrom)) {
    if (key.trim() === "") {
      errors.push({ path: "server.envFrom", message: "变量名不能为空。" });
      continue;
    }
    if (!ENV_NAME_RE.test(key)) {
      errors.push({
        path: "server.envFrom." + key,
        message: "环境变量名「" + key + "」不合法（字母、数字、下划线，不能以数字开头）。",
      });
    }
    if (typeof value !== "string" || value.trim() === "") {
      errors.push({ path: "server.envFrom." + key, message: "取值命令不能为空。" });
    }
  }

  const env = isPlainObject(values.env) ? (values.env as Record<string, unknown>) : {};
  for (const key of Object.keys(env)) {
    if (key.trim() === "") errors.push({ path: "server.env", message: "变量名不能为空。" });
    if (Object.prototype.hasOwnProperty.call(envFrom, key)) {
      errors.push({
        path: "server.envFrom." + key,
        message: "变量「" + key + "」同时出现在 env 与 envFrom 中，只能二选一。",
      });
    }
  }

  const allowEmpty = Array.isArray(values.allowEmpty) ? (values.allowEmpty as unknown[]) : [];
  allowEmpty.forEach((item, index) => {
    const name = typeof item === "string" ? item : "";
    if (!ENV_NAME_RE.test(name)) {
      errors.push({
        path: "server.allowEmpty[" + String(index) + "]",
        message: "「" + String(item) + "」不是合法的环境变量名。",
      });
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(envFrom, name)) {
      errors.push({
        path: "server.allowEmpty[" + String(index) + "]",
        message: "「" + name + "」没有在 envFrom 里声明。",
      });
    }
  });

  for (const field of ["args", "includeTools", "excludeTools"] as const) {
    if (!draftHas(draft, field)) continue;
    const list = values[field];
    if (!Array.isArray(list)) {
      errors.push({ path: "server." + field, message: "必须是字符串数组。" });
      continue;
    }
    list.forEach((item, index) => {
      if (typeof item !== "string" || item.trim() === "") {
        errors.push({
          path: "server." + field + "[" + String(index) + "]",
          message: "第 " + String(index + 1) + " 项不能为空。",
        });
      }
    });
  }

  if (draftHas(draft, "searchKeywords")) {
    const keywords = values.searchKeywords;
    if (!isPlainObject(keywords)) {
      errors.push({ path: "server.searchKeywords", message: "必须是「工具名 → 字符串数组」的对象。" });
    } else {
      for (const [tool, list] of Object.entries(keywords)) {
        if (tool.trim() === "") errors.push({ path: "server.searchKeywords", message: "工具名不能为空。" });
        if (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item.trim() === "")) {
          errors.push({ path: "server.searchKeywords." + tool, message: "关键词必须是非空字符串数组。" });
        }
      }
    }
  }

  if (transport === "stdio") {
    const command = typeof values.command === "string" ? values.command.trim() : "";
    if (command === "") errors.push({ path: "server.command", message: "stdio 传输必须填写启动命令（command）。" });
  } else if (transport === "streamable-http") {
    const url = typeof values.url === "string" ? values.url.trim() : "";
    if (url === "") errors.push({ path: "server.url", message: "streamable-http 传输必须填写服务器地址（url）。" });
    else if (!isHttpUrl(url)) errors.push({ path: "server.url", message: "url 必须是合法的 http/https 地址。" });
  }

  if (draftHas(draft, "meta")) {
    const meta = draftMeta(draft);
    if (isPlainObject(values.meta)) {
      const tags = meta.tags;
      if (tags !== undefined) {
        if (!Array.isArray(tags) || tags.some((item) => typeof item !== "string" || item.trim() === "")) {
          errors.push({ path: "server.meta.tags", message: "标签必须是非空字符串数组。" });
        }
      }
    }
  }

  return errors;
}

function numericErrorText(field: string): string {
  if (field === "toolCallTimeoutMs") return "必须是不小于 0 的整数（≤0 表示不设超时）。";
  if (field === "idleTimeout") return "必须是不小于 0 的整数（分钟，0 表示不回收）。";
  return "必须是不小于 0 的整数（毫秒）。";
}

export function isHttpUrl(value: string): boolean {
  if (value.trim() === "") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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

/* ---------------- 展示格式化 ---------------- */

/** 列表行里的启动摘要：stdio = command + args，http = url。 */
export function serverSummaryText(values: Record<string, unknown>): string {
  const transport = values.transport === "streamable-http" ? "streamable-http" : "stdio";
  if (transport === "streamable-http") {
    const url = typeof values.url === "string" ? values.url : "";
    return url === "" ? t("mcp.row.noUrl") : url;
  }
  const command = typeof values.command === "string" ? values.command : "";
  const args = Array.isArray(values.args) ? values.args.filter((item): item is string => typeof item === "string") : [];
  if (command === "" && args.length === 0) return t("mcp.row.noCommand");
  return [command, ...args].filter((part) => part !== "").join(" ");
}

/** 视图里的服务器摘要（完整版：抽屉副标题、悬停提示用）。 */
export function viewSummaryText(view: ServerView): string {
  return serverSummaryText(view as unknown as Record<string, unknown>);
}

/** 像本机路径的参数（含反斜杠，或以盘符 / 斜杠 / ./ / ../ / ~ 开头）；@scope/pkg 这类包名不算。 */
export function isPathLike(part: string): boolean {
  return part.includes("\\") || /^([A-Za-z]:|\/|\.{1,2}\/|~)/.test(part);
}

/** 路径只留文件名；可执行文件再去掉 .exe / .cmd / .bat。 */
export function shortPart(part: string, executable = false): string {
  let out = part;
  if (isPathLike(part)) {
    const base =
      part
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() ?? "";
    if (base !== "") out = base;
  }
  return executable ? out.replace(/\.(exe|cmd|bat)$/i, "") : out;
}

/**
 * 列表行里的紧凑摘要：stdio = 程序名 + 参数（路径只留文件名），http = 地址原样。
 * 例：D:\\Program Files\\nodejs\\node.exe C:\\x\\server.mjs → node server.mjs；
 *     npx -y @modelcontextprotocol/server-fetch 保持不变。完整命令走悬停提示与详情。
 */
export function compactSummaryText(values: Record<string, unknown>): string {
  if (values.transport === "streamable-http") return serverSummaryText(values);
  const command = typeof values.command === "string" ? values.command : "";
  const args = Array.isArray(values.args) ? values.args.filter((item): item is string => typeof item === "string") : [];
  if (command === "" && args.length === 0) return t("mcp.row.noCommand");
  return [shortPart(command, true), ...args.map((arg) => shortPart(arg))].filter((part) => part !== "").join(" ");
}

export function lifecycleLabel(value: unknown): string {
  switch (value) {
    case "lazy-keep-alive":
      return t("mcp.lifecycle.lazy-keep-alive");
    case "eager":
      return t("mcp.lifecycle.eager");
    case "keep-alive":
      return t("mcp.lifecycle.keep-alive");
    default:
      return t("mcp.lifecycle.lazy");
  }
}

export function transportLabel(value: unknown): string {
  return value === "streamable-http" ? "streamable-http" : "stdio";
}

/** 时间戳（毫秒）→ 本地「YYYY-MM-DD HH:mm」。 */
export function formatTimestamp(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (input: number): string => String(input).padStart(2, "0");
  return (
    String(date.getFullYear()) +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

/* ---------------- 排序 ---------------- */

/** 拖动排序：把 from 位置的项挪到 to 位置。 */
export function reorderNames(names: readonly string[], from: number, to: number): string[] {
  const next = [...names];
  if (from < 0 || from >= next.length) return next;
  const clamped = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  next.splice(clamped, 0, item);
  return next;
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
      enabled: typeof enabled === "boolean" ? enabled : SETTINGS_DEFAULTS.outputGuard.enabled,
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(maxLines === undefined ? {} : { maxLines }),
    };
  }
  return out;
}

/** 校验设置草稿（path = 设置字段 id）。 */
export function validateSettingsDraft(draft: SettingsDraft): FieldError[] {
  const errors: FieldError[] = [];
  const natural = (field: string, label: string, min: number): void => {
    if (!settingsHas(draft, field)) return;
    const parsed = toNumeric(draft.values[field]);
    if (parsed === undefined || !Number.isSafeInteger(parsed) || parsed < min) {
      errors.push({ path: "settings." + field, message: label });
    }
  };
  natural("idleTimeout", "必须是不小于 0 的整数（分钟，0 表示不回收）。", 0);
  natural("failureBackoffMs", "必须是不小于 0 的整数（毫秒）。", 0);
  natural("outputGuard.maxBytes", "必须是大于 0 的整数（字节）。", 1);
  natural("outputGuard.maxLines", "必须是大于 0 的整数（行）。", 1);
  return errors;
}

/* ------------------------------------------------------------------ *
 * UI-B：列表视图用的纯逻辑（筛选、状态点、副标题、缓存摘要）
 * 全部是纯函数，node:test 直接测（见 test/mcp/client/model.test.ts）。
 * ------------------------------------------------------------------ */

/** 列表筛选的四个分段（UI-DESIGN §5）。 */
export type ServerFilterId = "all" | "enabled" | "disabled" | "failing";

export const SERVER_FILTERS: readonly ServerFilterId[] = ["all", "enabled", "disabled", "failing"];

export function filterLabel(id: ServerFilterId): string {
  switch (id) {
    case "enabled":
      return t("mcp.filter.enabled");
    case "disabled":
      return t("mcp.filter.disabled");
    case "failing":
      return t("mcp.filter.failing");
    default:
      return t("mcp.filter.all");
  }
}

/** 缓存里拿到的运行态（可能是 undefined：还没探测过 / 运行态接口失败）。 */
export type RuntimeRow = RuntimeServerView | undefined;

/** 一行是不是「有错误」（最近失败记录还在）。 */
export function isFailing(row: RuntimeRow): boolean {
  return row?.lastFailure !== undefined;
}

/** 一行是不是「冷却中」（有失败且冷却还没结束）。 */
export function isCooling(row: RuntimeRow, now: number): boolean {
  return cooldownRemainingMs(row?.lastFailure, now) > 0;
}

export function matchesFilter(view: ServerView, row: RuntimeRow, filter: ServerFilterId): boolean {
  switch (filter) {
    case "enabled":
      return !view.disabled;
    case "disabled":
      return view.disabled;
    case "failing":
      return isFailing(row);
    default:
      return true;
  }
}

/** 搜索：服务器名、命令 / 地址、描述与标签（大小写不敏感）。 */
export function matchesQuery(view: ServerView, query: string): boolean {
  const text = query.trim().toLowerCase();
  if (text === "") return true;
  const meta = view.meta ?? {};
  const haystack = [view.serverName, viewSummaryText(view), meta.description ?? "", (meta.tags ?? []).join(" ")]
    .join(" ")
    .toLowerCase();
  return haystack.includes(text);
}

/** 运行态快照 → 名字到行的映射（列表与筛选共用）。 */
export function runtimeIndex(runtime: RuntimeStatus | undefined): Map<string, RuntimeServerView> {
  const map = new Map<string, RuntimeServerView>();
  for (const row of runtime?.servers ?? []) map.set(row.name, row);
  return map;
}

/** 分段上的计数（工具栏用）。 */
export function serverFilterCounts(
  servers: readonly ServerView[],
  rows: ReadonlyMap<string, RuntimeServerView>,
): Record<ServerFilterId, number> {
  const counts: Record<ServerFilterId, number> = { all: 0, enabled: 0, disabled: 0, failing: 0 };
  for (const view of servers) {
    counts.all += 1;
    for (const id of SERVER_FILTERS) {
      if (id === "all") continue;
      if (matchesFilter(view, rows.get(view.serverName), id)) counts[id] += 1;
    }
  }
  return counts;
}

/** 搜索 + 筛选之后的服务器（保持配置顺序）。 */
export function visibleServers(
  servers: readonly ServerView[],
  rows: ReadonlyMap<string, RuntimeServerView>,
  query: string,
  filter: ServerFilterId,
): ServerView[] {
  return servers.filter((view) => matchesQuery(view, query) && matchesFilter(view, rows.get(view.serverName), filter));
}

/** 活跃实例数（MCP 页从运行态的会话里数，用来决定状态点是否用强调色）。 */
export function activeInstanceCount(runtime: RuntimeStatus | undefined, name: string): number {
  let count = 0;
  for (const session of runtime?.sessions ?? []) {
    for (const instance of session.instances) {
      if (instance.server === name) count += 1;
    }
  }
  return count;
}

/** 状态点：冷却中（琥珀）> 最近失败（红）> 有活跃实例（强调色）> 空闲（灰）。 */
export function serverStatusTone(
  row: RuntimeRow,
  instances: number,
  now: number,
): "idle" | "active" | "failed" | "cooling" {
  if (isCooling(row, now)) return "cooling";
  if (isFailing(row)) return "failed";
  if (instances > 0) return "active";
  return "idle";
}

/** 状态点的无障碍名（没有合适文案时返回 undefined，不渲染 title）。 */
export function statusTitle(tone: "idle" | "active" | "failed" | "cooling"): string | undefined {
  switch (tone) {
    case "active":
      return t("mcp.row.stateActive");
    case "failed":
      return t("mcp.row.stateFailed");
    case "cooling":
      return t("mcp.row.stateCooling");
    default:
      return undefined;
  }
}

/** 冷却剩余毫秒（没有冷却 = 0）。 */
export function cooldownRemainingMs(failure: RuntimeFailureView | undefined, now: number): number {
  if (failure === undefined || typeof failure.cooldownUntil !== "number") return 0;
  return Math.max(0, failure.cooldownUntil - now);
}

/** 「冷却中，剩余 47 秒」；没有冷却时 undefined（不渲染）。 */
export function cooldownText(failure: RuntimeFailureView | undefined, now: number): string | undefined {
  const remaining = cooldownRemainingMs(failure, now);
  if (remaining <= 0) return undefined;
  return t("mcp.row.cooldown", { remaining: formatDuration(remaining) });
}

/** 毫秒 → 中文时长（秒 / 分秒）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "0 秒";
  const total = Math.floor(ms / 1000);
  if (total < 60) return String(total) + " 秒";
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return String(minutes) + " 分 " + String(seconds).padStart(2, "0") + " 秒";
  const hours = Math.floor(minutes / 60);
  return String(hours) + " 小时 " + String(minutes % 60).padStart(2, "0") + " 分";
}

/** 时间戳 → 本地「HH:mm」（行里的「更新于 23:50」）。 */
export function formatClock(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
}

/** 行副标题：紧凑的命令 / 地址，有缓存时接「 · 4 个工具」（UI-DESIGN §3）。 */
export function rowSubtitleText(view: ServerView, row: RuntimeRow): string {
  const base = compactSummaryText(view as unknown as Record<string, unknown>);
  if (row?.cache === undefined) return base;
  return base + " " + t("mcp.row.tools", { count: row.cache.toolCount });
}

/** 行副标题的悬停提示：完整命令 / 地址。 */
export function rowSubtitleTitle(view: ServerView): string {
  return viewSummaryText(view);
}

/** 抽屉「工具」小节的一行：缓存数量与更新时间。 */
export function cacheLineText(row: RuntimeRow): string {
  if (row?.cache === undefined) return t("mcp.detail.noCache");
  const parts = [t("mcp.detail.cache", { count: row.cache.toolCount, time: formatTimestamp(row.cache.updatedAt) })];
  if (row.cache.stale) parts.push(t("mcp.detail.cacheStale"));
  return parts.join(" · ");
}

/** 缓存里的工具名（宿主还没在运行态返回名字时是空数组）。 */
export function cachedToolNames(row: RuntimeRow): string[] {
  const tools = row?.cache?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => (typeof tool?.name === "string" ? tool.name : "")).filter((name) => name !== "");
}

export function errorDetails(error: unknown): unknown {
  if (error === null || typeof error !== "object") return undefined;
  return (error as { details?: unknown }).details;
}

/** ApiError.details（服务端 VALIDATION 的 FieldError[]）→ FieldError[]。 */
export function fieldErrorsOf(error: unknown): FieldError[] {
  const details = errorDetails(error);
  if (!Array.isArray(details)) return [];
  const out: FieldError[] = [];
  for (const entry of details) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path : typeof record.field === "string" ? record.field : "";
    const message = typeof record.message === "string" ? record.message : "";
    if (message === "") continue;
    out.push({ path, message });
  }
  return out;
}
