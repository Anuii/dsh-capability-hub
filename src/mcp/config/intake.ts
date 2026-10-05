/**
 * 外部配置的识别与导入（D-C2）。
 *
 * 三件事：
 * 1. parse-json：把粘贴的 JSON 识别成服务器数组（mcpServers / servers / 名称→对象映射 / 单个对象）。
 * 2. presets：5 个常用 MCP 服务器模板。
 * 3. 只读导入：Claude Code(<homeDir>/.claude.json) 与 Codex(<homeDir>/.codex/config.toml)。
 *
 * 红线（PLAN §4）：导入路径只 readFile/stat，任何代码路径都不写这些文件，
 * 也不写真实用户目录；homeDir 由调用方注入（测试里是临时目录）。
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isPlainObject } from "./schema.ts";
import { HIDDEN, maskRawServer } from "./mask.ts";
import type { ImportSourceView, McpPreset, ParsedServer, ParseResult, Transport } from "../contract/config.ts";

// —— 通用字段映射 ——

/** 从任意来源对象里挑出本插件认识的字段；返回值为「落盘形态」。 */
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

  return server;
}

const KNOWN_SERVER_KEYS = new Set([
  "serverName",
  "transport",
  "type",
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
]);

/** 把已知字段之外、但本插件不支持的键作为警告收集（导入路径宽容、不拒绝）。 */
function collectUnknownKeys(name: string, value: Record<string, unknown>, warnings: string[]): void {
  const unknown = Object.keys(value).filter((key) => !KNOWN_SERVER_KEYS.has(key));
  if (unknown.length > 0) {
    warnings.push("服务器「" + name + "」里的字段 " + unknown.join("、") + " 不受支持，已忽略。");
  }
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
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) {
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

// —— 预设 ——

/**
 * 5 个预设模板（Windows 可用）。
 * 包名来源：npm registry 上的 @modelcontextprotocol/server-* 与 PyPI 上的 mcp-server-*；
 * 未联网核实时以本表为准。
 */
export const PRESETS: McpPreset[] = [
  {
    id: "fetch",
    title: "网页抓取（fetch）",
    description: "把网页转成 Markdown 供模型阅读。依赖 uv：需要先安装 uv（提供 uvx 命令）。",
    server: { serverName: "fetch", transport: "stdio", command: "uvx", args: ["mcp-server-fetch"], lifecycle: "lazy" },
  },
  {
    id: "time",
    title: "时间与时区（time）",
    description: "查询当前时间并进行时区换算。依赖 uv：需要先安装 uv（提供 uvx 命令）。",
    server: { serverName: "time", transport: "stdio", command: "uvx", args: ["mcp-server-time"], lifecycle: "lazy" },
  },
  {
    id: "memory",
    title: "长期记忆（memory）",
    description: "基于知识图谱的持久记忆。依赖 Node.js：需要已安装 Node.js（提供 npx 命令）。",
    server: {
      serverName: "memory",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      lifecycle: "lazy",
    },
  },
  {
    id: "sequential-thinking",
    title: "分步推理（sequential-thinking）",
    description: "让模型把复杂问题拆成可校验的推理步骤。依赖 Node.js：需要已安装 Node.js（提供 npx 命令）。",
    server: {
      serverName: "sequential-thinking",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      lifecycle: "lazy",
    },
  },
  {
    id: "context7",
    title: "文档检索（context7）",
    description: "按库名检索最新官方文档片段。依赖 Node.js：需要已安装 Node.js（提供 npx 命令）。",
    server: {
      serverName: "context7",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      lifecycle: "lazy",
    },
  },
];

export function listPresets(): McpPreset[] {
  return PRESETS.map((preset) => ({ ...preset, server: { ...preset.server } }));
}

// —— 只读导入 ——

export interface ImportContext {
  homeDir: string;
  logger?: { debug(...a: unknown[]): void; warn(...a: unknown[]): void };
}

/** 读取文本文件；不存在返回 undefined（只读，绝不写）。 */
async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export interface ParsedImport {
  found: boolean;
  path: string;
  servers: ParsedServer[];
  warnings: string[];
  origins: Record<string, string>;
}

async function importClaudeCode(homeDir: string): Promise<ParsedImport> {
  const path = join(homeDir, ".claude.json");
  const text = await readTextIfExists(path);
  const warnings: string[] = [];
  const servers: ParsedServer[] = [];
  const origins: Record<string, string> = {};
  if (text === undefined) return { found: false, path, servers, warnings, origins };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      found: true,
      path,
      servers,
      warnings: ["Claude Code 配置不是合法 JSON：" + (error as Error).message],
      origins,
    };
  }
  if (!isPlainObject(parsed)) {
    return { found: true, path, servers, warnings: ["Claude Code 配置结构异常（顶层不是对象）。"], origins };
  }
  const root = parsed as Record<string, unknown>;

  const take = (entries: Record<string, unknown>, origin: string): void => {
    for (const [name, value] of Object.entries(entries)) {
      if (!isPlainObject(value)) {
        warnings.push("服务器「" + name + "」不是对象，已跳过。");
        continue;
      }
      const localWarnings: string[] = [];
      const mapped = mapServerFields(name, value, localWarnings);
      collectUnknownKeys(name, value, localWarnings);
      if (mapped.transport === "stdio" && (mapped.command === undefined || mapped.command === "")) {
        warnings.push("服务器「" + name + "」缺少 command，已跳过。");
        continue;
      }
      if (mapped.transport === "streamable-http" && (mapped.url === undefined || mapped.url === "")) {
        warnings.push("服务器「" + name + "」缺少 url，已跳过。");
        continue;
      }
      if (servers.some((s) => s.serverName === name)) {
        warnings.push("服务器「" + name + "」在多个来源中重复，只保留第一个（" + origins[name] + "）。");
        continue;
      }
      servers.push(mapped);
      origins[name] = origin;
      warnings.push(...localWarnings.map((w) => (origin === "全局" ? w : "[" + origin + "] " + w)));
    }
  };

  if (isPlainObject(root.mcpServers)) take(root.mcpServers as Record<string, unknown>, "全局");
  if (isPlainObject(root.projects)) {
    for (const [projectPath, project] of Object.entries(root.projects as Record<string, unknown>)) {
      if (!isPlainObject(project)) continue;
      const projectServers = (project as Record<string, unknown>).mcpServers;
      if (!isPlainObject(projectServers)) continue;
      take(projectServers as Record<string, unknown>, projectPath);
    }
  }
  if (servers.length === 0 && warnings.length === 0) warnings.push("没有找到任何 MCP 服务器配置。");
  return { found: true, path, servers, warnings, origins };
}

