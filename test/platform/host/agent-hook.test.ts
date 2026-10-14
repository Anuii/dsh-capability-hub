/**
 * agent-hook.ts：把 agent 的创建与释放转告 MCP 运行时（ADR-0010 按会话挂载）。
 *
 * 假 ctx 只实现 on()，把监听器收起来；载荷按 DSH 的形状给（{ agent: { id, ctx } }）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { attachAgentHook, type AgentSink } from "../../../src/platform/host/agent-hook.ts";
import type { PluginScope } from "../../../src/mcp/contract/runtime.ts";
import type { HubLogger } from "../../../src/platform/contract/host.ts";

interface TestLogger extends HubLogger {
  warnings: string[];
}

function testLogger(): TestLogger {
  const warnings: string[] = [];
  const noop = (): void => {};
  return { warnings, debug: noop, info: noop, warn: (message) => warnings.push(String(message)), error: noop };
}

interface Recording {
  sink: AgentSink;
  created: { sessionId: string; scope: PluginScope }[];
  disposed: string[];
}

function recordingSink(): Recording {
  const created: { sessionId: string; scope: PluginScope }[] = [];
  const disposed: string[] = [];
  return {
    created,
    disposed,
    sink: {
      agentCreated(sessionId, scope) {
        created.push({ sessionId, scope });
      },
      agentDisposed(sessionId) {
        disposed.push(sessionId);
      },
    },
  };
}

function scope(): PluginScope {
  return { plugin: () => ({}) };
}

interface FakeHost {
  ctx: { on(event: string, listener: (...args: unknown[]) => unknown): () => void };
  listeners: Map<string, ((...args: unknown[]) => unknown)[]>;
  unbinds: number;
  emit(event: string, payload?: unknown): void;
}

function fakeHost(): FakeHost {
  const listeners = new Map<string, ((...args: unknown[]) => unknown)[]>();
  const host: FakeHost = {
    listeners,
    unbinds: 0,
    ctx: {
      on(event, listener) {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
        return () => {
          host.unbinds += 1;
          const current = listeners.get(event) ?? [];
          const index = current.indexOf(listener);
          if (index >= 0) current.splice(index, 1);
        };
      },
    },
    emit(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
  };
  return host;
}

describe("agent-hook：agent/created", () => {
  it("载荷 { agent: { id, ctx } } 时转告 sink，ctx 就是 agent 作用域", () => {
    const host = fakeHost();
    const rec = recordingSink();
    attachAgentHook(host.ctx, rec.sink, testLogger());
    const agentScope = scope();
    host.emit("agent/created", { agent: { id: "s1", ctx: agentScope }, source: "user" });
    assert.equal(rec.created.length, 1);
    assert.equal(rec.created[0]?.sessionId, "s1");
    assert.equal(rec.created[0]?.scope, agentScope);
  });

  it("agent 直接用 id 也能认（会话 id 也可能在 agent.session.id）", () => {
    const host = fakeHost();
    const rec = recordingSink();
    attachAgentHook(host.ctx, rec.sink, testLogger());
    host.emit("agent/created", { agent: { session: { id: "s2" }, ctx: scope() } });
    host.emit("agent/created", { id: "s3", ctx: scope() });
    assert.deepEqual(
      rec.created.map((item) => item.sessionId),
      ["s2", "s3"],
    );
  });

  it("没有 ctx 或 ctx.plugin 不是函数 ⇒ 不转告（按会话的服务器挂不上）", () => {
    const host = fakeHost();
    const rec = recordingSink();
    attachAgentHook(host.ctx, rec.sink, testLogger());
    host.emit("agent/created", { agent: { id: "s1" } });
    host.emit("agent/created", { agent: { id: "s2", ctx: {} } });
    host.emit("agent/created", { agent: { id: "s3", ctx: { plugin: "no" } } });
    host.emit("agent/created", { agent: { ctx: scope() } });
    host.emit("agent/created", undefined);
    host.emit("agent/created", 42);
    assert.deepEqual(rec.created, []);
  });

  it("sink 抛错不冒泡，只记一条警告", () => {
    const host = fakeHost();
    const logger = testLogger();
    attachAgentHook(
      host.ctx,
      {
        agentCreated() {
          throw new Error("boom");
        },
        agentDisposed() {},
      },
      logger,
    );
    assert.doesNotThrow(() => host.emit("agent/created", { agent: { id: "s1", ctx: scope() } }));
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0] ?? "", /agent\/created 处理失败/);
  });
});

describe("agent-hook：agent/disposed", () => {
  it("转告 sink.agentDisposed；认不出会话 id 就不转告", () => {
    const host = fakeHost();
    const rec = recordingSink();
    attachAgentHook(host.ctx, rec.sink, testLogger());
    host.emit("agent/disposed", { agent: { id: "s1" } });
    host.emit("agent/disposed", { agent: { session: { id: "s2" } } });
    host.emit("agent/disposed", { agent: {} });
    host.emit("agent/disposed", undefined);
    assert.deepEqual(rec.disposed, ["s1", "s2"]);
  });
});

describe("agent-hook：订阅与解绑", () => {
  it("返回的解绑函数会调用 ctx.on 给的 dispose，之后事件不再转告", () => {
    const host = fakeHost();
    const rec = recordingSink();
    const unbind = attachAgentHook(host.ctx, rec.sink, testLogger());
    unbind();
    assert.equal(host.unbinds, 2, "两个事件各解绑一次");
    host.emit("agent/created", { agent: { id: "s1", ctx: scope() } });
    host.emit("agent/disposed", { agent: { id: "s1" } });
    assert.deepEqual(rec.created, []);
    assert.deepEqual(rec.disposed, []);
  });

  it("没有 ctx.on ⇒ 只记一条警告并返回可调用的空函数", () => {
    const logger = testLogger();
    const rec = recordingSink();
    const unbind = attachAgentHook({}, rec.sink, logger);
    assert.equal(typeof unbind, "function");
    assert.doesNotThrow(() => unbind());
    assert.equal(logger.warnings.length, 1);
    assert.match(logger.warnings[0] ?? "", /ctx\.on 不可用/);
  });

  it("ctx.on 抛错 ⇒ 记警告，不崩（订阅失败）", () => {
    const logger = testLogger();
    const rec = recordingSink();
    const unbind = attachAgentHook(
      {
        on() {
          throw new Error("no event bus");
        },
      },
      rec.sink,
      logger,
    );
    assert.doesNotThrow(() => unbind());
    assert.equal(logger.warnings.length, 2);
    assert.match(logger.warnings[0] ?? "", /订阅 agent\/created 失败/);
  });
});
