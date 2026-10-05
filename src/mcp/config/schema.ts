/**
 * MCP 配置的字段白名单、默认值与校验（PLAN §3.5）。
 *
 * 三条硬规则：
 * 1. 未知字段（含拼写错误、官方 dsh-mcp-client 专有字段）一律 VALIDATION 拒绝 —— 字段名封死。
 * 2. 落盘只写「用户显式设置且不等于默认值」的字段（D-C1：默认值不落盘）。
 * 3. 校验信息全部中文、带字段路径，可直接展示给用户。
 */

import type { OutputGuardInput, RawMcpConfigFile, RawMcpSettings } from "./types.ts";
import type {
  EffectiveMcpConfig,
  EffectiveServer,
  FieldError,
  Lifecycle,
  McpServerMeta,
  OutputGuard,
  RawMcpServer,
  ServerDefaultsHint,
  ServerView,
  Transport,
} from "../contract/config.ts";

// —— 常量 ——

export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** 环境变量名（envFrom 的键、allowEmpty 的元素）。 */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const TRANSPORTS: Transport[] = ["stdio", "streamable-http"];
export const LIFECYCLES: Lifecycle[] = ["lazy", "lazy-keep-alive", "eager", "keep-alive"];

/** 服务器级字段白名单（19 个 + meta）。数组顺序也是 JSON 编辑模式下的字段顺序。 */
export const SERVER_FIELDS = [
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
] as const;

export const META_FIELDS = ["description", "tags", "homepage"] as const;

/** 全局设置白名单。注意：servers 单独存，不是 setting。 */
export const SETTINGS_FIELDS = ["idleTimeout", "outputGuard", "failureBackoffMs"] as const;

export const SETTINGS_DEFAULTS = {
  idleTimeout: 10,
  failureBackoffMs: 60000,
} as const;

export const DEFAULT_OUTPUT_GUARD: OutputGuard = { enabled: true, maxBytes: 51200, maxLines: 2000 };

/** F3 常量：envFrom 单条命令的取值超时。 */
export const DEFAULT_ENV_FROM_TIMEOUT_MS = 10000;
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;

/**
 * 官方客户端插件的字段：明确告知用户「不支持」，而不是只说「未知字段」。
 *
 * 分两类（T3a 文案小改）：
 *   - directTools 是 **dsh-mcp-lazy** 的「工具提升」字段，本插件按 D-D9 明确不做；
 *   - 其余（freezeDirectTools / reconnect / failOnStartupError）是官方 **dsh-mcp-client**
 *     的字段，文案保持原样，不再细分。
 */
const OFFICIAL_ONLY_FIELDS: Record<string, string> = {
  directTools: "这是 dsh-mcp-lazy 的工具提升字段，本插件不支持（D-D9）",
  freezeDirectTools: "这是官方 dsh-mcp-client 的字段，本插件不支持。",
  reconnect: "这是官方 dsh-mcp-client 的字段，本插件不支持。",
  failOnStartupError: "这是官方 dsh-mcp-client 的字段，本插件不支持。",
};

/** 保留名：避免与「显式设置字段」视图里的元数据键冲突。 */
export const RESERVED_EXTRA_KEYS = ["<全局>", "<defaults>", "setFields"];

/** 默认值提示（给界面的「默认值」说明）。 */
export function serverDefaultsHint(): ServerDefaultsHint {
  return {
    command: null,
    args: [],
    cwd: null,
    env: {},
    envFrom: {},
    allowEmpty: [],
    envFromTimeoutMs: DEFAULT_ENV_FROM_TIMEOUT_MS,
    url: null,
    headers: {},
    toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
    lifecycle: "lazy",
    idleTimeout: null,
    includeTools: null,
    excludeTools: null,
    searchKeywords: {},
    disabled: false,
    debug: false,
    meta: {},
  };
}

// —— 小工具 ——

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNatural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function fullWidth(value: string): string {
  return JSON.stringify(value);
}

// —— 设置 ——

export interface ParsedSettings {
  errors: FieldError[];
  settings: RawMcpSettings;
}