const CODEX_KNOWN_KEYS = new Set([
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "http_headers",
  "bearer_token_env_var",
  "startup_timeout_sec",
  "tool_timeout_sec",
  "enabled",
]);

async function importCodex(homeDir: string): Promise<ParsedImport> {
  const path = join(homeDir, ".codex", "config.toml");
  const text = await readTextIfExists(path);
  const warnings: string[] = [];
  const servers: ParsedServer[] = [];
  const origins: Record<string, string> = {};
  if (text === undefined) return { found: false, path, servers, warnings, origins };

  let parse: ((input: string) => unknown) | undefined;
  try {
    const spec = "smol-toml";
    const mod: unknown = await import(spec);
    const candidate = (mod as { parse?: unknown }).parse;
    if (typeof candidate === "function") parse = candidate as (input: string) => unknown;
  } catch {
    parse = undefined;
  }
  if (parse === undefined) {
    return {
      found: true,
      path,
      servers,
      warnings: ["TOML 解析器不可用（缺少 smol-toml 依赖），无法读取 Codex 配置。"],
      origins,
    };
  }

  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    return { found: true, path, servers, warnings: ["Codex 配置不是合法 TOML：" + (error as Error).message], origins };
  }
  if (!isPlainObject(parsed)) {
    return { found: true, path, servers, warnings: ["Codex 配置结构异常（顶层不是表）。"], origins };
  }
  const tables = (parsed as Record<string, unknown>).mcp_servers;
  if (!isPlainObject(tables)) {
    return { found: true, path, servers, warnings: ["Codex 配置里没有 [mcp_servers.*] 表。"], origins };
  }

  for (const [name, rawTable] of Object.entries(tables as Record<string, unknown>)) {
    if (!isPlainObject(rawTable)) {
      warnings.push("服务器「" + name + "」不是表，已跳过。");
      continue;
    }
    const table = rawTable as Record<string, unknown>;
    const unknown = Object.keys(table).filter((key) => !CODEX_KNOWN_KEYS.has(key));
    if (unknown.length > 0)
      warnings.push("服务器「" + name + "」里的字段 " + unknown.join("、") + " 无法映射，已忽略。");

    const localWarnings: string[] = [];
    const mapped = mapServerFields(name, table, localWarnings);
    warnings.push(...localWarnings);

    const headers = isPlainObject(table.http_headers) ? (table.http_headers as Record<string, unknown>) : undefined;
    if (headers !== undefined) {
      const mappedHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(headers)) {
        if (typeof value === "string") mappedHeaders[key] = value;
        else warnings.push("服务器「" + name + "」的 http_headers." + key + " 不是字符串，已忽略。");
      }
      if (Object.keys(mappedHeaders).length > 0) mapped.headers = mappedHeaders;
    }
    if (typeof table.bearer_token_env_var === "string" && table.bearer_token_env_var !== "") {
      warnings.push(
        "服务器「" +
          name +
          "」使用 bearer_token_env_var=" +
          table.bearer_token_env_var +
          "：本插件不读取环境变量，导入后请在 headers 里手动填写 Authorization。",
      );
    }
    if (table.startup_timeout_sec !== undefined) {
      warnings.push("服务器「" + name + "」的 startup_timeout_sec 没有对应字段，已忽略。");
    }
    if (
      typeof table.tool_timeout_sec === "number" &&
      Number.isFinite(table.tool_timeout_sec) &&
      table.tool_timeout_sec > 0
    ) {
      mapped.toolCallTimeoutMs = Math.round(table.tool_timeout_sec * 1000);
    }
    if (table.enabled === false) mapped.disabled = true;

    if (mapped.transport === "stdio" && (mapped.command === undefined || mapped.command === "")) {
      warnings.push("服务器「" + name + "」缺少 command，已跳过。");
      continue;
    }
    if (mapped.transport === "streamable-http" && (mapped.url === undefined || mapped.url === "")) {
      warnings.push("服务器「" + name + "」缺少 url，已跳过。");
      continue;
    }
    servers.push(mapped);
    origins[name] = "全局";
  }
  if (servers.length === 0 && warnings.length === 0) warnings.push("没有找到任何 MCP 服务器配置。");
  return { found: true, path, servers, warnings, origins };
}

