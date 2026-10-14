/**
 * runtime-store.ts：GET mcp/runtime 的唯一读取处——读取、静默刷新、重新连接后重读、保存后等连接结果、轮询。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createRuntimeStore,
  normalizeRuntimeStatus,
  SETTLE_ATTEMPTS,
  type RuntimeAdapter,
  type RuntimeTimers,
} from "../../../src/mcp/client/runtime-store.ts";
import type { RuntimeStatus } from "../../../src/mcp/contract/runtime.ts";
import { makeRow, makeRuntime } from "./fixtures.ts";

function fakeTimers() {
  const ticks: (() => void)[] = [];
  let hidden = false;
  const timers: RuntimeTimers = {
    every(_ms, run) {
      ticks.push(run);
      return () => {
        const index = ticks.indexOf(run);
        if (index >= 0) ticks.splice(index, 1);
      };
    },
    sleep: async () => {},
    hidden: () => hidden,
  };
  return { timers, ticks, setHidden: (value: boolean) => (hidden = value) };
}

function setup(sequence: (RuntimeStatus | Error)[]) {
  const calls: string[] = [];
  let index = 0;
  const adapter: RuntimeAdapter = {
    async status() {
      calls.push("status");
      const next = sequence[Math.min(index, sequence.length - 1)]!;
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    async reconnect(name) {
      calls.push("reconnect " + name);
      return makeRow({ name });
    },
  };
  const timers = fakeTimers();
  return { store: createRuntimeStore(adapter, timers.timers), calls, ...timers };
}

test("读取：成功存快照；没有数据时失败记 error；已有数据后静默失败只记 pollError", async () => {
  const { store } = setup([new Error("接口 500"), makeRuntime([makeRow({ name: "a" })]), new Error("网络断了")]);
  await store.reload();
  assert.equal(store.state.get().error, "接口 500");
  await store.reload();
  assert.equal(store.state.get().error, undefined);
  assert.equal(store.state.get().status?.servers[0]!.name, "a");
  await store.reload(true);
  assert.equal(store.state.get().pollError, "网络断了");
  assert.equal(store.state.get().status?.servers[0]!.name, "a", "旧数据保留");
});

test("重新连接：调接口后重读一次", async () => {
  const { store, calls } = setup([makeRuntime([makeRow({ name: "a" })])]);
  const row = await store.reconnect("a");
  assert.equal(row.name, "a");
  assert.deepEqual(calls, ["reconnect a", "status"]);
});

test("等连接结果：不再是 connecting 就返回那一行；一直连接中则超时返回 undefined", async () => {
  const connecting = makeRuntime([makeRow({ name: "a", state: "connecting", tools: [] })]);
  const done = makeRuntime([makeRow({ name: "a" })]);
  const first = setup([connecting, new Error("读失败不算结束"), done]);
  const row = await first.store.waitSettled("a");
  assert.equal(row?.state, "connected");
  const second = setup([connecting]);
  assert.equal(await second.store.waitSettled("a"), undefined);
  assert.equal(second.calls.length, SETTLE_ATTEMPTS);
});

test("轮询：多处启动只有一个计时器；页面不可见时跳过；全部停止后计时器撤掉", async () => {
  const { store, calls, ticks, setHidden } = setup([makeRuntime([])]);
  const stopA = store.startPolling();
  const stopB = store.startPolling();
  assert.equal(ticks.length, 1);
  ticks[0]!();
  await Promise.resolve();
  assert.equal(calls.length, 1);
  setHidden(true);
  ticks[0]!();
  assert.equal(calls.length, 1, "不可见时不读");
  stopA();
  stopA();
  assert.equal(ticks.length, 1);
  stopB();
  assert.equal(ticks.length, 0);
});

test("normalizeRuntimeStatus：丢掉坏条目，补默认值", () => {
  const status = normalizeRuntimeStatus({
    servers: [
      null as never,
      { name: "a", scope: "global", state: "connected" } as never,
      { name: "b", scope: "session", state: "session", tools: [{ name: "x" }, {} as never], sessions: 2 },
    ],
  });
  assert.deepEqual(
    status.servers.map((server) => [server.name, server.tools.length, server.sessions]),
    [
      ["a", 0, 0],
      ["b", 1, 2],
    ],
  );
  assert.deepEqual(normalizeRuntimeStatus(undefined), { servers: [] });
});
