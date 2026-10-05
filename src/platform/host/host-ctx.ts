/**
 * 读 DSH 插件上下文（cordis ctx）的两个防御式小工具。
 *
 * DSH 的 Context 是 Proxy 语义：未知键可能抛错而不是返回 undefined，所以一律经这里读。
 */

import type { HubLogger } from "../contract/host.ts";

/** 极简的 cordis ctx 视图（只列平台层用到的部分）。 */
export interface HostCtxView {
  get?(name: string, strict?: boolean): unknown;
  logger?: Partial<HubLogger> & Record<string, unknown>;
  [key: string]: unknown;
}

/** 安全读取 ctx 上的任意服务：失败/缺失都返回 undefined。 */
export function safeGet(ctx: unknown, name: string): unknown {
  const view = ctx as HostCtxView;
  if (typeof view?.get !== "function") return undefined;
  try {
    return view.get(name, false);
  } catch {
    return undefined;
  }
}

/** 包一个恒不抛错的 logger。 */
export function makeLogger(ctx: unknown, tag = "[capability-hub]"): HubLogger {
  const raw = (ctx as HostCtxView)?.logger as Record<string, unknown> | undefined;
  const bind = (level: keyof HubLogger, fallback: (...a: unknown[]) => void): ((...a: unknown[]) => void) => {
    const fn = raw?.[level];
    if (typeof fn !== "function") return fallback;
    return (...args: unknown[]) => {
      try {
        (fn as (...a: unknown[]) => void).call(raw, tag, ...args);
      } catch {
        fallback(...args);
      }
    };
  };
  return {
    debug: bind("debug", () => {}),
    info: bind("info", () => {}),
    warn: bind("warn", (...a) => console.warn(tag, ...a)),
    error: bind("error", (...a) => console.error(tag, ...a)),
  };
}
