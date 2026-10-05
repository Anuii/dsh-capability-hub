/**
 * 会话桥的单测（FIX-8）。
 *
 * 这里全部用**实测到的真实形状**：
 *   - subagent/start 只给监听器一个参数 info（dsh-subagent/lib/index.js:235-251），
 *     info = { runId, provider, id, local }，里面没有父会话字段；
 *   - agent/created 的 payload 是 { agent, source }，会话 header 在 agent.session.header；
 *   - session.requestHeader() 是 LLM epoch header，不是会话 header。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachSessionBridge,
  type SessionBridgeClock,
  type SessionBridgeOptions,
} from "../../../src/platform/host/session-bridge.ts";
import type { HubLogger } from "../../../src/platform/contract/host.ts";
import type { McpSessionInfo } from "../../../src/mcp/contract/runtime.ts";

/** 收集日志的替身 logger。 */
function makeLogger(): HubLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (...args: unknown[]): void => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  return { lines, debug: push, info: push, warn: push, error: push };
}

/** 假 ctx：只实现 on/get（还有属性访问）。 */
function makeCtx(extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const ctx: Record<string, unknown> = {
    on(name: string, fn: (...args: unknown[]) => void): () => void {
      const current = listeners.get(name) ?? [];
      current.push(fn);
      listeners.set(name, current);
      return () => {
        const array = listeners.get(name) ?? [];
        const index = array.indexOf(fn);
        if (index >= 0) array.splice(index, 1);
      };
    },
    get(name: string): unknown {
      return (ctx as Record<string, unknown>)[`service:${name}`];
    },
    ...extra,
  };
  const call = (name: string, thisArg: unknown, args: unknown[]): void => {
    for (const fn of [...(listeners.get(name) ?? [])]) fn.apply(thisArg, args);
  };
  return {
    ctx,
    listeners,
    service(name: string, value: unknown): void {
      (ctx as Record<string, unknown>)[`service:${name}`] = value;
    },
    emit(name: string, ...args: unknown[]): void {
      call(name, undefined, args);
    },
    emitWithThis(name: string, thisArg: unknown, ...args: unknown[]): void {
      call(name, thisArg, args);
    },
    listenerCount(name: string): number {
      return (listeners.get(name) ?? []).length;
    },
  };
}

/** 假时钟：手动推进 + 手动触发定时器。 */
function makeClock() {
  const timers: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];
  let now = 1_700_000_000_000;
  const clock: SessionBridgeClock = {
    now: () => now,
    setInterval(callback, ms) {
      const handle = { callback, ms, cancelled: false };
      timers.push(handle);
      return handle;
    },
    clearInterval(handle) {
      (handle as { cancelled: boolean }).cancelled = true;
    },
  };
  return {
    clock,
    timers,
    advance(ms: number): void {
      now += ms;
    },
    tick(times = 1): void {
      for (let index = 0; index < times; index += 1) {
        for (const timer of [...timers]) if (!timer.cancelled) timer.callback();
      }
    },
  };
}

/** 假 sink。 */
function makeSink() {
  const started: McpSessionInfo[] = [];
  const ended: string[] = [];
  return {
    started,
    ended,
    sink: {
      sessionStarted: (info: McpSessionInfo): void => {
        started.push(info);
      },
      sessionEnded: async (sessionId: string): Promise<void> => {
        ended.push(sessionId);
      },
    },
  };
}

/** 等微任务 / 定时器队列排空。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 子代理会话的真实 header 形态（dsh-session:1699-1710）。 */
function childHeader(id: string, parent: string): Record<string, unknown> {
  return {
    version: 4,
    id,
    createdAt: 1,
    isSeeded: false,
    parentSession: parent,
    origin: "subagent",
    delegationDepth: 1,
  };
}

/** subagent/start 的真实 info（dsh-subagent:261-266 / 294-299）。 */
function runInfo(id: string): Record<string, unknown> {
  return { runId: "run-" + id, provider: "in-process", id, local: true };
}

test("实测形状：subagent/start 只传一个 info 参数，父会话来自 agent/created 固化的 header", async () => {
  const world = makeCtx();
  const log = makeLogger();
  const { sink, started } = makeSink();
  const bridge = attachSessionBridge(world.ctx, sink, log, { sweepIntervalMs: 0 });

  world.emit("agent/created", {
    agent: { session: { id: "child-1", header: childHeader("child-1", "parent-1") } },
    source: "startup",
  });
  await flush();
  assert.deepEqual(started, [{ sessionId: "child-1", parentSessionId: "parent-1" }]);

  // 关键：只传一个参数（args[1] 恒为 undefined）。
  world.emit("subagent/start", runInfo("child-1"));
  await flush();

  const records = bridge.events();
  assert.equal(records[0].kind, "created");
  assert.equal(records[0].parentSessionId, "parent-1");
  const subagentStart = records.find((entry) => entry.kind === "subagent-start");
  assert.ok(subagentStart !== undefined);
  assert.equal(subagentStart.parentSessionId, "parent-1");
  assert.equal(started.length, 2);
  assert.equal(started[1].parentSessionId, "parent-1");
});

