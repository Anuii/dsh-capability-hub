/**
 * 粘贴 JSON 的识别（D-C2）：把 mcpServers / servers / 名称→对象映射 / 单个对象识别成服务器数组。
 * 0.7.0 起这是添加服务器的唯一入口（预设模板与从 Claude Code / Codex 导入已删除）。
 */

import { isPlainObject } from "../rules/values.ts";
import { DEPRECATED_FIELDS, SERVER_NAME_RE } from "../rules/server.ts";
import type { ParsedServer, ParseResult, Transport } from "../contract/config.ts";

/** 标准写法之外、本插件自己的字段。 */
const EXTENDED_FIELDS = [
  "envFrom",
  "allowEmpty",
  "envFromTimeoutMs",
  "toolCallTimeoutMs",
  "scope",
  "disabled",
  "meta",
] as const;

/** 认识的键（含标准写法里的 type）；其余的键给一条「不受支持，已忽略」。 */
const KNOWN_SERVER_KEYS = new Set([
  "serverName",
  "transport",
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  ...EXTENDED_FIELDS,
  ...Object.keys(DEPRECATED_FIELDS),
]);

/** 把已知字段之外的键作为警告收集（粘贴路径宽容、不拒绝）。 */
function collectUnknownKeys(name: string, value: Record<string, unknown>, warnings: string[]): void {
  const unknown = Object.keys(value).filter((key) => !KNOWN_SERVER_KEYS.has(key));
  if (unknown.length > 0) {
    warnings.push("服务器「" + name + "」里的字段 " + unknown.join("、") + " 不受支持，已忽略。");
  }
}

/**
 * 从粘贴的对象里挑出本插件认识的字段；返回值为「落盘形态」（还没校验，保存时由 parseServerInput 把关）。
 * 标准写法（type / command / args / env / url / headers / cwd）之外，本插件自己的字段原样带上。
 */
export function mapServerFields(name: string, value: Record<string, unknown>, warnings: string[]): ParsedServer {
  const server: ParsedServer = { serverName: name };
  const label = "服务器「" + name + "」";

  // transport / type
  const rawType = value.transport ?? value.type;
  let transport: Transport | undefined;
  if (typeof rawType === "string") {
    const lowered = rawType.trim().toLowerCase();
    if (lowered === "stdio") transport = "stdio";
    else if (lowered === "http" || lowered === "streamable-http" || lowered === "streamablehttp")
      transport = "streamable-http";
    else if (lowered === "sse") {
      transport = "streamable-http";
      warnings.push(label + "使用了 SSE 传输：本插件不支持 SSE，可尝试 streamable-http。");
    } else {
      warnings.push(label + "的传输类型「" + rawType + "」无法识别，已按默认规则推断。");
    }
  }
  if (transport === undefined)
    transport = typeof value.url === "string" && value.url !== "" ? "streamable-http" : "stdio";
  server.transport = transport;

  if (typeof value.command === "string" && value.command !== "") server.command = value.command;
  if (Array.isArray(value.args)) {
    const args: string[] = [];
    let bad = false;
    value.args.forEach((item, index) => {
      if (typeof item === "string") args.push(item);
      else {
        warnings.push(label + "的 args[" + index + "] 不是字符串，已丢弃。");
        bad = true;
      }
    });
    if (args.length > 0) server.args = args;
    void bad;
  } else if (value.args !== undefined && value.args !== null) {
    warnings.push(label + "的 args 不是数组，已忽略。");
  }
  if (typeof value.cwd === "string" && value.cwd !== "") server.cwd = value.cwd;
  if (typeof value.url === "string" && value.url !== "") server.url = value.url;

  for (const field of ["env", "headers"] as const) {
    const raw = value[field];
    if (raw === undefined || raw === null) continue;
    if (!isPlainObject(raw)) {
      warnings.push(label + "的 " + field + " 不是对象，已忽略。");
      continue;
    }
    const map: Record<string, string> = {};
    for (const [key, item] of Object.entries(raw)) {
      if (typeof item === "string") map[key] = item;
      else if (typeof item === "number" || typeof item === "boolean") map[key] = String(item);
      else warnings.push(label + "的 " + field + "." + key + " 不是字符串，已忽略。");
    }
    if (Object.keys(map).length > 0) server[field] = map;
  }

  // 本插件自己的字段：原样带上，交给保存时的校验
  const extra = server as unknown as Record<string, unknown>;
  for (const field of EXTENDED_FIELDS) {
    if (value[field] !== undefined && value[field] !== null) extra[field] = value[field];
  }
  for (const key of Object.keys(value)) {
    const deprecated = DEPRECATED_FIELDS[key];
    if (deprecated !== undefined) warnings.push(label + "的字段 " + key + " 已废弃，已忽略：" + deprecated);
  }

  return server;
}