export const IMPORT_SOURCE_LABELS: Record<"claude-code" | "codex", string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** 只读读取一个导入源（返回值含明文，供导入落盘使用；不得直接回给界面）。 */
export async function readImportSource(
  ctx: ImportContext,
  id: "claude-code" | "codex",
): Promise<{ id: "claude-code" | "codex"; label: string; plain: ParsedImport }> {
  const parsed = id === "claude-code" ? await importClaudeCode(ctx.homeDir) : await importCodex(ctx.homeDir);
  return { id, label: IMPORT_SOURCE_LABELS[id], plain: parsed };
}

/** 列出两个只读导入源；返回的服务器已遮罩，可直接被 upsert 接受。 */
export async function listImportSources(ctx: ImportContext): Promise<ImportSourceView[]> {
  const [claude, codex] = await Promise.all([importClaudeCode(ctx.homeDir), importCodex(ctx.homeDir)]);
  const toView = (id: "claude-code" | "codex", parsed: ParsedImport): ImportSourceView => ({
    id,
    label: IMPORT_SOURCE_LABELS[id],
    path: parsed.path,
    found: parsed.found,
    servers: parsed.servers.map((server) => maskRawServer(server) as ParsedServer),
    warnings: parsed.warnings,
    origins: parsed.origins,
  });
  const views = [toView("claude-code", claude), toView("codex", codex)];
  for (const view of views) {
    ctx.logger?.debug(
      "mcp-config: 导入源 " +
        view.id +
        " path=" +
        view.path +
        " found=" +
        view.found +
        " 服务器数=" +
        view.servers.length,
    );
  }
  return views;
}

export { HIDDEN };