test("回归（FIX-8）：agent/created 的会话同时有 header 与 requestHeader() 时，以 header 为准", async () => {
  const world = makeCtx();
  const { sink, started } = makeSink();
  const bridge = attachSessionBridge(world.ctx, sink, makeLogger(), { sweepIntervalMs: 0 });

  world.emit("agent/created", {
    agent: {
      session: {
        id: "child-1b",
        header: childHeader("child-1b", "parent-1b"),
        // 真实形状：requestHeader() 是 request/header 事件的折叠（epoch header），
        // 里面只有 config/tools，没有 parentSession/origin（dsh-session:1494-1500）。
        requestHeader: () => ({ config: { model: "deepseek-official" } }),
      },
    },
  });
  await flush();

  assert.equal(started[0].parentSessionId, "parent-1b");
  assert.equal(bridge.events()[0].parentSessionId, "parent-1b");

  // 同一个会话的 subagent/start 也必须继承它。
  world.emit("subagent/start", runInfo("child-1b"));
  await flush();
  assert.equal(started[1].parentSessionId, "parent-1b");
});

test("subagent/start：注册表里能解析到子 agent 时，用它的 session.header.parentSession", async () => {
  const world = makeCtx();
  world.service("agents", {
    get: (id: string) =>
      id === "child-2" ? { session: { id: "child-2", header: childHeader("child-2", "parent-2") } } : undefined,
    list: () => [],
  });
  const { sink, started } = makeSink();
  const bridge = attachSessionBridge(world.ctx, sink, makeLogger(), { sweepIntervalMs: 0 });

  world.emit("subagent/start", runInfo("child-2"));
  await flush();

  assert.equal(started[0].parentSessionId, "parent-2");
  assert.equal(bridge.events()[0].parentSessionId, "parent-2");
});

test("subagent/start：info 里没有父字段，carrier 来源（carrierKeyOf(this)）能补上", async () => {
  const world = makeCtx();
  const carrier = { marker: "scope-carrier" };
  const parents = new Map<unknown, unknown>([[carrier, { session: { id: "parent-3" } }]]);
  const options: SessionBridgeOptions = {
    sweepIntervalMs: 0,
    carrierKeyOf: (value: unknown) => parents.get(value),
  };
  const { sink, started } = makeSink();
  const bridge = attachSessionBridge(world.ctx, sink, makeLogger(), options);

  world.emitWithThis("subagent/start", carrier, runInfo("child-3"));
  await flush();

  assert.equal(started[0].parentSessionId, "parent-3");
  assert.equal(bridge.events()[0].parentSessionId, "parent-3");
});

test("subagent/start：老式两参数 args[1] 兼容分支仍然有效", async () => {
  const world = makeCtx();
  const { sink, started } = makeSink();
  attachSessionBridge(world.ctx, sink, makeLogger(), { sweepIntervalMs: 0 });

  world.emit("subagent/start", runInfo("child-4"), { session: { id: "parent-4" } });
  await flush();

  assert.equal(started[0].parentSessionId, "parent-4");
});

test("session/created 提前给出的 header 线索会被 agent/created 采纳", async () => {
  const world = makeCtx();
  const { sink, started } = makeSink();
  const bridge = attachSessionBridge(world.ctx, sink, makeLogger(), { sweepIntervalMs: 0 });

  world.emit("session/created", { id: "child-5", header: childHeader("child-5", "parent-5") });
  // agent/created 那一刻的 header 只有公共字段（没有 origin/parentSession）。
  world.emit("agent/created", {
    agent: { session: { id: "child-5", header: { version: 4, id: "child-5", isSeeded: false } } },
  });
  await flush();

  assert.equal(started[0].parentSessionId, "parent-5");
  assert.equal(bridge.events()[0].parentSessionId, "parent-5");
});

test("标题：header.title 一并带进 sessionStarted", async () => {
  const world = makeCtx();
  const { sink, started } = makeSink();
  attachSessionBridge(world.ctx, sink, makeLogger(), { sweepIntervalMs: 0 });

  world.emit("agent/created", {
    agent: { session: { id: "child-6", header: { ...childHeader("child-6", "parent-6"), title: "子任务" } } },
  });
  await flush();

  assert.deepEqual(started[0], { sessionId: "child-6", parentSessionId: "parent-6", title: "子任务" });
});

