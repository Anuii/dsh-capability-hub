/**
 * 统一错误码与错误工厂（PLAN §3.1）。
 *
 * handler 抛出的 Error 若带 status(number) 与 code(string)，路由器就用它；
 * 否则一律 500 / INTERNAL。所有 message 都是中文，可直接展示给用户。
 */
import type { HubError } from "./types.ts";

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

/**
 * 构造一个带 status/code 的错误。
 * @param code 统一错误码
 * @param message 中文提示
 * @param details 可选结构化细节（VALIDATION 时为 FieldError[]）
 */
export function hubError(code: ErrorCode, message: string, details?: unknown): HubError {
  const error = new Error(message) as HubError;
  error.name = "HubError";
  error.code = code;
  error.status = ERROR_STATUS[code];
  if (details !== undefined) error.details = details;
  return error;
}

/** 校验失败（422），details = { path, message }[]。 */
export function validationError(details: Array<{ path: string; message: string }>, message = "参数校验未通过"): HubError {
  return hubError("VALIDATION", message, details);
}

/** 400。 */
export function badRequest(message: string, details?: unknown): HubError {
  return hubError("BAD_REQUEST", message, details);
}

/** 404。 */
export function notFound(message: string): HubError {
  return hubError("NOT_FOUND", message);
}

/** 409。 */
export function conflict(message: string): HubError {
  return hubError("CONFLICT", message);
}

/** 403（只读根写入）。 */
export function readOnly(message: string): HubError {
  return hubError("READ_ONLY", message);
}

/** 502（GitHub / skills.sh / 网络失败）。 */
export function upstream(message: string, details?: unknown): HubError {
  return hubError("UPSTREAM", message, details);
}

/** 判断任意抛出物是不是带 code/status 的 HubError。 */
export function asHubError(error: unknown): HubError {
  if (error instanceof Error) return error as HubError;
  const wrapped = new Error(typeof error === "string" ? error : "未知错误") as HubError;
  wrapped.name = "HubError";
  return wrapped;
}
