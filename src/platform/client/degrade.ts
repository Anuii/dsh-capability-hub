/**
 * 降级判定：决定页头下方要不要出现那条 warn 横幅（UI-DESIGN §2）。
 *
 * 纯函数，没有 React 也没有 DOM —— 所以可以在 test/kit 里直接断言。
 * 规则：**一切正常时返回 undefined**（画面上没有横幅）。有模块不是 ok 时，横幅列出模块名
 * （DSH 官方 MCP 插件加载不了时 mcp-runtime 模块就是降级的，原因在它的 message 里）。
 */
import type { HealthPayload } from "./api.ts";

/** 降级摘要。 */
export interface DegradeInfo {
  /** 状态不是 ok 的模块名（按 health 顺序）。 */
  degraded: string[];
}

/** 从 health 里算出降级摘要；一切正常时返回 undefined。 */
export function degradeInfo(health: HealthPayload | undefined): DegradeInfo | undefined {
  if (health === undefined) return undefined;
  const modules = Array.isArray(health.modules) ? health.modules : [];
  const degraded = modules
    .filter((module) => module !== undefined && module.status !== "ok")
    .map((module) => module.name);
  return degraded.length === 0 ? undefined : { degraded };
}

/**
 * 宿主半与浏览器半的版本是否对不上：插件升级后浏览器半会热更新，宿主半要重启 DSH 才换。
 * 返回宿主报告的版本（老宿主没有这个字段时为 "旧版本"）；对得上、或客户端是开发构建（"dev"）、
 * 或还没拿到 health 时返回 undefined（不出横幅）。
 */
export function hostVersionMismatch(health: HealthPayload | undefined, clientVersion: string): string | undefined {
  if (health === undefined || clientVersion === "dev") return undefined;
  const host = health.host?.pluginVersion;
  if (host === clientVersion) return undefined;
  return typeof host === "string" && host !== "" ? host : "旧版本";
}
