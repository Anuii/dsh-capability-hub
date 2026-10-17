/**
 * Official MCP Registry 的映射规则（ADR-0008：纯函数，宿主与界面共用；不 import 任何包）。
 *
 * registry 的一条 server 可能同时有 `remotes`（streamable-http / sse）与 `packages`
 * （npm / pypi / oci / mcpb…）。「一键生成配置」按下面的优先级只走一条路：
 *
 *   1. remotes 里有一条 type=streamable-http **且给了 url** → transport 用 streamable-http，只填 url；
 *   2. 否则 npm 包 → `npx -y <identifier> <位置参数…>`；
 *   3. 否则 pypi 包 → `uvx <identifier> <位置参数…>`；
 *   4. 否则 oci 包 → `docker run -i --rm <identifier> <位置参数…>`；
 *   5. 都不行 → 不给配置，只给一句中文原因，写明它到底提供了什么（「只提供 SSE 远程」「只有 mcpb 包」…）。
 *
 * 另外两条硬规矩：
 *   - registry 的名字形如 `io.github.user/my-server`，不能直接当 DSH 的服务器名（只能 [A-Za-z0-9_-]{1,32}），
 *     所以建议名是必做的一步，见 suggestServerName；
 *   - registry 的字段**缺了就缺了，绝不抛错**：少给什么就在 notes 里说清楚，绝不因为缺一个字段整条失败。
 *
 * 真实数据里见过、写规则时要记住的形状（2026-10 实测）：
 *   - remotes[].headers 是**声明式**数组（`{ name, description?, isSecret? }`），通常没有 value
 *     —— 那是要用户自己填的令牌，所以只有带了 value 的才写进 headers，其余进 notes；
 *   - packages[].environmentVariables 不一定有 isRequired / default；
 *   - packages[].transport 一般是 `{ type: "stdio" }`；不是 stdio 的包不能当本地命令启动。
 */

import { SERVER_NAME_RE } from "./server.ts";
import type { RegistryItem, RegistryKind, RegistrySuggestedConfig } from "../contract/registry.ts";

/** 与 rules/server.ts 的服务器名规则一致（DSH 用它拼工具名）。 */
export const MAX_SERVER_NAME_LENGTH = 32;

/** meta.description 的截断长度（registry 的描述有的很长，界面上只显示一段）。 */
export const MAX_DESCRIPTION_LENGTH = 160;

/** 建议名兜底词：名字里一个可用字符都没有时用它。 */
const FALLBACK_NAME = "server";

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** 非空字符串（去掉首尾空白），否则 undefined。 */
function nonEmpty(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text === undefined || text === "" ? undefined : text;
}

/** 只留对象元素（registry 的数组里偶尔有 null / 字符串）。 */
const records = (value: unknown): Rec[] => (Array.isArray(value) ? value.filter(isRec) : []);

/** 拆成字素单元再截断，避免把一个 emoji / 代理对切一半。 */
const chars = (text: string): string[] => Array.from(text);

/**
 * 描述归一化：折掉换行与连续空白（registry 的描述里常有换行），需要时截断到 maxLength 字。
 * 截断时把省略号算进长度，保证结果不超过 maxLength。
 */
export function normalizeDescription(value: unknown, maxLength?: number): string | undefined {
  const text = nonEmpty(value)?.replace(/\s+/g, " ");
  if (text === undefined) return undefined;
  if (maxLength === undefined) return text;
  const units = chars(text);
  if (units.length <= maxLength) return text;
  return units.slice(0, Math.max(1, maxLength - 1)).join("") + "…";
}

/** 第 attempt 个候选名：attempt=1 就是 base，之后依次是 base-2、base-3…（总长不超 32）。 */
function withOrdinalSuffix(base: string, attempt: number): string {
  if (attempt <= 1) return base;
  const suffix = "-" + attempt;
  return base.slice(0, Math.max(1, MAX_SERVER_NAME_LENGTH - suffix.length)) + suffix;
}

