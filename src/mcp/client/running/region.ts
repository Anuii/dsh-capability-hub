/**
 * 「运行中」区域的纯逻辑（D-E1 / UI-DESIGN §4）。
 *
 * 0.3.0 把原「运行态」标签并进 MCP 页底部，成为可折叠的「运行中」区域。折叠规则：
 *   - 没有活跃实例时自动收起，有活跃实例时默认展开；
 *   - 用户手动折叠 / 展开之后按用户的选择走；
 *   - 一旦实例数在「0」与「非 0」之间跃迁，自动规则重新接管（再按上一条决定）。
 *
 * 折叠状态因此只是「上一次看到的实例数 + 用户是否手动干预过」两件事的函数，
 * 与 React 无关，可以直接单测。
 */

import { totalInstances } from "./model.ts";
import type { RuntimeStatus } from "../../contract/runtime.ts";

/** 折叠状态。 */
export interface RunningRegionState {
  /** 用户手动设定的展开状态；undefined = 还没手动干预过，按自动规则。 */
  manual?: boolean;
  /** 上一次观察到的实例数（用来识别 0 ↔ 非 0 的跃迁）。 */
  count: number;
}

/** 初始状态：还没拿到数据，等同「没有活跃实例」（收起）。 */
export const RUNNING_REGION_INITIAL: RunningRegionState = { count: 0 };

/** 当前是否展开。 */
export function runningRegionExpanded(state: RunningRegionState): boolean {
  return state.manual === undefined ? state.count > 0 : state.manual;
}

/**
 * 观察到新的实例数之后，折叠状态怎么变。
 *
 * 只有「0 ↔ 非 0」的跃迁才丢掉用户的手动选择；3 → 4 这种数量变化不动它。
 * 实例数没变时原样返回（避免无谓的重渲染）。
 */
export function runningRegionNext(prev: RunningRegionState, count: number): RunningRegionState {
  if (prev.count === count) return prev;
  if (prev.count === 0 || count === 0) return { count };
  return { ...prev, count };
}

/** 用户点了标题：记下与当前相反的选择。 */
export function runningRegionToggle(state: RunningRegionState): RunningRegionState {
  return { ...state, manual: !runningRegionExpanded(state) };
}

/** 活跃实例总数（数据还没到时算 0）。 */
export function runningInstanceCount(status: RuntimeStatus | undefined): number {
  return totalInstances(status?.sessions ?? []);
}

/**
 * 开发预览用的样例数据（URL 带 ?hubPreviewRunning=1 时用，正式使用时永远走不到）。
 *
 * 走查不允许新建会话，测试 profile 里没有活跃实例，区域本身没有数据可看，
 * 因此这里给一份固定样例：两个会话（其中一个是子代理会话），共 3 个实例。
 */
export function runningPreviewStatus(now: number): RuntimeStatus {
  const started = now - 90_000;
  return {
    servers: [
      { name: "fetch", disabled: false, cache: { toolCount: 3, updatedAt: started, stale: false, tools: [] } },
      { name: "time", disabled: false, cache: { toolCount: 1, updatedAt: started, stale: false, tools: [] } },
    ],
    sessions: [
      {
        sessionId: "preview-parent-0001",
        title: "预览：主会话",
        instances: [
          { server: "fetch", state: "ready", startedAt: started, lastUsedAt: now - 20_000, pid: 4242 },
          { server: "time", state: "ready", startedAt: started, lastUsedAt: now - 30_000, pid: 4243 },
        ],
      },
      {
        sessionId: "preview-child-0002",
        parentSessionId: "preview-parent-0001",
        instances: [{ server: "fetch", state: "connecting", startedAt: now - 5_000, lastUsedAt: now - 5_000 }],
      },
    ],
  };
}