test("agent/created 串行监听器：绝不阻塞、绝不抛", async () => {
  const world = makeCtx();
  const { sink, started } = makeSink();
  const bridge = attachSessionBridge(world.ctx, sink, makeLogger(), { sweepIntervalMs: 0 });

  // 各种畸形载荷都不许抛。
  world.emit("agent/created");
  world.emit("agent/created", {});
  world.emit("agent/created", { agent: { session: { id: 42 } } });
  world.emit("agent/created", { agent: { session: { id: "", header: null } } });
  world.emit("agent/created", "not-an-object");

  // 合法的这条：调用当场不落 sessionStarted（走微任务），说明监听器没有阻塞。
  world.emit("agent/created", { agent: { session: { id: "child-7" } } });
  assert.equal(started.length, 0);
  await flush();
  assert.equal(started.length, 1);
  assert.equal(started[0].sessionId, "child-7");
  assert.equal(bridge.events().length, 1);
});

test("sessionEnded 幂等：disposed + session/disposed + subagent/end 只回一次", async () => {
  const world = makeCtx();
  const { sink, ended } = makeSink();
  const bridge = attachSessionBridge(world.ctx, sink, makeLogger(), { sweepIntervalMs: 0 });

  world.emit("agent/created", { agent: { session: { id: "child-8", header: childHeader("child-8", "parent-8") } } });
  await flush();

  world.emit("agent/disposed", { agent: { session: { id: "child-8" } } });
  world.emit("session/disposed", { id: "child-8", header: childHeader("child-8", "parent-8") });
  world.emit("subagent/end", { ...runInfo("child-8"), stopReason: "completed" });
  await flush();

  assert.deepEqual(ended, ["child-8"]);
  assert.equal(bridge.events().filter((entry) => entry.kind !== "created").length, 1);
  assert.equal(bridge.events()[1].parentSessionId, "parent-8");
});

test("幂等不封死复用：同一个 id 再次 agent/created（resume）后还能正常结束", async () => {
  const world = makeCtx();
  const { sink, ended } = makeSink();
  attachSessionBridge(world.ctx, sink, makeLogger(), { sweepIntervalMs: 0 });

  world.emit("agent/created", { agent: { session: { id: "child-8b" } } });
  await flush();
  world.emit("agent/disposed", { agent: { session: { id: "child-8b" } } });
  await flush();
  assert.deepEqual(ended, ["child-8b"]);

  // 同一个 id 被 resume（DSH 复用会话 id）→ 再次开始时解除封印。
  world.emit("agent/created", { agent: { session: { id: "child-8b" } } });
  await flush();
  world.emit("agent/disposed", { agent: { session: { id: "child-8b" } } });
  await flush();
  assert.deepEqual(ended, ["child-8b", "child-8b"]);
});

test("不在册巡检：连续两次读不到才回收", async () => {
  const world = makeCtx();
  const clock = makeClock();
  const { sink, ended } = makeSink();
  const bridge = attachSessionBridge(world.ctx, sink, makeLogger(), {
    clock: clock.clock,
    sweepIntervalMs: 60_000,
    liveSessionIds: () => [],
    archivedSessionIds: () => [],
  });

  world.emit("agent/created", { agent: { session: { id: "child-9", header: childHeader("child-9", "parent-9") } } });
  await flush();

  clock.tick(1);
  await flush();
  assert.deepEqual(ended, [], "第一次读不到还不动作（注册表可能尚未就绪）");

  clock.tick(1);
  await flush();
  assert.deepEqual(ended, ["child-9"]);
  const last = bridge.events().at(-1);
  assert.equal(last?.kind, "reclaimed");
  assert.equal(last?.reason, "not-live");
  assert.equal(last?.parentSessionId, "parent-9");

  clock.tick(3);
  await flush();
  assert.deepEqual(ended, ["child-9"], "回收后不再重复");
});

test("归档巡检：会话在归档集合里就回收（即使注册表里还活着）", async () => {
  const world = makeCtx();
  const clock = makeClock();
  const { sink, ended } = makeSink();
  const bridge = attachSessionBridge(world.ctx, sink, makeLogger(), {
    clock: clock.clock,
    sweepIntervalMs: 60_000,
    liveSessionIds: () => ["parent-10", "child-10"],
    archivedSessionIds: () => ["child-10"],
  });

  world.emit("agent/created", { agent: { session: { id: "child-10", header: childHeader("child-10", "parent-10") } } });
  await flush();
  clock.tick(1);
  await flush();

  assert.deepEqual(ended, ["child-10"]);
  const last = bridge.events().at(-1);
  assert.equal(last?.kind, "reclaimed");
  assert.equal(last?.reason, "archived");
});