/** 解析全局设置输入（只保留非默认项）。 */
export function parseSettingsInput(input: unknown): ParsedSettings {
  const errors: FieldError[] = [];
  const settings: RawMcpSettings = {};
  if (input === undefined || input === null) return { errors, settings };
  if (!isPlainObject(input)) {
    errors.push({ path: "settings", message: "全局设置必须是一个 JSON 对象。" });
    return { errors, settings };
  }

  for (const key of Object.keys(input)) {
    if (!(SETTINGS_FIELDS as readonly string[]).includes(key)) {
      errors.push({
        path: "settings." + key,
        message: "未知的全局设置项「" + key + "」。支持的项：" + SETTINGS_FIELDS.join("、") + "。",
      });
    }
  }

  if ("idleTimeout" in input && input.idleTimeout !== undefined && input.idleTimeout !== null) {
    const value = input.idleTimeout;
    if (!isNatural(value)) {
      errors.push({
        path: "settings.idleTimeout",
        message: "空闲回收时间必须是不小于 0 的整数（分钟，0 表示不回收）。",
      });
    } else if (value !== SETTINGS_DEFAULTS.idleTimeout) {
      settings.idleTimeout = value;
    }
  }

  if ("failureBackoffMs" in input && input.failureBackoffMs !== undefined && input.failureBackoffMs !== null) {
    const value = input.failureBackoffMs;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      errors.push({ path: "settings.failureBackoffMs", message: "失败退避时间必须是不小于 0 的整数（毫秒）。" });
    } else if (value !== SETTINGS_DEFAULTS.failureBackoffMs) {
      settings.failureBackoffMs = value;
    }
  }

  if ("outputGuard" in input && input.outputGuard !== undefined && input.outputGuard !== null) {
    const raw = input.outputGuard;
    if (typeof raw === "boolean") {
      if (!raw) settings.outputGuard = false;
    } else if (!isPlainObject(raw)) {
      errors.push({
        path: "settings.outputGuard",
        message: "输出护栏必须是布尔值，或形如 { enabled, maxBytes, maxLines } 的对象。",
      });
    } else {
      const partial: { enabled?: boolean; maxBytes?: number; maxLines?: number } = {};
      for (const key of Object.keys(raw)) {
        if (key !== "enabled" && key !== "maxBytes" && key !== "maxLines") {
          errors.push({
            path: "settings.outputGuard." + key,
            message: "未知的输出护栏项「" + key + "」。支持：enabled、maxBytes、maxLines。",
          });
        }
      }
      if ("enabled" in raw && raw.enabled !== undefined && raw.enabled !== null) {
        if (typeof raw.enabled !== "boolean") {
          errors.push({ path: "settings.outputGuard.enabled", message: "enabled 必须是布尔值。" });
        } else partial.enabled = raw.enabled;
      }
      if ("maxBytes" in raw && raw.maxBytes !== undefined && raw.maxBytes !== null) {
        if (typeof raw.maxBytes !== "number" || !Number.isSafeInteger(raw.maxBytes) || raw.maxBytes <= 0) {
          errors.push({ path: "settings.outputGuard.maxBytes", message: "maxBytes 必须是大于 0 的整数。" });
        } else partial.maxBytes = raw.maxBytes;
      }
      if ("maxLines" in raw && raw.maxLines !== undefined && raw.maxLines !== null) {
        if (typeof raw.maxLines !== "number" || !Number.isSafeInteger(raw.maxLines) || raw.maxLines <= 0) {
          errors.push({ path: "settings.outputGuard.maxLines", message: "maxLines 必须是大于 0 的整数。" });
        } else partial.maxLines = raw.maxLines;
      }
      if (errors.length === 0) {
        const merged: OutputGuard = { ...DEFAULT_OUTPUT_GUARD, ...partial };
        if (
          merged.enabled !== DEFAULT_OUTPUT_GUARD.enabled ||
          merged.maxBytes !== DEFAULT_OUTPUT_GUARD.maxBytes ||
          merged.maxLines !== DEFAULT_OUTPUT_GUARD.maxLines
        ) {
          settings.outputGuard = partial;
        }
      }
    }
  }

  return { errors, settings };
}

