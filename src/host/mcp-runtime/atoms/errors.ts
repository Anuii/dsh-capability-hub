/**
 * 带 status / code 的错误，供路由层转成统一错误码（PLAN §3.1）。
 * 所有 message 一律中文，可直接展示给用户。
 */
export class HubError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const BAD_REQUEST = (message: string, details?: unknown): HubError =>
  new HubError(400, 'BAD_REQUEST', message, details);
export const VALIDATION = (message: string, details?: unknown): HubError =>
  new HubError(422, 'VALIDATION', message, details);
export const NOT_FOUND = (message: string): HubError => new HubError(404, 'NOT_FOUND', message);
export const UPSTREAM = (message: string, details?: unknown): HubError =>
  new HubError(502, 'UPSTREAM', message, details);
export const INTERNAL = (message: string, details?: unknown): HubError =>
  new HubError(500, 'INTERNAL', message, details);

/** 把任意抛出物转成可读文本（绝不含 stdout / 令牌）。 */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