test("workspace/session-stop：停止并归档时立刻回收", async () => {
  const world = makeCtx();
  const { sink, ended } = makeSink();
  attachSessionBridge(world.ctx, sink, makeLogger(), { sweepIntervalMs: 0 });

  world.emit("agent/created", { agent: { session: { id: "child-11", header: childHeader("child-11", "parent-11") } } });
  await flush();
  world.emit("workspace/session-stop", { sessionId: "child-11" });
  await flush();

  assert.deepEqual(ended, ["child-11"]);
});

test("巡检：注册表取不到时什么都不做", async () => {
  const world = makeCtx();
  const clock = makeClock();
  const { sink, ended } = makeSink();
  const log = makeLogger();
  const bridge = attachSessionBridge(world.ctx, sink, log, {
    clock: clock.clock,
    sweepIntervalMs: 60_000,
    liveSessionIds: () => undefined,
    archivedSessionIds: () => undefined,
  });

  world.emit("agent/created", { agent: { session: { id: "child-12" } } });
  await flush();
  clock.tick(3);
  assert.equal(bridge.sweepNow(), 0);
  await flush();

  assert.deepEqual(ended, []);
});

test("巡检：仍然存活的会话不被回收", async () => {
  const world = makeCtx();
  const clock = makeClock();
  const { sink, ended } = makeSink();
  attachSessionBridge(world.ctx, sink, makeLogger(), {
    clock: clock.clock,
    sweepIntervalMs: 60_000,
    liveSessionIds: () => ["child-13"],
    archivedSessionIds: () => [],
  });

  world.emit("agent/created", { agent: { session: { id: "child-13" } } });
  await flush();
  clock.tick(3);
  await flush();

  assert.deepEqual(ended, []);
});

test("默认读取器：从 ctx.get('agents').list() 判定不在册", async () => {
  const world = makeCtx();
  world.service("agents", { list: () => [{ session: { id: "parent-14" } }], get: () => undefined });
  const clock = makeClock();
  const { sink, ended } = makeSink();
  attachSessionBridge(world.ctx, sink, makeLogger(), { clock: clock.clock, sweepIntervalMs: 60_000 });

  world.emit("agent/created", { agent: { session: { id: "child-14", header: childHeader("child-14", "parent-14") } } });
  await flush();
  clock.tick(2);
  await flush();

  assert.deepEqual(ended, ["child-14"]);
});

test("默认读取器：从 ctx.workspaceRegistry.archivedSessionIds 判定已归档", async () => {
  const world = makeCtx();
  world.service("agents", { list: () => [{ session: { id: "child-15" } }] });
  (world.ctx as Record<string, unknown>).workspaceRegistry = { archivedSessionIds: ["child-15"] };
  const clock = makeClock();
  const { sink, ended } = makeSink();
  attachSessionBridge(world.ctx, sink, makeLogger(), { clock: clock.clock, sweepIntervalMs: 60_000 });

  world.emit("agent/created", { agent: { session: { id: "child-15" } } });
  await flush();
  clock.tick(1);
  await flush();

  assert.deepEqual(ended, ["child-15"]);
});

test("默认读取器：归档 getter 抛错（状态未就绪）→ 不误杀", async () => {
  const world = makeCtx();
  world.service("agents", { list: () => [{ session: { id: "child-16" } }] });
  Object.defineProperty(world.ctx, "workspaceRegistry", {
    get() {
      throw new Error("workspace registry state is not ready");
    },
  });
  const clock = makeClock();
  const { sink, ended } = makeSink();
  attachSessionBridge(world.ctx, sink, makeLogger(), { clock: clock.clock, sweepIntervalMs: 60_000 });

  world.emit("agent/created", { agent: { session: { id: "child-16" } } });
  await flush();
  clock.tick(3);
  await flush();

  assert.deepEqual(ended, []);
});

test("dispose：停掉定时器并解绑全部监听", async () => {
  const world = makeCtx();
  const clock = makeClock();
  const { sink, ended } = makeSink();
  const bridge = attachSessionBridge(world.ctx, sink, makeLogger(), {
    clock: clock.clock,
    sweepIntervalMs: 60_000,
    liveSessionIds: () => [],
    archivedSessionIds: () => [],
  });

  world.emit("agent/created", { agent: { session: { id: "child-17" } } });
  await flush();
  bridge.dispose();
  clock.tick(4);
  world.emit("agent/disposed", { agent: { session: { id: "child-17" } } });
  await flush();

  assert.deepEqual(ended, []);
  assert.equal(world.listenerCount("agent/created"), 0);
  assert.equal(world.listenerCount("subagent/start"), 0);
  assert.equal(clock.timers[0].cancelled, true);
});
