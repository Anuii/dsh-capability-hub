/**
 * runtime-store.ts：MCP 页运行状态的唯一读取处。用内存 adapter 与假计时器，通过仓库的接口测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  POLL_INTERVAL_MS,
  PROBE_ATTEMPTS,
  createRuntimeStore,
  normalizeRuntimeStatus,
  previewAdapter,
  type RuntimeAdapter,
  type RuntimeTimers,
} from "../../../src/mcp/client/runtime-store.ts";
import type { RuntimeStatus } from "../../../src/mcp/contract/runtime.ts";

const status = (toolCount?: number): RuntimeStatus => ({
  servers: [
    {
      name: "demo",
      disabled: false,
      ...(toolCount === undefined ? {} : { cache: { toolCount, updatedAt: 1, stale: false, tools: [] } }),
    },
  ],
  sessions: [],
});

/** 内存 adapter：按顺序吐出预设的结果（Error 表示这一次失败），并记下调用。 */
function fakeAdapter(results: Array<RuntimeStatus | Error>): RuntimeAdapter & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    async status() {
      calls.push("status");
      const next = results[Math.min(index, results.length - 1)]!;
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    async refresh(name) {
      calls.push("refresh:" + name);
      return { toolCount: 4 };
    },
    async disconnect(name, sessionId) {
      calls.push("disconnect:" + name + ":" + (sessionId ?? "*"));
      return { closed: 2 };
    },
  };
}

/** 假计时器：every 记下回调，由测试手动触发；sleep 立即返回。 */
function fakeTimers(): RuntimeTimers & { tick(): void; active(): number; setHidden(value: boolean): void } {
  const runs = new Set<() => void>();
  let hidden = false;
  return {
    every(ms, run) {
      assert.equal(ms, POLL_INTERVAL_MS);
      runs.add(run);
      return () => runs.delete(run);
    },
    sleep: async () => undefined,
    hidden: () => hidden,
    tick: () => [...runs].forEach((run) => run()),
    active: () => runs.size,
    setHidden: (value) => {
      hidden = value;
    },
  };
}

test("reload：成功给快照；还没数据时失败记 error；有数据后静默失败只记 pollError、保留旧数据", async () => {
  const store = createRuntimeStore(
    fakeAdapter([new Error("宿主没响应"), status(1), new Error("断网"), status(2)]),
    fakeTimers(),
  );
  await store.reload(true);
  assert.deepEqual(store.state.get(), { error: "宿主没响应" }, "没有数据时静默失败也要显示错误");
  await store.reload(false);
  assert.deepEqual(store.state.get(), { status: status(1) });
  await store.reload(true);
  assert.deepEqual(store.state.get(), { status: status(1), pollError: "断网" });
  await store.reload(true);
  assert.deepEqual(store.state.get(), { status: status(2) }, "成功后提示消失");
});

test("刷新缓存、断开实例：调用接口后自己重读一次（调用方不必再通知别人）", async () => {
  const adapter = fakeAdapter([status(1)]);
  const store = createRuntimeStore(adapter, fakeTimers());
  assert.deepEqual(await store.refresh("demo"), { toolCount: 4 });
  assert.deepEqual(await store.disconnect("demo"), { closed: 2 });
  await store.disconnect("demo", "s1");
  assert.deepEqual(adapter.calls, [
    "refresh:demo",
    "status",
    "disconnect:demo:*",
    "status",
    "disconnect:demo:s1",
    "status",
  ]);
  assert.deepEqual(store.state.get().status, status(1));
});

test("waitForTools：工具缓存出现就返回工具数；读失败不算结束；最多看 6 次", async () => {
  const found = createRuntimeStore(fakeAdapter([status(), new Error("忙"), status(3)]), fakeTimers());
  assert.equal(await found.waitForTools("demo"), 3);
  assert.deepEqual(found.state.get().status, status(3), "等待期间读到的状态也进快照");

  const adapter = fakeAdapter([status()]);
  const never = createRuntimeStore(adapter, fakeTimers());
  assert.equal(await never.waitForTools("demo"), undefined);
  assert.equal(adapter.calls.length, PROBE_ATTEMPTS);
});

test("轮询：多处启动只用一个计时器；页面不可见时跳过；全部停止后计时器才停", async () => {
  const timers = fakeTimers();
  const adapter = fakeAdapter([status(1)]);
  const store = createRuntimeStore(adapter, timers);
  const stopA = store.startPolling();
  const stopB = store.startPolling();
  assert.equal(timers.active(), 1);
  timers.tick();
  await Promise.resolve();
  assert.equal(adapter.calls.length, 1);
  timers.setHidden(true);
  timers.tick();
  assert.equal(adapter.calls.length, 1, "页面不可见时不读");
  stopA();
  stopA();
  assert.equal(timers.active(), 1, "还有人在用");
  stopB();
  assert.equal(timers.active(), 0);
});

test("开发预览：服务器状态照常读，会话换成示例；断开不调用接口", async () => {
  const sample = (): RuntimeStatus => ({ servers: [], sessions: [{ sessionId: "p", instances: [] }] });
  const base = fakeAdapter([status(1)]);
  const preview = previewAdapter(base, sample);
  assert.deepEqual(await preview.status(), { servers: status(1).servers, sessions: sample().sessions });
  assert.deepEqual(await preview.disconnect("demo"), { closed: 0 });
  assert.equal(base.calls.includes("disconnect:demo:*"), false);
  const broken = previewAdapter(fakeAdapter([new Error("x")]), sample);
  assert.deepEqual((await broken.status()).servers, [], "宿主读不到时预览照样有会话");
});

test("normalizeRuntimeStatus：缺字段补默认值，丢掉坏的实例条目", () => {
  assert.deepEqual(normalizeRuntimeStatus(undefined), { servers: [], sessions: [] });
  const raw = { sessions: [{ instances: [null, { server: "a" }, { nope: 1 }] }] } as unknown as Partial<RuntimeStatus>;
  assert.deepEqual(normalizeRuntimeStatus(raw).sessions, [{ sessionId: "", instances: [{ server: "a" }] }]);
});
