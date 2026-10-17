/**
 * 「从 Official Registry 搜索」的纯逻辑（0.9.0，界面侧）：结果行视图、服务器名校验与错误文案、
 * 环境变量表单的初值与逐行状态、「能不能保存」的判定、真正提交的配置体与预览 JSON。
 *
 * 不碰 DOM / React / 网络，node:test 直接测（test/mcp/client/registry-pure.test.ts）。
 * 契约只 `import type`（../contract/registry.ts，只读）；文案一律走 strings.ts 的 t()。
 *
 * 三条来自实测的规则：
 * 1. registry 的名字（io.github.user/my-server）不能当 DSH 的服务器名用（只许 [A-Za-z0-9_-]{1,32}），
 *    所以预览里**必须**有一个可编辑的名字，默认值取宿主给的建议名（raw.serverName）；
 * 2. 必填环境变量空着不许保存：`requiresEnv` 里声明的键就是必填，值只认用户在表单里填的；
 * 3. 提交体只带白名单字段（SERVER_FIELDS），serverName 用界面上的值覆盖宿主建议名。
 */

import type { RegistryDetail, RegistryItem, RegistryKind, RegistrySuggestedConfig } from "../../contract/registry.ts";
import { SERVER_NAME_RE } from "../../rules/server.ts";
import { rawToSubmit } from "../intake/pure.ts";
import { t } from "../strings.ts";

/* ---------------- 结果行 ---------------- */

/** 接入方式的中文说法（registry 给的 kinds 顺序原样保留）。 */
export function kindLabel(kind: RegistryKind): string {
  switch (kind) {
    case "remotes":
      return t("mcp.registry.kind.remotes");
    case "npm":
      return t("mcp.registry.kind.npm");
    case "pypi":
      return t("mcp.registry.kind.pypi");
    default:
      return t("mcp.registry.kind.oci");
  }
}