/**
 * 由 registry 的名字生成 DSH 的服务器名：取 `/` 之后那一段 → 非法字符换 `-` → 转小写 →
 * 截到 32 → 与 existingNames 重名时依次试 `-2`、`-3`…
 *
 * 结果一定满足 [A-Za-z0-9_-]{1,32}（名字全被替换成 `-` 也合法；一个字符都没有时退回 "server"）。
 * 重名比较不分大小写：已有 "Context7" 时建议 `context7-2`，免得落盘后只差大小写。
 */
export function suggestServerName(registryName: string, existingNames: readonly string[]): string {
  const raw = typeof registryName === "string" ? registryName : "";
  const tail = raw.split("/").pop() ?? "";
  const sanitized = tail
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .toLowerCase()
    .slice(0, MAX_SERVER_NAME_LENGTH);
  const base = SERVER_NAME_RE.test(sanitized) ? sanitized : FALLBACK_NAME;
  const taken = new Set((existingNames ?? []).map((name) => (typeof name === "string" ? name.toLowerCase() : "")));
  for (let attempt = 1; attempt <= 999; attempt += 1) {
    const candidate = withOrdinalSuffix(base, attempt);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return withOrdinalSuffix(base, 999);
}

/**
 * 这条 server 支持的接入方式（决定界面上的类型标签）。
 *
 * 只列**本插件真能接**的形态：只有 SSE 远程的 server 不会得到 "remotes" 标签，
 * 因为它不能一键生成配置（与 mapRegistryServer 的 unsupported 口径一致）。
 */
export function registryKinds(server: unknown): RegistryKind[] {
  const rec = isRec(server) ? server : {};
  const remotes = records(rec.remotes);
  const packages = records(rec.packages);
  const kinds: RegistryKind[] = [];
  if (remotes.some((remote) => remote.type === "streamable-http" && nonEmpty(remote.url) !== undefined)) {
    kinds.push("remotes");
  }
  for (const kind of ["npm", "pypi", "oci"] as const) {
    if (packages.some((pkg) => pkg.registryType === kind)) kinds.push(kind);
  }
  return kinds;
}

/** 声明为必填的环境变量名（界面上提示「还要填这些」）。 */
export function registryRequiredEnv(server: unknown): string[] {
  const rec = isRec(server) ? server : {};
  const out: string[] = [];
  for (const pkg of records(rec.packages)) {
    for (const variable of records(pkg.environmentVariables)) {
      const name = nonEmpty(variable.name);
      if (name === undefined || variable.isRequired !== true) continue;
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** registry 的一条 server → 界面用的 RegistryItem（缺字段就给空值 / 少给字段，绝不抛）。 */
export function registryItemOf(server: unknown): RegistryItem {
  const rec = isRec(server) ? server : {};
  const item: RegistryItem = {
    name: nonEmpty(rec.name) ?? "",
    version: nonEmpty(rec.version) ?? "",
    kinds: registryKinds(rec),
    requiresEnv: registryRequiredEnv(rec),
  };
  const title = nonEmpty(rec.title);
  if (title !== undefined) item.title = title;
  const description = normalizeDescription(rec.description);
  if (description !== undefined) item.description = description;
  return item;
}

/** mapRegistryServer 的结果：要么能一键生成配置，要么给一句中文原因。 */
export type MapRegistryServerResult = { raw: RegistrySuggestedConfig; notes: string[] } | { unsupported: string };

/** 选中的包（只可能是这三类）。 */
interface PackageChoice {
  kind: "npm" | "pypi" | "oci";
  pkg: Rec;
}

/**
 * 按优先级挑一个能当本地命令启动的包：npm → pypi → oci。
 * 挑的过程中发现的问题（缺 identifier、transport 不是 stdio）只进 notes，不抛错。
 */
function pickPackage(packages: readonly Rec[], notes: string[]): PackageChoice | undefined {
  for (const kind of ["npm", "pypi", "oci"] as const) {
    for (const pkg of packages) {
      if (pkg.registryType !== kind) continue;
      if (nonEmpty(pkg.identifier) === undefined) {
        notes.push(kind + " 包没有给出 identifier，跳过它。");
        continue;
      }
      const transport = isRec(pkg.transport) ? nonEmpty(pkg.transport.type) : undefined;
      if (transport !== undefined && transport !== "stdio") {
        notes.push(kind + " 包的 transport 是 " + transport + "（不是 stdio），不能当本地命令启动，跳过它。");
        continue;
      }
      return { kind, pkg };
    }
  }
  return undefined;
}

/** 命令与固定参数前缀。 */
function commandOf(kind: PackageChoice["kind"], identifier: string): { command: string; args: string[] } {
  if (kind === "npm") return { command: "npx", args: ["-y", identifier] };
  if (kind === "pypi") return { command: "uvx", args: [identifier] };
  return { command: "docker", args: ["run", "-i", "--rm", identifier] };
}

/**
 * 把包声明的参数分成位置参数与命名参数：
 * 只有位置参数能接在启动命令后面；命名参数（--port 之类）与没给值的参数只进 notes。
 */
function argumentValues(pkg: Rec, notes: string[]): string[] {
  const positional: string[] = [];
  const named: string[] = [];
  const missing: string[] = [];
  for (const group of [pkg.runtimeArguments, pkg.packageArguments]) {
    for (const arg of records(group)) {
      const type = nonEmpty(arg.type);
      if (type === "named") {
        named.push(nonEmpty(arg.name) ?? nonEmpty(arg.value) ?? "（未命名）");
        continue;
      }
      if (type !== "positional") continue;
      const value = nonEmpty(arg.value);
      if (value === undefined) {
        missing.push(nonEmpty(arg.name) ?? "（未命名）");
        continue;
      }
      positional.push(value);
    }
  }
  if (missing.length > 0) {
    notes.push(
      "包里有 " + missing.length + " 个位置参数 registry 没给值（" + missing.join("、") + "），没有带进启动参数。",
    );
  }
  if (named.length > 0) {
    notes.push("包声明了命名参数（" + named.join("、") + "），没有自动带进启动参数，保存后请按需补上。");
  }
  return positional;
}

/**
 * 包声明的环境变量 → env：有 default 用默认值，否则空串（界面上留空让自己填）。
 * 必填的在 notes 里说清楚。
 */
function envOf(pkg: Rec, notes: string[]): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const variable of records(pkg.environmentVariables)) {
    const name = nonEmpty(variable.name);
    if (name === undefined) {
      notes.push("有一条环境变量 registry 没给名字，已跳过。");
      continue;
    }
    env[name] = asString(variable.default) ?? "";
    if (variable.isRequired === true) notes.push("必填 " + name + "，请填上再保存");
  }
  return Object.keys(env).length === 0 ? undefined : env;
}

/**
 * 远程声明的请求头 → headers。
 *
 * registry 的 headers 是声明式数组（`{ name, description?, isSecret? }`），**通常没有 value**：
 * 那是要用户自己填的令牌。所以只有带 value 的才写进 headers，其余进 notes 提示手填
 * —— 写一个空字符串进去等于发一个空请求头，比不写更容易让人误解。
 */
function headersOf(remote: Rec, notes: string[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const pending: string[] = [];
  for (const header of records(remote.headers)) {
    const name = nonEmpty(header.name);
    if (name === undefined) continue;
    const value = nonEmpty(header.value);
    if (value === undefined) pending.push(name);
    else headers[name] = value;
  }
  if (pending.length > 0) {
    notes.push("远程需要请求头 " + pending.join("、") + "（registry 没给值），保存后请到 JSON 里补上。");
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
}

/** 大写展示远程类型（sse → SSE）。 */
const remoteTypeLabel = (type: string): string => type.toUpperCase();

/** 不能一键生成时的中文原因：先写清它到底提供了什么，再说本插件支持什么。 */
function unsupportedReason(remotes: readonly Rec[], packages: readonly Rec[], hints: readonly string[]): string {
  const described: string[] = [];
  const brokenStreamable = remotes.some(
    (remote) => remote.type === "streamable-http" && nonEmpty(remote.url) === undefined,
  );
  if (brokenStreamable) described.push("声明了 streamable-http 远程但没有给 url");
  const remoteTypes: string[] = [];
  for (const remote of remotes) {
    const type = nonEmpty(remote.type);
    if (type === undefined || type === "streamable-http") continue;
    if (!remoteTypes.includes(type)) remoteTypes.push(type);
  }
  if (remoteTypes.length > 0) {
    described.push(
      (brokenStreamable ? "另外只提供 " : "只提供 ") + remoteTypes.map(remoteTypeLabel).join(" / ") + " 远程",
    );
  }
  const packageTypes: string[] = [];
  for (const pkg of packages) {
    const type = nonEmpty(pkg.registryType);
    if (type === undefined || !["npm", "pypi", "oci"].includes(type)) {
      if (type !== undefined) {
        if (!packageTypes.includes(type)) packageTypes.push(type);
      }
      continue;
    }
  }
  // npm / pypi / oci 存在却仍然走到这里 = 它们不可用，原因已经在 hints 里
  const usableKinds = ["npm", "pypi", "oci"].filter((kind) => packages.some((pkg) => pkg.registryType === kind));
  if (usableKinds.length > 0) {
    described.push("有 " + usableKinds.join(" / ") + " 包但不可用");
  }
  if (packageTypes.length > 0) {
    described.push((described.length > 0 ? "另有 " : "只有 ") + packageTypes.join(" / ") + " 包");
  }
  const head =
    described.length === 0
      ? "这条 server 没有声明任何接入方式（既没有 streamable-http 远程，也没有 npm / pypi / oci 包）"
      : described.join("，");
  const tail =
    hints.length === 0
      ? "。本插件只支持 streamable-http 远程与 npm / pypi / oci 包。"
      : "（" + hints.join("；") + "）。本插件只支持 streamable-http 远程与 npm / pypi / oci 包。";
  return head + tail;
}

/**
 * registry 的一条 server → 可以直接进 upsert 的配置 + 需要人看一眼的 notes；不能生成时给 unsupported。
 *
 * 优先级见文件头。serverName 一定是建议名（见 suggestServerName），meta.description 截到 160 字。
 * 输入可以是任何东西（registry 的响应没有 schema 保证），绝不抛错。
 */
export function mapRegistryServer(server: unknown, existingNames: readonly string[]): MapRegistryServerResult {
  if (!isRec(server)) {
    return { unsupported: "registry 返回的这条 server 不是一个 JSON 对象，无法生成配置。" };
  }
  const registryName = nonEmpty(server.name);
  const serverName = suggestServerName(registryName ?? "", existingNames);
  const notes: string[] = [];
  if (registryName === undefined) notes.push("registry 数据里没有 name，建议名用了兜底名称。");

  const description = normalizeDescription(server.description, MAX_DESCRIPTION_LENGTH);
  const meta = description === undefined ? undefined : { description };
  const remotes = records(server.remotes);
  const packages = records(server.packages);
  const streamable = remotes.find((remote) => remote.type === "streamable-http" && nonEmpty(remote.url) !== undefined);

  // 1) 远程优先（streamable-http 且给了地址）
  if (streamable !== undefined) {
    const raw: RegistrySuggestedConfig = {
      serverName,
      transport: "streamable-http",
      url: nonEmpty(streamable.url) as string,
    };
    const headers = headersOf(streamable, notes);
    if (headers !== undefined) raw.headers = headers;
    if (meta !== undefined) raw.meta = meta;
    if (packages.length > 0) {
      notes.push("这条同时提供了安装包，已优先用远程地址（streamable-http）接入。");
    }
    return { raw, notes };
  }
  if (remotes.some((remote) => remote.type === "streamable-http")) {
    notes.push("远程声明了 streamable-http 但没有给 url，已改用安装包。");
  }

  // 2) 其次包管理器：npm → pypi → oci
  const choice = pickPackage(packages, notes);
  if (choice !== undefined) {
    const identifier = nonEmpty(choice.pkg.identifier) as string;
    const { command, args } = commandOf(choice.kind, identifier);
    const positional = argumentValues(choice.pkg, notes);
    const raw: RegistrySuggestedConfig = {
      serverName,
      transport: "stdio",
      command,
      args: [...args, ...positional],
    };
    const env = envOf(choice.pkg, notes);
    if (env !== undefined) raw.env = env;
    if (meta !== undefined) raw.meta = meta;
    return { raw, notes };
  }

  // 3) 都不行：说清楚它到底提供了什么
  return { unsupported: unsupportedReason(remotes, packages, notes) };
}
