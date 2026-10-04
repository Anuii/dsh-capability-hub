/**
 * 统一错误码（PLAN §3.1）。handler 抛出的 Error 带 status(number) 与 code(string)，
 * 路由器据此产出 { ok:false, error:{ code, message, details? } }。
 */

export interface HubError extends Error {
  status: number;
  code: string;
  details?: unknown;
}

export function hubError(status: number, code: string, message: string, details?: unknown): HubError {
  const error = new Error(message) as HubError;
  error.status = status;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

export const badRequest = (message: string, details?: unknown) => hubError(400, 'BAD_REQUEST', message, details);
export const notFound = (message: string) => hubError(404, 'NOT_FOUND', message);
export const conflict = (message: string) => hubError(409, 'CONFLICT', message);
export const readOnly = (message: string) => hubError(403, 'READ_ONLY', message);
export const internal = (message: string) => hubError(500, 'INTERNAL', message);
