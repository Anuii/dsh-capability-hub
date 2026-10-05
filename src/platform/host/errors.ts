/**
 * 外壳路由器用的错误归一化。错误码与工厂在 src/shared/errors.ts（外壳与各宿主模块共用）。
 */
import type { ThrownError } from "./types.ts";

/** 任意抛出物 → 可能带 status / code 的 Error（不带的由路由器按 500 / INTERNAL 处理）。 */
export function asHubError(error: unknown): ThrownError {
  if (error instanceof Error) return error as ThrownError;
  const wrapped = new Error(typeof error === "string" ? error : "未知错误") as ThrownError;
  wrapped.name = "HubError";
  return wrapped;
}
