/**
 * 运行态标签的测试夹具（纯数据，不碰 DOM / 网络）。
 *
 * 形状以契约 src/mcp/contract/runtime.ts 与宿主 src/mcp/runtime/status-view.ts 为准：
 * cooldownUntil 只在冷却未结束时出现；没有实例的会话不会出现。
 */
import type { RuntimeServerView, RuntimeSessionView, RuntimeStatus } from "../../../../src/mcp/contract/runtime.ts";

export const T0 = 1_760_000_000_000; // 2025-10-09T08:53:20Z（固定时间戳，测试不依赖真实时钟）

export function makeServer(overrides: Partial<RuntimeServerView> = {}): RuntimeServerView {
  return { name: "demo", disabled: false, ...overrides };
}

export function makeSession(overrides: Partial<RuntimeSessionView> = {}): RuntimeSessionView {
  return { sessionId: "sess-1", instances: [], ...overrides };
}

export function makeStatus(servers: RuntimeServerView[], sessions: RuntimeSessionView[] = []): RuntimeStatus {
  return { servers, sessions };
}

/** 一个有两层会话（父 + 子代理）的快照，用于「只看当前会话」与排序的测试。 */
export function makeNestedStatus(): RuntimeStatus {
  return makeStatus(
    [
      makeServer({ name: "fake", cache: { toolCount: 4, updatedAt: T0, stale: false, tools: [] } }),
      makeServer({
        name: "broken",
        disabled: false,
        lastFailure: { message: "启动失败", at: T0, cooldownUntil: T0 + 60_000 },
      }),
    ],
    [
      makeSession({
        sessionId: "parent-session-0001",
        title: "主会话",
        instances: [{ server: "fake", state: "ready", startedAt: T0, lastUsedAt: T0 + 5000, pid: 4242 }],
      }),
      makeSession({
        sessionId: "child-session-0002",
        parentSessionId: "parent-session-0001",
        instances: [{ server: "fake", state: "connecting", startedAt: T0 + 1000, lastUsedAt: T0 + 2000 }],
      }),
      makeSession({ sessionId: "other-session-0003", instances: [] }),
    ],
  );
}
