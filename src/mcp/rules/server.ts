/**
 * MCP 服务器配置的规则：字段白名单、默认值、哪些字段属于哪种传输方式、校验与归一化。
 *
 * 宿主落盘前用它把关，界面的 JSON 编辑即时校验也用它——只有这一份（ADR-0008）。纯函数，不碰 Node / DOM。
 *
 * 三条硬规则：
 * 1. 未知字段（含拼写错误、官方 dsh-mcp-client 专有字段、0.7.0 废弃的字段）一律拒绝 —— 字段名封死，
 *    废弃字段的提示说清楚为什么没了；磁盘上的旧配置里出现废弃字段不报错，读到时忽略（mcp/config/schema.ts）。
 * 2. 归一化结果只含「用户显式设置且不等于默认值」的字段（D-C1：默认值不落盘）。
 * 3. 校验信息全部中文、带字段路径（server.<字段>），可直接展示给用户。
 */

import { isHttpUrl, isNatural, isPlainObject } from "./values.ts";
import type { FieldError, McpServerMeta, RawMcpServer, ServerScope, Transport } from "../contract/config.ts";

/** 遮罩占位符：视图里 env / headers 的值都显示成它；提交时原样带回表示「保留原值」。 */
export const HIDDEN = "***hidden***";

/** 与官方 dsh-mcp-client 的 serverName 规则一致（它拿这个名字拼工具名 mcp__<名字>__<工具>）。 */
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** 环境变量名（envFrom 的键、allowEmpty 的元素）。 */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const TRANSPORTS: Transport[] = ["stdio", "streamable-http"];
export const SCOPES: ServerScope[] = ["global", "session"];

/** 服务器级字段白名单。数组顺序也是 JSON 编辑时的字段顺序。 */
export const SERVER_FIELDS = [
  "serverName",
  "transport",
  "command",
  "args",
  "cwd",
  "env",
  "envFrom",
  "allowEmpty",
  "envFromTimeoutMs",
  "url",
  "headers",
  "toolCallTimeoutMs",
  "scope",
  "disabled",
  "meta",
] as const;

export const META_FIELDS = ["description"] as const;

/** envFrom 单条命令的取值超时、工具调用超时的默认值（毫秒）。 */
export const DEFAULT_ENV_FROM_TIMEOUT_MS = 10000;
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;

/**
 * 0.7.0 废弃的字段与原因（ADR-0010）。用户提交时报错并说明；磁盘上的旧值读到时忽略、下次保存时去掉。
 */
export const DEPRECATED_FIELDS: Record<string, string> = {
  lifecycle: "0.7.0 起由 DSH 官方 MCP 插件连接服务器，不再有启动时机选项；进程放在哪用 scope（global / session）。",
  idleTimeout: "0.7.0 起由 DSH 官方 MCP 插件连接服务器，不再空闲回收。",
  debug: "0.7.0 起由 DSH 官方 MCP 插件连接服务器，调试日志见 DSH 自己的日志。",
  includeTools: "0.7.0 起由 DSH 官方 MCP 插件注册工具，它会注册服务器的全部工具，不支持过滤。",
  excludeTools: "0.7.0 起由 DSH 官方 MCP 插件注册工具，它会注册服务器的全部工具，不支持过滤。",
  searchKeywords: "0.6.0 起没有 search 动作，这个字段已经没有作用。",
};

/** meta 里废弃的键。 */
export const DEPRECATED_META_FIELDS: Record<string, string> = {
  tags: "0.7.0 起服务器只保留描述（description），标签已删除。",
  homepage: "0.7.0 起服务器只保留描述（description），主页已删除。",
};

/** 官方 dsh-mcp-client 有、本插件不让填的字段：明确说「不支持」，而不是只说「未知字段」。 */
const OFFICIAL_ONLY_FIELDS: Record<string, string> = {
  directTools: "这是已停用的 dsh-mcp-lazy 的字段，本插件不支持。",
  freezeDirectTools: "这是已停用的 dsh-mcp-lazy 的字段，本插件不支持。",
  reconnect: "断线重连用官方 MCP 插件的默认值（0.5 秒起翻倍、最长 30 秒、最多 10 次），本插件不开放这个字段。",
  failOnStartupError: "由本插件决定，不开放这个字段。",
  maxInstructionBytes: "由本插件决定，不开放这个字段。",
};

