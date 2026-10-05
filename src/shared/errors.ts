/**
 * 宿主侧统一的错误码与错误工厂（外壳与各宿主功能模块共用；ADR-0001 的「共享」区，不知道任何功能）。
 *
 * 路由处理器抛出带 status / code 的错误，外壳的路由器据此产出 { ok: false, error: { code, message, details? } }；
 * 不带的一律 500 / INTERNAL。message 一律是可以直接展示给用户的中文。
 */

import type { HubError } from "../platform/contract/host.ts";

/** 统一错误码 → HTTP 状态。 */
export const ERROR_STATUS = {
  BAD_REQUEST: 400,
  VALIDATION: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  READ_ONLY: 403,
  UPSTREAM: 502,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** 构造一个带 status / code 的错误；details 在 VALIDATION 时是 FieldError[]。 */
export function hubError(code: ErrorCode, message: string, details?: unknown): HubError {
  const error = new Error(message) as HubError;
  error.name = "HubError";
  error.code = code;
  error.status = ERROR_STATUS[code];
  if (details !== undefined) error.details = details;
  return error;
}

export const badRequest = (message: string, details?: unknown): HubError => hubError("BAD_REQUEST", message, details);
/** 校验失败（422）；details = { path, message }[]。 */
export const validation = (message: string, details?: unknown): HubError => hubError("VALIDATION", message, details);
export const notFound = (message: string): HubError => hubError("NOT_FOUND", message);
export const conflict = (message: string): HubError => hubError("CONFLICT", message);
/** 403：只读的技能目录。 */
export const readOnly = (message: string): HubError => hubError("READ_ONLY", message);
/** 502：GitHub / skills.sh / 网络失败。 */
export const upstream = (message: string, details?: unknown): HubError => hubError("UPSTREAM", message, details);
export const rateLimited = (message: string, details?: unknown): HubError => hubError("RATE_LIMITED", message, details);
export const internal = (message: string): HubError => hubError("INTERNAL", message);