/** 把落盘设置解析成完整值。 */
export function effectiveSettings(raw: RawMcpSettings | undefined): EffectiveMcpConfig["settings"] {
  const source = isPlainObject(raw) ? (raw as RawMcpSettings) : {};
  const guard: OutputGuard =
    source.outputGuard === false
      ? { ...DEFAULT_OUTPUT_GUARD, enabled: false }
      : isPlainObject(source.outputGuard)
        ? { ...DEFAULT_OUTPUT_GUARD, ...(source.outputGuard as Record<string, unknown>) }
        : { ...DEFAULT_OUTPUT_GUARD };
  return {
    idleTimeoutMin: isNatural(source.idleTimeout) ? source.idleTimeout : SETTINGS_DEFAULTS.idleTimeout,
    outputGuard: guard,
    failureBackoffMs:
      typeof source.failureBackoffMs === "number" &&
      Number.isSafeInteger(source.failureBackoffMs) &&
      source.failureBackoffMs >= 0
        ? source.failureBackoffMs
        : SETTINGS_DEFAULTS.failureBackoffMs,
  };
}

// —— 服务器校验 ——

export interface ParseServerOptions {
  /** 已占用的服务器名（应包含除被编辑服务器之外的全部现有名字）。 */
  existingNames?: Iterable<string>;
  /** 被编辑服务器的原名；与提交名相同时不视为重名。 */
  originalName?: string;
}

export interface ParseServerResult {
  errors: FieldError[];
  /** 归一化后的服务器（只含非默认字段）；有错时内容仅供参考，调用方不应落盘。 */
  server: RawMcpServer;
}

/**
 * 校验并归一化一个服务器对象。
 * 返回的 server 只含「显式设置且不等于默认值」的字段，可直接落盘。
 */