/** 保留名：粘贴 JSON 时出现在视图元数据里的键，静默忽略。 */
export const RESERVED_EXTRA_KEYS = ["setFields"];

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
    if (RESERVED_EXTRA_KEYS.includes(key)) continue;
    const deprecated = DEPRECATED_FIELDS[key];
    const official = OFFICIAL_ONLY_FIELDS[key];
    errors.push({
      path: "server." + key,
      message: deprecated
        ? "字段「" + key + "」已废弃：" + deprecated
        : official
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
      message: "服务器名称只能包含英文字母、数字、下划线、短横线，长度 1–32（DSH 用它拼工具名）。",
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
  const stringFields: ("command" | "cwd" | "url")[] = ["command", "cwd", "url"];
  for (const field of stringFields) {
    if (!(field in input)) continue;
    const value = input[field];
    if (value === undefined || value === null || value === "") continue; // 视为未设置
    if (typeof value !== "string") {
      errors.push({ path: "server." + field, message: "字段 " + field + " 必须是字符串。" });
      continue;
    }
    out[field] = value;
  }

  // 5) 字符串数组
  for (const field of ["args", "allowEmpty"] as const) {
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
    out[field] = items;
  }

  // 6) 字符串映射（env / envFrom / headers）
  for (const field of ["env", "envFrom", "headers"] as const) {
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
        errors.push({ path: "server.envFrom." + key, message: "envFrom 里「" + key + "」的取值命令不能为空字符串。" });
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

  // 7) 数字字段
  if ("envFromTimeoutMs" in input && input.envFromTimeoutMs !== undefined && input.envFromTimeoutMs !== null) {
    const value = input.envFromTimeoutMs;
    if (!isNatural(value)) {
      errors.push({ path: "server.envFromTimeoutMs", message: "envFromTimeoutMs 必须是不小于 0 的整数（毫秒）。" });
    } else if (value !== DEFAULT_ENV_FROM_TIMEOUT_MS) {
      out.envFromTimeoutMs = value;
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

  // 8) scope
  if ("scope" in input && input.scope !== undefined && input.scope !== null && input.scope !== "") {
    const value = input.scope;
    if (typeof value !== "string" || !(SCOPES as string[]).includes(value)) {
      errors.push({
        path: "server.scope",
        message: "scope 只能是 global（全局一份，默认）或 session（每个会话、子代理各一份）。",
      });
    } else if (value !== "global") {
      out.scope = value as ServerScope;
    }
  }

  // 9) disabled
  if ("disabled" in input && input.disabled !== undefined && input.disabled !== null) {
    if (typeof input.disabled !== "boolean") {
      errors.push({ path: "server.disabled", message: "字段 disabled 必须是布尔值。" });
    } else if (input.disabled) out.disabled = true;
  }

  // 10) meta
  if ("meta" in input && input.meta !== undefined && input.meta !== null) {
    const value = input.meta;
    if (!isPlainObject(value)) {
      errors.push({ path: "server.meta", message: "meta 必须是对象（只支持 description）。" });
    } else {
      const meta: McpServerMeta = {};
      for (const key of Object.keys(value)) {
        if ((META_FIELDS as readonly string[]).includes(key)) continue;
        const deprecated = DEPRECATED_META_FIELDS[key];
        errors.push({
          path: "server.meta." + key,
          message: deprecated
            ? "meta.「" + key + "」已废弃：" + deprecated
            : "meta 里不支持的键「" + key + "」。只支持 description。",
        });
      }
      const description = value.description;
      if (description !== undefined && description !== null && description !== "") {
        if (typeof description !== "string") {
          errors.push({ path: "server.meta.description", message: "description 必须是字符串。" });
        } else meta.description = description;
      }
      if (Object.keys(meta).length > 0) out.meta = meta;
    }
  }

  // 11) 条件必填
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

  // 12) 跨字段
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
        errors.push({ path: "server.allowEmpty", message: "allowEmpty 里的「" + name + "」没有在 envFrom 中声明。" });
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
