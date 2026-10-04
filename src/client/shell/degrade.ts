/**
 * 降级判定：决定页头下方要不要出现那条 warn 横幅（UI-DESIGN §2）。
 *
 * 纯函数，没有 React 也没有 DOM —— 所以可以在 test/client-kit 里直接断言。
 * 规则：**一切正常时返回 undefined**（画面上没有横幅）。
 *   1. 有模块不是 ok  -> 横幅列出模块名；
 *   2. mcp 工具退回桩实现（wiring.runtimeSource === "stub"）或压根没注册 -> 也算降级。
 */
import type { HealthPayload } from "./api.ts";

/** 降级摘要。 */
export interface DegradeInfo {
  /** 状态不是 ok 的模块名（按 health 顺序）。 */
  degraded: string[];
  /** mcp 工具是否不可用（桩实现 / 未注册）。 */
  stubTool: boolean;
}

/** 从 health 里算出降级摘要；一切正常时返回 undefined。 */
export function degradeInfo(health: HealthPayload | undefined): DegradeInfo | undefined {
  if (health === undefined) return undefined;
  const modules = Array.isArray(health.modules) ? health.modules : [];
  const degraded = modules
    .filter((module) => module !== undefined && module.status !== "ok")
    .map((module) => module.name);
  const stubTool = health.wiring?.runtimeSource === "stub" || health.tool?.registered !== true;
  if (degraded.length === 0 && !stubTool) return undefined;
  return { degraded, stubTool };
}

/** 横幅正文用的名字列表（模块名 + 可选的「mcp 工具」）。 */
export function degradeNames(info: DegradeInfo, toolLabel: string): string[] {
  const names = [...info.degraded];
  if (info.stubTool) names.push(toolLabel);
  return names;
}