function looksLikeServer(value: Record<string, unknown>): boolean {
  return "command" in value || "url" in value || "type" in value || "transport" in value || "args" in value;
}

/**
 * 识别粘贴的 JSON。支持四种形态：
 * A. { "mcpServers": { 名称: {...} } }
 * B. { "servers": { 名称: {...} } }（含数组形式）
 * C. { 名称: {...}, 名称2: {...} }（名称→对象映射）
 * D. 单个服务器对象
 */
export function parseMcpJson(text: unknown): ParseResult {
  const warnings: string[] = [];
  const servers: ParsedServer[] = [];

  if (typeof text !== "string" || text.trim() === "") {
    return { servers, warnings: ["请输入要解析的 JSON 内容。"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { servers, warnings: ["JSON 解析失败：" + (error as Error).message] };
  }
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { servers, warnings: ["解析结果不是 JSON 对象。"] };
    }
  }

  const push = (name: string, value: unknown): void => {
    if (!isPlainObject(value)) {
      warnings.push("服务器「" + name + "」不是对象，已跳过。");
      return;
    }
    const nameWarnings: string[] = [];
    const server = mapServerFields(name, value, nameWarnings);
    collectUnknownKeys(name, value, nameWarnings);
    // 名称非法时给出可操作的建议名
    if (!SERVER_NAME_RE.test(name)) {
      warnings.push("名称「" + name + "」不合法（只能字母、数字、下划线、连字符，1–32 位），请改名后再保存。");
    }
    servers.push(server);
    warnings.push(...nameWarnings);
  };

  if (Array.isArray(parsed)) {
    parsed.forEach((item) => {
      if (!isPlainObject(item)) {
        warnings.push("数组里存在非对象元素，已跳过。");
        return;
      }
      const name = typeof item.serverName === "string" ? item.serverName : "";
      if (name === "") {
        warnings.push("数组里的服务器缺少 serverName，已跳过。");
        return;
      }
      push(name, item);
    });
    return { servers, warnings };
  }

  if (!isPlainObject(parsed)) return { servers, warnings: ["解析结果不是 JSON 对象。"] };
  const root = parsed as Record<string, unknown>;

  const container = isPlainObject(root.mcpServers)
    ? (root.mcpServers as Record<string, unknown>)
    : isPlainObject(root.servers) && !Array.isArray(root.servers)
      ? (root.servers as Record<string, unknown>)
      : undefined;

  if (container !== undefined) {
    const entries = Object.entries(container);
    if (entries.length === 0) warnings.push("没有找到任何服务器。");
    for (const [name, value] of entries) push(name, value);
    return { servers, warnings };
  }

  if (Array.isArray(root.servers)) {
    root.servers.forEach((item) => {
      if (isPlainObject(item) && typeof item.serverName === "string") push(item.serverName, item);
      else warnings.push("servers 数组里存在缺少 serverName 的项，已跳过。");
    });
    return { servers, warnings };
  }

  // 单个服务器对象
  if (looksLikeServer(root) && typeof root.serverName === "string") {
    push(root.serverName, root);
    return { servers, warnings };
  }

  // 名称→对象映射
  const entries = Object.entries(root);
  const allObjects = entries.length > 0 && entries.every(([, value]) => isPlainObject(value));
  if (allObjects) {
    for (const [name, value] of entries) push(name, value as Record<string, unknown>);
    return { servers, warnings };
  }

  warnings.push('无法识别的 JSON 结构：请粘贴 { "mcpServers": { ... } } 或「名称 → 服务器对象」映射。');
  return { servers, warnings };
}
