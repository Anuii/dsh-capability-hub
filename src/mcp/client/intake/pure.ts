/**
 * 粘贴 JSON 添加服务器（D-C2，0.7.0 起唯一的添加方式）的纯逻辑：识别计划、同名冲突与改名建议、
 * 勾选与阻断判定。不碰 DOM / React / 网络，node:test 直接测。
 *
 * 「落盘形态」服务器（ParsedServer）由宿主 mapServerFields() 产出：标准写法的字段之外，
 * 本插件自己的字段（envFrom、scope、meta……）也原样带着，保存时由宿主校验。
 */

import type { ParsedServer } from "../../contract/config.ts";
import { HIDDEN, SERVER_FIELDS, SERVER_NAME_RE } from "../../rules/server.ts";
import { isPlainObject } from "../../rules/values.ts";

/** 粘贴预览里一行的状态。 */
export type PasteRowStatus = "new" | "conflict" | "invalid";

export interface PasteRow {
  /** 稳定 key（下标 + 原始名；改名不会重挂载）。 */
  key: string;
  index: number;
  /** 解析出来的原名（只读，用来回显）。 */
  originalName: string;
  /** 当前（可被用户改过的）名称。 */
  name: string;
  status: PasteRowStatus;
  /** 冲突/非法时给出的可用建议名。 */
  suggestedName?: string;
  /** 一行摘要（传输方式 + 命令/地址）。 */
  summary: string;
  server: ParsedServer;
}

/** 名字 → 一行摘要。 */
export function rawSummary(server: ParsedServer): string {
  const transport = server.transport ?? "stdio";
  if (transport === "streamable-http") return "streamable-http · " + (server.url ?? "");
  const args = Array.isArray(server.args) ? server.args : [];
  const command = typeof server.command === "string" && server.command !== "" ? server.command : "（未设置启动命令）";
  return "stdio · " + [command, ...args].join(" ");
}

/** 遮罩值清单：env / headers 里等于 ***hidden*** 的键（导入预览用）。 */
export function hiddenKeys(server: ParsedServer): string[] {
  const out: string[] = [];
  for (const field of ["env", "headers"] as const) {
    const raw = server[field];
    if (!isPlainObject(raw)) continue;
    for (const [key, value] of Object.entries(raw)) {
      if (value === HIDDEN) out.push(field + "." + key);
    }
  }
  return out;
}

/** 把非法字符换成连字符并截到 32 位；结果可能仍为空，调用方负责兜底。 */
function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 32);
}

/**
 * 找一个可用的名字：原名可用就返回原名；否则 base-2、base-3…（同时避开 existingNames 与 taken）。
 * 原名非法时先做字符清洗，再走同一套去重。
 */
export function suggestAvailableName(name: string, taken: readonly string[]): string {
  const takenSet = new Set(taken);
  const cleaned = sanitizeName(name);
  const base = cleaned === "" ? "server" : cleaned.replace(/^-+/, "") || "server";
  if (SERVER_NAME_RE.test(base) && !takenSet.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = "-" + String(index);
    const candidate = base.slice(0, 32 - suffix.length) + suffix;
    if (SERVER_NAME_RE.test(candidate) && !takenSet.has(candidate)) return candidate;
  }
  return base;
}

/** 按「现有配置名 + 同一批里的其他名字」判定一行状态。 */
function statusFor(
  name: string,
  existingNames: readonly string[],
  siblingNames: readonly string[],
): { status: PasteRowStatus; suggestedName?: string } {
  if (!SERVER_NAME_RE.test(name)) {
    return { status: "invalid", suggestedName: suggestAvailableName(name, [...existingNames, ...siblingNames]) };
  }
  if (existingNames.includes(name) || siblingNames.includes(name)) {
    return { status: "conflict", suggestedName: suggestAvailableName(name, [...existingNames, ...siblingNames]) };
  }
  return { status: "new" };
}

/** 把宿主 parse-json 的结果做成预览行（含同名冲突与非法名判定）。 */
export function planPasteRows(servers: readonly ParsedServer[], existingNames: readonly string[]): PasteRow[] {
  return servers.map((server, index) => {
    const others = servers.filter((_, other) => other !== index).map((item) => item.serverName);
    const verdict = statusFor(server.serverName, existingNames, others);
    return {
      key: String(index) + ":" + server.serverName,
      index,
      originalName: server.serverName,
      name: server.serverName,
      status: verdict.status,
      ...(verdict.suggestedName === undefined ? {} : { suggestedName: verdict.suggestedName }),
      summary: rawSummary(server),
      server,
    };
  });
}

/**
 * 改一行的名字并**重算全部行**的状态（同名判定是全局的：改了 A 可能让 B 从冲突变成可用）。
 * key / originalName / summary / server 都保持不变 —— 改名不能让 React 重挂载输入框（会丢焦点）。
 */
export function renameRow(
  rows: readonly PasteRow[],
  index: number,
  name: string,
  existingNames: readonly string[],
): PasteRow[] {
  const names = rows.map((row) => (row.index === index ? name : row.name));
  return rows.map((row, position) => {
    const others = names.filter((_, other) => other !== position);
    const verdict = statusFor(names[position], existingNames, others);
    const next: PasteRow = {
      key: row.key,
      index: row.index,
      originalName: row.originalName,
      name: names[position],
      status: verdict.status,
      summary: row.summary,
      server: row.server,
    };
    return verdict.suggestedName === undefined ? next : { ...next, suggestedName: verdict.suggestedName };
  });
}

/** 默认勾选：只勾没有问题的行；冲突/非法行要用户处理后才勾。 */
export function defaultSelection(rows: readonly PasteRow[]): number[] {
  return rows.filter((row) => row.status === "new").map((row) => row.index);
}

export function toggleSelection(selected: readonly number[], index: number): number[] {
  return selected.includes(index)
    ? selected.filter((item) => item !== index)
    : [...selected, index].sort((a, b) => a - b);
}

/** 勾选里的「还不能保存」的行（冲突没改名 / 名字非法）。 */
export function blockedRows(rows: readonly PasteRow[], selected: readonly number[]): PasteRow[] {
  return rows.filter((row) => selected.includes(row.index) && row.status !== "new");
}

/** 落盘形态 → upsert 的 server 体（只带白名单里的字段，按白名单顺序）。 */
export function rawToSubmit(server: ParsedServer): Record<string, unknown> {
  const out: Record<string, unknown> = { serverName: server.serverName };
  const record = server as unknown as Record<string, unknown>;
  for (const field of SERVER_FIELDS) {
    if (field === "serverName") continue;
    if (record[field] !== undefined) out[field] = record[field];
  }
  return out;
}

/** 粘贴内容里带 ***hidden*** 占位符的服务器名（新建时该占位符会被当成真实值，必须先提示）。 */
export function placeholderNames(servers: readonly ParsedServer[]): string[] {
  return servers.filter((server) => hiddenKeys(server).length > 0).map((server) => server.serverName);
}