export function parseServerInput(input: unknown, opts: ParseServerOptions = {}): ParseServerResult {
  const errors: FieldError[] = [];
  if (!isPlainObject(input)) {
    return { errors: [{ path: "server", message: "服务器必须是一个 JSON 对象。" }], server: {} };
  }

  const occupied = new Set<string>();
  for (const name of opts.existingNames ?? []) {
    if (name !== opts.originalName) occupied.add(name);
  }

  // 1) 白名单
  for (const key of Object.keys(input)) {
    if ((SERVER_FIELDS as readonly string[]).includes(key)) continue;
    if (RESERVED_EXTRA_KEYS.includes(key)) continue; // 视图元数据，静默忽略
    const official = OFFICIAL_ONLY_FIELDS[key];
    errors.push({
      path: "server." + key,
      message: official
        ? "不支持的字段「" + key + "」：" + official
        : "不支持的字段「" + key + "」。本插件只接受固定字段列表，请检查是否拼写错误。",
    });
  }

  const out: RawMcpServer = {};

  // 2) serverName
  const serverName = input.serverName;
  if (serverName === undefined || serverName === null || serverName === "") {
    errors.push({ path: "server.serverName", message: "服务器名称不能为空。" });
  } else if (typeof serverName !== "string") {
    errors.push({ path: "server.serverName", message: "服务器名称必须是字符串。" });
  } else if (!SERVER_NAME_RE.test(serverName)) {
    errors.push({
      path: "server.serverName",
      message: "服务器名称只能包含字母、数字、下划线、连字符，长度 1–32。",
    });
  } else {
    out.serverName = serverName;
    if (occupied.has(serverName)) {
      errors.push({ path: "server.serverName", message: "服务器名称「" + serverName + "」已存在。" });
    }
  }

  // 3) transport
  const transport = input.transport;
  if (transport === undefined || transport === null || transport === "") {
    errors.push({ path: "server.transport", message: "缺少必填字段 transport（stdio 或 streamable-http）。" });
  } else if (typeof transport !== "string" || !(TRANSPORTS as string[]).includes(transport)) {
    errors.push({ path: "server.transport", message: "transport 只能是 stdio 或 streamable-http。" });
  } else {
    out.transport = transport as Transport;
  }

  // 4) 字符串字段
  const stringFields: (keyof RawMcpServer)[] = ["command", "cwd", "url"];
  for (const field of stringFields) {
    if (!(field in input)) continue;
    const value = input[field];
    if (value === undefined || value === null || value === "") continue; // 视为未设置
    if (typeof value !== "string") {
      errors.push({ path: "server." + field, message: "字段 " + field + " 必须是字符串。" });
      continue;
    }
    out[field] = value as never;
  }

  // 5) 字符串数组
  const arrayFields: ("args" | "allowEmpty" | "includeTools" | "excludeTools")[] = [
    "args",
    "allowEmpty",
    "includeTools",
    "excludeTools",
  ];
  for (const field of arrayFields) {
    if (!(field in input)) continue;
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) {
      errors.push({ path: "server." + field, message: "字段 " + field + " 必须是字符串数组。" });
      continue;
    }
    const items: string[] = [];
    let bad = false;
    value.forEach((item, index) => {
      if (typeof item !== "string") {
        errors.push({ path: "server." + field + "[" + index + "]", message: "必须是字符串。" });
        bad = true;
        return;
      }
      items.push(item);
    });
    if (bad) continue;
    if (items.length === 0) continue; // 空数组等同于未设置（args 的默认值就是 []）
    out[field] = items as never;
  }

  // 6) 字符串映射（env / envFrom / headers）
  const mapFields: ("env" | "envFrom" | "headers")[] = ["env", "envFrom", "headers"];
  for (const field of mapFields) {
    if (!(field in input)) continue;
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (!isPlainObject(value)) {
      errors.push({ path: "server." + field, message: "字段 " + field + " 必须是「字符串 → 字符串」的对象。" });
      continue;
    }
    const map: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.trim() === "") {
        errors.push({ path: "server." + field, message: "字段 " + field + " 里存在空键名。" });
        continue;
      }
      if (typeof item !== "string") {
        errors.push({ path: "server." + field + "." + key, message: "值必须是字符串。" });
        continue;
      }
      if (field === "envFrom" && item.trim() === "") {
        errors.push({
          path: "server.envFrom." + key,
          message: "envFrom 里「" + key + "」的取值命令不能为空字符串。",
        });
        continue;
      }
      if (field === "envFrom" && !ENV_NAME_RE.test(key)) {
        errors.push({
          path: "server.envFrom." + key,
          message: "环境变量名「" + key + "」不合法（只能包含字母、数字、下划线，且不能以数字开头）。",
        });
        continue;
      }
      map[key] = item;
    }
    if (Object.keys(map).length === 0) continue;
    out[field] = map;
  }

  // 7) searchKeywords
  if ("searchKeywords" in input && input.searchKeywords !== undefined && input.searchKeywords !== null) {
    const value = input.searchKeywords;
    if (!isPlainObject(value)) {
      errors.push({ path: "server.searchKeywords", message: "searchKeywords 必须是「工具名 → 字符串数组」的对象。" });
    } else {
      const map: Record<string, string[]> = {};
      for (const [tool, keywords] of Object.entries(value)) {
        if (!Array.isArray(keywords) || keywords.some((k) => typeof k !== "string")) {
          errors.push({ path: "server.searchKeywords." + tool, message: "必须是字符串数组。" });
          continue;
        }
        if (keywords.length === 0) continue;
        map[tool] = keywords as string[];
      }
      if (Object.keys(map).length > 0) out.searchKeywords = map;
    }
  }

  // 8) 数字字段
  if ("envFromTimeoutMs" in input && input.envFromTimeoutMs !== undefined && input.envFromTimeoutMs !== null) {
    const value = input.envFromTimeoutMs;
    if (!isNatural(value)) {
      errors.push({ path: "server.envFromTimeoutMs", message: "envFromTimeoutMs 必须是不小于 0 的整数（毫秒）。" });
    } else if (value !== DEFAULT_ENV_FROM_TIMEOUT_MS) {
      out.envFromTimeoutMs = value;
    }
  }

  if ("idleTimeout" in input && input.idleTimeout !== undefined && input.idleTimeout !== null) {
    const value = input.idleTimeout;
    if (!isNatural(value)) {
      errors.push({ path: "server.idleTimeout", message: "idleTimeout 必须是不小于 0 的整数（分钟，0 表示不回收）。" });
    } else {
      out.idleTimeout = value;
    }
  }

  if ("toolCallTimeoutMs" in input && input.toolCallTimeoutMs !== undefined && input.toolCallTimeoutMs !== null) {
    const value = input.toolCallTimeoutMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push({ path: "server.toolCallTimeoutMs", message: "toolCallTimeoutMs 必须是数字（≤0 表示不设超时）。" });
    } else if (value !== DEFAULT_TOOL_CALL_TIMEOUT_MS) {
      out.toolCallTimeoutMs = value;
    }
  }

  // 9) 枚举
  if ("lifecycle" in input && input.lifecycle !== undefined && input.lifecycle !== null && input.lifecycle !== "") {
    const value = input.lifecycle;
    if (typeof value !== "string" || !(LIFECYCLES as string[]).includes(value)) {
      errors.push({
        path: "server.lifecycle",
        message: "lifecycle 只能是 lazy、lazy-keep-alive、eager、keep-alive 之一。",
      });
    } else if (value !== "lazy") {
      out.lifecycle = value as Lifecycle;
    }
  }

  // 10) 布尔
  for (const field of ["disabled", "debug"] as const) {
    if (!(field in input)) continue;
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "boolean") {
      errors.push({ path: "server." + field, message: "字段 " + field + " 必须是布尔值。" });
      continue;
    }
    if (value !== false) out[field] = true;
  }

  // 11) meta
  if ("meta" in input && input.meta !== undefined && input.meta !== null) {
    const value = input.meta;
    if (!isPlainObject(value)) {
      errors.push({ path: "server.meta", message: "meta 必须是对象（description、tags、homepage）。" });
    } else {
      const meta: McpServerMeta = {};
      for (const key of Object.keys(value)) {
        if (!(META_FIELDS as readonly string[]).includes(key)) {
          errors.push({
            path: "server.meta." + key,
            message: "meta 里不支持的键「" + key + "」。支持：description、tags、homepage。",
          });
        }
      }
      if (
        "description" in value &&
        value.description !== undefined &&
        value.description !== null &&
        value.description !== ""
      ) {
        if (typeof value.description !== "string") {
          errors.push({ path: "server.meta.description", message: "description 必须是字符串。" });
        } else meta.description = value.description;
      }
      if ("homepage" in value && value.homepage !== undefined && value.homepage !== null && value.homepage !== "") {
        if (typeof value.homepage !== "string") {
          errors.push({ path: "server.meta.homepage", message: "homepage 必须是字符串。" });
        } else meta.homepage = value.homepage;
      }
      if ("tags" in value && value.tags !== undefined && value.tags !== null) {
        const tags = value.tags;
        if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
          errors.push({ path: "server.meta.tags", message: "tags 必须是字符串数组。" });
        } else if (tags.length > 0) {
          meta.tags = tags as string[];
        }
      }
      if (Object.keys(meta).length > 0) out.meta = meta;
    }
  }

  // 12) 条件必填
  if (out.transport === "stdio") {
    if (out.command === undefined || out.command.trim() === "") {
      errors.push({ path: "server.command", message: "stdio 传输必须填写启动命令（command）。" });
    }
  } else if (out.transport === "streamable-http") {
    if (out.url === undefined || out.url.trim() === "") {
      errors.push({ path: "server.url", message: "streamable-http 传输必须填写服务器地址（url）。" });
    } else if (!isHttpUrl(out.url)) {
      errors.push({ path: "server.url", message: "url 必须是合法的 http/https 地址。" });
    }
  }

  // 13) 跨字段
  if (out.env && out.envFrom) {
    for (const name of Object.keys(out.envFrom)) {
      if (name in out.env) {
        errors.push({
          path: "server.envFrom." + name,
          message: "变量「" + name + "」同时出现在 env 与 envFrom 中，只能二选一。",
        });
      }
    }
  }
  if (out.allowEmpty) {
    for (const name of out.allowEmpty) {
      if (!ENV_NAME_RE.test(name)) {
        errors.push({
          path: "server.allowEmpty",
          message: "allowEmpty 里的「" + name + "」不是合法的环境变量名（只能包含字母、数字、下划线）。",
        });
        continue;
      }
      if (out.envFrom === undefined || !(name in out.envFrom)) {
        errors.push({
          path: "server.allowEmpty",
          message: "allowEmpty 里的「" + name + "」没有在 envFrom 中声明。",
        });
      }
    }
  }
  if (out.envFrom && out.transport !== "stdio") {
    errors.push({
      path: "server.envFrom",
      message: "envFrom 只能用于 stdio 传输的服务器（它通过执行命令取得环境变量）。",
    });
  }

  return { errors, server: out };
}