/** 搜索 / 预览里一条 server 的展示形状。 */
export interface RegistryRowView {
  /** 标题：registry 的展示名，没有（或空白）就用 registry 名。 */
  heading: string;
  /** registry 里的完整名（等宽小字展示）。 */
  name: string;
  /** registry 里的版本号（原样展示）。 */
  version: string;
  /** 接入方式的中文标签（0 个时不显示那一行）。 */
  kindLabels: string[];
  /** 「需要填 N 个变量」；没有必填变量时 undefined（不显示）。 */
  needsEnv?: string;
  description?: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** RegistryItem → 界面行（title 缺失时退回 name；必填变量 0 个时不显示「需要填」）。 */
export function registryRowView(item: RegistryItem): RegistryRowView {
  const kinds = Array.isArray(item.kinds) ? item.kinds : [];
  const requiresEnv = stringList(item.requiresEnv);
  return {
    heading: nonEmpty(item.title) ? item.title : item.name,
    name: item.name,
    version: item.version,
    kindLabels: kinds.map(kindLabel),
    ...(requiresEnv.length === 0 ? {} : { needsEnv: t("mcp.registry.needsEnv", { count: requiresEnv.length }) }),
    ...(nonEmpty(item.description) ? { description: item.description } : {}),
  };
}

/* ---------------- 服务器名 ---------------- */

/** 服务器名的问题：空 / 不合法 / 与已有服务器重名。 */
export type NameIssue = "empty" | "invalid" | "conflict";

/**
 * 判定服务器名。顺序有意义：**先判空与合法性，再判重名** ——
 * 一个既非法又重名的输入，用户先要修的是合法性。
 */
export function serverNameIssue(name: string, existingNames: readonly string[] = []): NameIssue | undefined {
  if (name.trim() === "") return "empty";
  if (!SERVER_NAME_RE.test(name)) return "invalid";
  return existingNames.includes(name) ? "conflict" : undefined;
}

/** 服务器名问题的中文说明（直接显示在输入框下面）。 */
export function nameIssueText(issue: NameIssue, name: string): string {
  switch (issue) {
    case "empty":
      return t("mcp.registry.nameEmpty");
    case "invalid":
      return t("mcp.registry.nameInvalid");
    default:
      return t("mcp.registry.nameConflict", { name });
  }
}

/* ---------------- 环境变量表单 ---------------- */

/** 表单里的一行环境变量。 */
export interface EnvFieldView {
  key: string;
  /** 声明为必填（item.requiresEnv）：空着就标红、并且不许保存。 */
  required: boolean;
  /** 输入框占位文字（「必填」/「可选」）。 */
  placeholder: string;
  /** 当前值（初值来自宿主生成的 raw.env，通常是空串）。 */
  value: string;
  /** 必填但空着。 */
  missing: boolean;
}

function requiresOf(item: RegistryItem): string[] {
  return stringList(item.requiresEnv);
}

/**
 * 这条 server 要填的环境变量键，顺序 = raw.env 里的键 + 只在 requiresEnv 里出现的键。
 *
 * 两个来源都要：registry 给出的 env 可能带着非必填的键（例如可选代理开关），
 * 而必填的键宿主可能只在 requiresEnv 里列出、raw.env 里留空。
 */
export function envKeys(item: RegistryItem, raw?: RegistrySuggestedConfig): string[] {
  const keys: string[] = [];
  const env = raw?.env;
  if (env !== undefined && env !== null) {
    for (const key of Object.keys(env)) keys.push(key);
  }
  for (const key of requiresOf(item)) {
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** 表单初值：把宿主生成的 raw.env 原样带进表单（空串就是「还没填」）。 */
export function initialEnvValues(item: RegistryItem, raw?: RegistrySuggestedConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const env = raw?.env;
  for (const key of envKeys(item, raw)) {
    const given = env === undefined || env === null ? undefined : env[key];
    out[key] = typeof given === "string" ? given : "";
  }
  return out;
}

/** 环境变量表单的逐行状态（必填标记 + 空着判定）。 */
export function envFieldViews(
  item: RegistryItem,
  raw: RegistrySuggestedConfig | undefined,
  values: Record<string, string>,
): EnvFieldView[] {
  const required = requiresOf(item);
  return envKeys(item, raw).map((key) => {
    const isRequired = required.includes(key);
    const value = values[key] ?? "";
    return {
      key,
      required: isRequired,
      placeholder: isRequired ? t("mcp.registry.envRequired") : t("mcp.registry.envOptional"),
      value,
      missing: isRequired && value.trim() === "",
    };
  });
}

/** 必填但还空着的变量名（按表单顺序）。 */
export function missingRequiredEnv(
  item: RegistryItem,
  raw: RegistrySuggestedConfig | undefined,
  values: Record<string, string>,
): string[] {
  return envFieldViews(item, raw, values)
    .filter((field) => field.missing)
    .map((field) => field.key);
}

/* ---------------- 能不能保存 ---------------- */

/** 保存按钮的判定结果。 */
export interface SaveGate {
  /** 可以点保存。 */
  ok: boolean;
  /** 名字的问题（有就在输入框下面标红）。 */
  nameIssue?: NameIssue;
  /** 必填但空着的变量名（有就拦住保存并给出汇总提示）。 */
  missingEnv: string[];
}

export interface SaveGateInput {
  /** 当前预览的详情；还在读取或读取失败时是 undefined。 */
  detail?: RegistryDetail | undefined;
  /** 界面上（可编辑的）服务器名。 */
  name: string;
  /** 当前配置里已有的服务器名（重名判定用）。 */
  existingNames?: readonly string[] | undefined;
  /** 环境变量表单的当前值。 */
  envValues?: Record<string, string> | undefined;
}

/**
 * 「现在能不能保存」：能生成（有 raw 且没有 unsupported）、名字没问题、必填变量都填了。
 * 界面的保存按钮 disabled 与拦截提交都用这一份判定，别在组件里另写一套。
 */
export function saveGate(input: SaveGateInput): SaveGate {
  const detail = input.detail;
  const nameIssue = serverNameIssue(input.name, input.existingNames ?? []);
  const raw = detail === undefined || detail.unsupported !== undefined ? undefined : detail.raw;
  const missingEnv =
    detail === undefined || raw === undefined ? [] : missingRequiredEnv(detail.item, raw, input.envValues ?? {});
  return {
    ok: raw !== undefined && nameIssue === undefined && missingEnv.length === 0,
    ...(nameIssue === undefined ? {} : { nameIssue }),
    missingEnv,
  };
}

/* ---------------- 提交体与预览 ---------------- */

/** 表单值 → 真正提交的 env：空白值不落盘（必填的空白已被 saveGate 拦住）。 */
function submitEnv(
  item: RegistryItem,
  raw: RegistrySuggestedConfig,
  values: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const given = raw.env;
  for (const key of envKeys(item, raw)) {
    const fromForm = values[key];
    const value = fromForm === undefined ? (given === undefined || given === null ? "" : (given[key] ?? "")) : fromForm;
    if (value.trim() === "") continue;
    env[key] = value;
  }
  return env;
}

/**
 * 提交给 POST mcp/servers/upsert 的 server 体：宿主生成的配置 + 界面上的名字与环境变量。
 * 只带白名单字段（与粘贴 JSON 走同一份 rawToSubmit）；没有要提交的 env 时整条 env 不落盘。
 */
export function buildSubmitConfig(
  detail: RegistryDetail,
  serverName: string,
  envValues: Record<string, string>,
): Record<string, unknown> | undefined {
  const raw = detail.raw;
  if (raw === undefined) return undefined;
  const env = submitEnv(detail.item, raw, envValues);
  const server: RegistrySuggestedConfig = { ...raw, serverName };
  if (Object.keys(env).length === 0) delete server.env;
  else server.env = env;
  return rawToSubmit(server);
}

/** 预览区那份只读 JSON：与提交体完全一致（两格缩进）。 */
export function previewConfigText(
  detail: RegistryDetail | undefined,
  serverName: string,
  envValues: Record<string, string>,
): string {
  if (detail === undefined) return "";
  const body = buildSubmitConfig(detail, serverName, envValues);
  return body === undefined ? "" : JSON.stringify(body, null, 2);
}
