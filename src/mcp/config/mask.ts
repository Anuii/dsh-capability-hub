/**
 * 敏感值遮罩（PLAN §3.5 末段、D-C5）。
 *
 * - 视图里 env / headers 的每个值替换为 "***hidden***"。
 * - upsert 时提交值仍为 "***hidden***" 则保留原值（改名时用 originalName 查原值）。
 * - 只有 reveal 接口返回明文；任何日志都不得出现这些值 —— 用 redact() 后再交给 logger。
 */

import type { EffectiveServer, RawMcpServer } from '../contract/config.ts';

export const HIDDEN = '***hidden***';

/** FIX-3：没有原值可回填时的统一中文说明（upsert 与 validate 逐字一致）。 */
export const HIDDEN_PLACEHOLDER_MESSAGE = '这是遮罩占位符，不是真实值。新建服务器时请填写实际的值。';

/** 需要遮罩的字段名。 */
const SECRET_FIELDS = ['env', 'headers'] as const;

export function isHidden(value: unknown): boolean {
  return value === HIDDEN;
}

/** 值里是否含有任何遮罩占位（用于日志安全断言/自检）。 */
export function containsHidden(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(HIDDEN);
  if (Array.isArray(value)) return value.some(containsHidden);
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsHidden);
  return false;
}

function maskMapInPlace(target: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (typeof target[key] === 'string') target[key] = HIDDEN;
  }
}

/** 复制并遮罩一个落盘服务器（不改原对象）。 */
export function maskRawServer(raw: RawMcpServer | undefined): RawMcpServer | undefined {
  if (raw === undefined) return undefined;
  const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  for (const field of SECRET_FIELDS) {
    const value = copy[field];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) maskMapInPlace(value as Record<string, unknown>);
  }
  return copy as RawMcpServer;
}

/** 复制并遮罩一个生效服务器（不改原对象）。 */
export function maskEffectiveServer(server: EffectiveServer): EffectiveServer {
  const copy = JSON.parse(JSON.stringify(server)) as EffectiveServer;
  const record = copy as unknown as Record<string, unknown>;
  for (const field of SECRET_FIELDS) {
    const value = record[field];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) maskMapInPlace(value as Record<string, unknown>);
  }
  return copy;
}

/**
 * 合并提交的敏感字段与既有值：
 * 值为 "***hidden***" 的项保留原值；原值不存在时丢弃该项（避免把占位符当真实值落盘）。
 */
export function mergeHiddenSecrets(
  submitted: Record<string, string> | undefined,
  existing: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (submitted === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(submitted)) {
    if (isHidden(value)) {
      const original = existing?.[key];
      if (original !== undefined) out[key] = original;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** 字段级错误（与 schema.ts 的 FieldError 同形，避免互相 import）。 */
export interface PlaceholderError {
  path: string;
  message: string;
}

/**
 * FIX-3：找出「提交了遮罩占位符、但原配置里没有对应键可以回填」的项。
 *
 * 为什么要有这一步：`mergeHiddenSecrets` 对这类项是**静默丢弃**，新建服务器那条路径更是
 * 完全不经过它 —— 于是提交的 "***hidden***" 会被当成真实值落盘（T4b-1 实测）。
 * 现在改为在写盘之前逐键报错，path 形如 `server.env.API_KEY`。
 *
 * existing 为 undefined（新建服务器，或 originalName 指向的服务器不存在）时，
 * 所有占位符都算「没有原值」。
 */
export function findHiddenPlaceholders(submitted: unknown, existing: RawMcpServer | undefined): PlaceholderError[] {
  if (submitted === null || typeof submitted !== 'object' || Array.isArray(submitted)) return [];
  const source = submitted as Record<string, unknown>;
  const out: PlaceholderError[] = [];
  for (const field of SECRET_FIELDS) {
    const value = source[field];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const originRaw = existing === undefined ? undefined : (existing as unknown as Record<string, unknown>)[field];
    const origin =
      originRaw !== null && typeof originRaw === 'object' && !Array.isArray(originRaw)
        ? (originRaw as Record<string, unknown>)
        : undefined;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!isHidden(item)) continue;
      if (typeof origin?.[key] === 'string') continue; // 原配置里有这个键 → 保留原值（行为不变）
      out.push({ path: 'server.' + field + '.' + key, message: HIDDEN_PLACEHOLDER_MESSAGE });
    }
  }
  return out;
}

/** 日志安全副本：env / headers 的值全部替换为 "***hidden***"。 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if ((SECRET_FIELDS as readonly string[]).includes(key) && item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const masked: Record<string, unknown> = {};
      for (const name of Object.keys(item as Record<string, unknown>)) masked[name] = HIDDEN;
      out[key] = masked;
      continue;
    }
    out[key] = redact(item);
  }
  return out;
}