/** 归一化落盘文件里的服务器（不做校验，只做形状修正）。 */
export function toEffectiveServer(raw: RawMcpServer, globalIdleTimeoutMin: number): EffectiveServer {
  return {
    serverName: typeof raw.serverName === "string" ? raw.serverName : "",
    transport: raw.transport === "streamable-http" ? "streamable-http" : "stdio",
    command: raw.command,
    args: Array.isArray(raw.args) ? [...raw.args] : [],
    cwd: raw.cwd,
    env: isPlainObject(raw.env) ? { ...(raw.env as Record<string, string>) } : {},
    envFrom: isPlainObject(raw.envFrom) ? { ...(raw.envFrom as Record<string, string>) } : {},
    allowEmpty: Array.isArray(raw.allowEmpty) ? [...raw.allowEmpty] : [],
    envFromTimeoutMs: isNatural(raw.envFromTimeoutMs) ? raw.envFromTimeoutMs : DEFAULT_ENV_FROM_TIMEOUT_MS,
    url: raw.url,
    headers: isPlainObject(raw.headers) ? { ...(raw.headers as Record<string, string>) } : {},
    toolCallTimeoutMs:
      typeof raw.toolCallTimeoutMs === "number" && Number.isFinite(raw.toolCallTimeoutMs)
        ? raw.toolCallTimeoutMs
        : DEFAULT_TOOL_CALL_TIMEOUT_MS,
    lifecycle: (LIFECYCLES as string[]).includes(raw.lifecycle as string) ? (raw.lifecycle as Lifecycle) : "lazy",
    idleTimeoutMin: isNatural(raw.idleTimeout) ? raw.idleTimeout : globalIdleTimeoutMin,
    includeTools: Array.isArray(raw.includeTools) ? [...raw.includeTools] : undefined,
    excludeTools: Array.isArray(raw.excludeTools) ? [...raw.excludeTools] : undefined,
    searchKeywords: isPlainObject(raw.searchKeywords) ? { ...(raw.searchKeywords as Record<string, string[]>) } : {},
    disabled: raw.disabled === true,
    debug: raw.debug === true,
    meta: isPlainObject(raw.meta) ? { ...(raw.meta as McpServerMeta) } : {},
  };
}

/** 落盘文件 → 生效配置。 */
export function toEffectiveConfig(file: RawMcpConfigFile): EffectiveMcpConfig {
  const settings = effectiveSettings(file.settings);
  const servers = (Array.isArray(file.servers) ? file.servers : [])
    .filter((s) => isPlainObject(s))
    .map((s) => toEffectiveServer(s as RawMcpServer, settings.idleTimeoutMin));
  return { settings, servers };
}

/** 服务器上「显式设置过」的字段名（界面用来区分默认值与用户值）。 */
export function setFieldsOf(raw: RawMcpServer | undefined): string[] {
  if (!isPlainObject(raw)) return [];
  return SERVER_FIELDS.filter((field) => (raw as Record<string, unknown>)[field] !== undefined);
}

/** 生成界面视图（server 已由调用方遮罩）。 */
export function serverView(effective: EffectiveServer, raw: RawMcpServer | undefined): ServerView {
  return {
    ...effective,
    setFields: setFieldsOf(raw),
    defaults: serverDefaultsHint(),
  };
}

/** 空配置。 */
export function emptyRawConfig(): RawMcpConfigFile {
  return { version: 1, settings: {}, servers: [] };
}

export { fullWidth };
