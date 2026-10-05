/**
 * 统一错误码（PLAN §3.1）。handler 抛出的 Error 带 status(number) 与 code(string)，
 * 路由器据此产出 { ok:false, error:{ code, message, details? } }。message 一律中文。
 */

import type { HubError } from "../../platform/contract/host.ts";

export function hubError(status: number, code: string, message: string, details?: unknown): HubError {
  const error = new Error(message) as HubError;
  error.status = status;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

export const badRequest = (message: string, details?: unknown) => hubError(400, "BAD_REQUEST", message, details);
export const notFound = (message: string) => hubError(404, "NOT_FOUND", message);
export const conflict = (message: string) => hubError(409, "CONFLICT", message);
export const validation = (message: string, details?: unknown) => hubError(422, "VALIDATION", message, details);
export const upstream = (message: string, details?: unknown) => hubError(502, "UPSTREAM", message, details);
export const rateLimited = (message: string, details?: unknown) => hubError(429, "RATE_LIMITED", message, details);
export const internal = (message: string) => hubError(500, "INTERNAL", message);

export function isHubError(e: unknown): e is HubError {
  return e instanceof Error && typeof (e as HubError).status === "number" && typeof (e as HubError).code === "string";
}

/** 把任意异常转成中文可读文本（不泄漏令牌：调用方需确保 message 本就不含令牌）。 */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
