/**
 * runtime.ts（ADR-0010）：把配置里的服务器挂载成官方 dsh-mcp-client 的插件实例。
 *
 * 夹具全是假的：作用域记录 plugin() 的配置与 fiber 的 dispose，配置源可手动触发 onChange，
 * 工具表与 envFrom 执行器可替换。覆盖挂载/指纹/状态/按会话挂载/重连/挂载串行化/dispose。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clientConfigInput,
  createMcpRuntime,
  mountFingerprint,
  toolPrefix,
  type McpRuntimeInternal,
} from "../../../src/mcp/runtime/runtime.ts";
import type { EnvFromRunner } from "../../../src/mcp/runtime/atoms/env-from.ts";
import type { EffectiveMcpConfig, EffectiveServer, McpConfigSource } from "../../../src/mcp/contract/config.ts";
import type { RegisteredTool } from "../../../src/mcp/contract/runtime.ts";
import type { HubLogger } from "../../../src/platform/contract/host.ts";

// ------------------------------------------------------------------ 夹具

interface TestLogger extends HubLogger {
  lines: string[];
}

function testLogger(): TestLogger {
  const lines: string[] = [];
  const push =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(level + " " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  return { lines, debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
}

function server(overrides: Partial<EffectiveServer> & { serverName: string }): EffectiveServer {
  return {
    transport: "stdio",
    args: [],
    env: {},
    envFrom: {},
    allowEmpty: [],
    envFromTimeoutMs: 10000,
    headers: {},
    toolCallTimeoutMs: 60000,
    scope: "global",
    disabled: false,
    ...overrides,
  };
}

class FakeConfig implements McpConfigSource {
  private config: EffectiveMcpConfig;
  private listeners = new Set<(next: EffectiveMcpConfig, prev: EffectiveMcpConfig) => void>();

  constructor(servers: EffectiveServer[]) {
    this.config = { servers };
  }

  get(): EffectiveMcpConfig {
    return this.config;
  }

  onChange(listener: (next: EffectiveMcpConfig, prev: EffectiveMcpConfig) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(servers: EffectiveServer[]): void {
    const prev = this.config;
    this.config = { servers };
    for (const listener of [...this.listeners]) listener(this.config, prev);
  }
}

interface FakeFiber {
  scope: string;
  disposed: boolean;
  disposeCount: number;
  dispose(): Promise<void>;
  then(onFulfilled: (value: unknown) => unknown, onRejected: (error: unknown) => unknown): void;
}

/** 假作用域：plugin() 立即返回一个可 await 的 fiber；failWith 返回错误即模拟激活失败。 */
class FakeScope {
  name: string;
  failWith: (() => unknown) | undefined;
  mounts: { config: Record<string, unknown>; fiber: FakeFiber }[] = [];

  constructor(name: string, failWith?: () => unknown) {
    this.name = name;
    this.failWith = failWith;
  }

  plugin(_plugin: unknown, config: unknown): unknown {
    const failWith = this.failWith;
    const fiber: FakeFiber = {
      scope: this.name,
      disposed: false,
      disposeCount: 0,
      async dispose(): Promise<void> {
        fiber.disposed = true;
        fiber.disposeCount += 1;
      },
      then(onFulfilled, onRejected): void {
        const error = failWith === undefined ? undefined : failWith();
        if (error === undefined) onFulfilled(undefined);
        else onRejected(error);
      },
    };
    this.mounts.push({ config: config as Record<string, unknown>, fiber });
    return fiber;
  }
}

interface HarnessOptions {
  rootFailWith?: () => unknown;
  envFromRunner?: EnvFromRunner;
  envFromResults?: Record<string, { ok: true; value: string } | { ok: false; message: string }>;
}

interface Harness {
  runtime: McpRuntimeInternal;
  config: FakeConfig;
  root: FakeScope;
  logger: TestLogger;
  envFromCalls: { variable: string; command: string; timeoutMs: number }[];
  setTools(tools: RegisteredTool[]): void;
  agentScope(sessionId: string, failWith?: () => unknown): FakeScope;
}

function makeHarness(servers: EffectiveServer[], opts: HarnessOptions = {}): Harness {
  const logger = testLogger();
  const config = new FakeConfig(servers);
  const root = new FakeScope("root", opts.rootFailWith);
  const envFromCalls: { variable: string; command: string; timeoutMs: number }[] = [];
  let tools: RegisteredTool[] = [];
  const runner: EnvFromRunner =
    opts.envFromRunner ??
    (async (variable, command, timeoutMs) => {
      envFromCalls.push({ variable, command, timeoutMs });
      const result = opts.envFromResults?.[variable];
      return result ?? { ok: false, message: 'envFrom: "' + variable + '" 没有准备返回值' };
    });
  const runtime = createMcpRuntime({
    config,
    client: { Config: (input: Record<string, unknown>) => input },
    root,
    listTools: () => tools,
    logger,
    envFromRunner: runner,
  });
  return {
    runtime,
    config,
    root,
    logger,
    envFromCalls,
    setTools(next) {
      tools = next;
    },
    agentScope(sessionId, failWith) {
      const scope = new FakeScope("agent:" + sessionId, failWith);
      runtime.agentCreated(sessionId, scope);
      return scope;
    },
  };
}

// ------------------------------------------------------------------ 纯函数

describe("runtime: 纯函数", () => {
  it("挂载指纹只看影响挂载的字段：描述不算", () => {
    const a = server({ serverName: "a", command: "node", meta: { description: "甲" } });
    const b = server({ serverName: "a", command: "node", meta: { description: "乙" } });
    assert.equal(mountFingerprint(a), mountFingerprint(b));
    assert.notEqual(mountFingerprint(a), mountFingerprint({ ...a, command: "deno" }));
    assert.notEqual(mountFingerprint(a), mountFingerprint({ ...a, scope: "session" }));
    assert.notEqual(mountFingerprint(a), mountFingerprint({ ...a, toolCallTimeoutMs: 1 }));
  });

  it("toolPrefix 是官方命名 mcp__<名字>__", () => {
    assert.equal(toolPrefix("alpha"), "mcp__alpha__");
  });

  it("clientConfigInput：stdio 含 command/args/env，空 cwd 不出现，超时 ≤0 换成一天", () => {
    const stdio = clientConfigInput(
      server({ serverName: "a", command: "node", args: ["x"], env: { A: "1" } }),
      { A: "1" },
      true,
    );
    assert.deepEqual(stdio, {
      transport: "stdio",
      serverName: "a",
      command: "node",
      args: ["x"],
      env: { A: "1" },
      toolCallTimeoutMs: 60000,
      failOnStartupError: true,
    });
    assert.equal("cwd" in stdio, false);
    const withCwd = clientConfigInput(server({ serverName: "a", command: "node", cwd: "C:/x" }), {}, false);
    assert.equal(withCwd.cwd, "C:/x");
    const noTimeout = clientConfigInput(server({ serverName: "a", command: "node", toolCallTimeoutMs: 0 }), {}, true);
    assert.equal(noTimeout.toolCallTimeoutMs, 86400000);
    const negative = clientConfigInput(server({ serverName: "a", command: "node", toolCallTimeoutMs: -5 }), {}, true);
    assert.equal(negative.toolCallTimeoutMs, 86400000);
  });

  it("clientConfigInput：streamable-http 带 url 与 headers", () => {
    const http = clientConfigInput(
      server({
        serverName: "w",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer x" },
      }),
      {},
      true,
    );
    assert.deepEqual(http, {
      transport: "streamable-http",
      serverName: "w",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
      toolCallTimeoutMs: 60000,
      failOnStartupError: true,
    });
  });
});

// ------------------------------------------------------------------ start 与全局挂载

describe("runtime: start 与全局挂载", () => {
  it("只挂载已启用的 scope=global 服务器：停用与按会话的不挂", async () => {
    const h = makeHarness([
      server({ serverName: "alpha", command: "node" }),
      server({ serverName: "beta", command: "node", disabled: true }),
      server({ serverName: "gamma", command: "node", scope: "session" }),
    ]);
    h.setTools([{ name: "mcp__alpha__t" }]);
    h.runtime.start();
    await h.runtime.settle();
    assert.deepEqual(
      h.root.mounts.map((m) => m.config.serverName),
      ["alpha"],
    );
    assert.deepEqual(
      h.runtime.status().servers.map((s) => [s.name, s.state]),
      [
        ["alpha", "connected"],
        ["beta", "disabled"],
        ["gamma", "session"],
      ],
    );
  });

  it("stdio：把 command/args/env 交给 client.Config，cwd 只在非空时出现", async () => {
    const h = makeHarness([
      server({ serverName: "alpha", command: "node", args: ["srv.js"], cwd: "C:/tmp", env: { A: "1" } }),
      server({ serverName: "plain", command: "node" }),
    ]);
    h.runtime.start();
    await h.runtime.settle();
    const alpha = h.root.mounts.find((m) => m.config.serverName === "alpha");
    assert.deepEqual(alpha?.config, {
      transport: "stdio",
      serverName: "alpha",
      command: "node",
      args: ["srv.js"],
      env: { A: "1" },
      cwd: "C:/tmp",
      toolCallTimeoutMs: 60000,
      failOnStartupError: true,
    });
    const plain = h.root.mounts.find((m) => m.config.serverName === "plain");
    assert.equal("cwd" in (plain?.config ?? {}), false);
  });

  it("streamable-http：配置带 url 与 headers", async () => {
    const h = makeHarness([
      server({
        serverName: "web",
        transport: "streamable-http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer x" },
      }),
    ]);
    h.runtime.start();
    await h.runtime.settle();
    assert.deepEqual(h.root.mounts[0]?.config, {
      transport: "streamable-http",
      serverName: "web",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
      toolCallTimeoutMs: 60000,
      failOnStartupError: true,
    });
  });

  it("toolCallTimeoutMs ≤ 0 交给官方插件一天（86400000）", async () => {
    const h = makeHarness([
      server({ serverName: "z", command: "node", toolCallTimeoutMs: 0 }),
      server({ serverName: "n", command: "node", toolCallTimeoutMs: -5 }),
    ]);
    h.runtime.start();
    await h.runtime.settle();
    assert.equal(h.root.mounts.find((m) => m.config.serverName === "z")?.config.toolCallTimeoutMs, 86400000);
    assert.equal(h.root.mounts.find((m) => m.config.serverName === "n")?.config.toolCallTimeoutMs, 86400000);
  });

  it("挂载进行中时状态是 connecting", async () => {
    const h = makeHarness([server({ serverName: "alpha", command: "node" })]);
    h.runtime.start();
    assert.equal(h.runtime.status().servers[0]?.state, "connecting");
    await h.runtime.settle();
  });
});

// ------------------------------------------------------------------ 激活结果

describe("runtime: 激活失败与成功", () => {
  it("激活失败：状态 failed、error 取 cause、fiber 被卸下", async () => {
    const h = makeHarness([server({ serverName: "bad", command: "node" })], {
      rootFailWith: () => new Error("initial connection failed", { cause: new Error("ECONNREFUSED 127.0.0.1") }),
    });
    h.runtime.start();
    await h.runtime.settle();
    const view = h.runtime.status().servers[0];
    assert.equal(view?.state, "failed");
    assert.equal(view?.error, "ECONNREFUSED 127.0.0.1");
    assert.equal(h.root.mounts[0]?.fiber.disposeCount, 1);
    assert.match(h.logger.lines.join("\n"), /连接失败/);
  });

  it("激活失败且没有 cause 时 error 用错误本身的消息", async () => {
    const h = makeHarness([server({ serverName: "bad", command: "node" })], {
      rootFailWith: () => new Error("连接超时"),
    });
    h.runtime.start();
    await h.runtime.settle();
    assert.equal(h.runtime.status().servers[0]?.error, "连接超时");
  });

  it("成功：connected；工具按 mcp__<名字>__ 前缀过滤、按名字排序、描述只取第一行", async () => {
    const h = makeHarness([server({ serverName: "alpha", command: "node" })]);
    h.setTools([
      { name: "mcp__alpha__z", description: "第一行\n第二行" },
      { name: "mcp__alpha__a" },
      { name: "mcp__other__x" },
      { name: "plain" },
    ]);
    h.runtime.start();
    await h.runtime.settle();
    const view = h.runtime.status().servers[0];
    assert.equal(view?.state, "connected");
    assert.deepEqual(view?.tools, [{ name: "mcp__alpha__a" }, { name: "mcp__alpha__z", description: "第一行" }]);
  });

  it("连上但一个工具都没有 ⇒ disconnected", async () => {
    const h = makeHarness([server({ serverName: "alpha", command: "node" })]);
    h.runtime.start();
    await h.runtime.settle();
    assert.equal(h.runtime.status().servers[0]?.state, "disconnected");
  });
});

// ------------------------------------------------------------------ 配置变化

describe("runtime: 配置变化只重挂变了的", () => {
  it("描述变化不重挂", async () => {
    const h = makeHarness([server({ serverName: "a", command: "node", meta: { description: "旧" } })]);
    h.runtime.start();
    await h.runtime.settle();
    const first = h.root.mounts[0]?.fiber;
    h.config.set([server({ serverName: "a", command: "node", meta: { description: "新" } })]);
    await h.runtime.settle();
    assert.equal(h.root.mounts.length, 1);
    assert.equal(first?.disposeCount, 0);
  });

  it("顺序变化不重挂", async () => {
    const h = makeHarness([server({ serverName: "a", command: "node" }), server({ serverName: "b", command: "node" })]);
    h.runtime.start();
    await h.runtime.settle();
    h.config.set([server({ serverName: "b", command: "node" }), server({ serverName: "a", command: "node" })]);
    await h.runtime.settle();
    assert.equal(h.root.mounts.length, 2);
    assert.deepEqual(
      h.root.mounts.map((m) => m.fiber.disposeCount),
      [0, 0],
    );
  });

  it("command 变化 ⇒ 卸下再挂上", async () => {
    const h = makeHarness([server({ serverName: "a", command: "node" })]);
    h.runtime.start();
    await h.runtime.settle();
    const first = h.root.mounts[0]?.fiber;
    h.config.set([server({ serverName: "a", command: "deno" })]);
    await h.runtime.settle();
    assert.equal(h.root.mounts.length, 2);
    assert.equal(first?.disposeCount, 1);
    assert.equal(h.root.mounts[1]?.config.command, "deno");
  });

  it("停用 ⇒ 卸下；重新启用 ⇒ 再挂上", async () => {
    const h = makeHarness([server({ serverName: "a", command: "node" })]);
    h.setTools([{ name: "mcp__a__t" }]);
    h.runtime.start();
    await h.runtime.settle();
    h.config.set([server({ serverName: "a", command: "node", disabled: true })]);
    await h.runtime.settle();
    assert.equal(h.root.mounts[0]?.fiber.disposeCount, 1);
    assert.equal(h.runtime.status().servers[0]?.state, "disabled");
    h.config.set([server({ serverName: "a", command: "node" })]);
    await h.runtime.settle();
    assert.equal(h.root.mounts.length, 2);
    assert.equal(h.root.mounts[1]?.fiber.disposeCount, 0);
    assert.equal(h.runtime.status().servers[0]?.state, "connected");
  });

  it("删除 ⇒ 卸下；新增 ⇒ 挂上", async () => {
    const h = makeHarness([server({ serverName: "a", command: "node" })]);
    h.runtime.start();
    await h.runtime.settle();
    h.config.set([]);
    await h.runtime.settle();
    assert.equal(h.root.mounts[0]?.fiber.disposeCount, 1);
    h.config.set([server({ serverName: "b", command: "node" })]);
    await h.runtime.settle();
    assert.equal(h.root.mounts.length, 2);
    assert.equal(h.root.mounts[1]?.config.serverName, "b");
  });
});

// ------------------------------------------------------------------ envFrom

describe("runtime: envFrom", () => {
  it("失败 ⇒ failed、不调用 plugin、error 说明原因", async () => {
    const h = makeHarness([server({ serverName: "a", command: "node", envFrom: { B: "echo b" } })], {
      envFromResults: { B: { ok: false, message: 'envFrom: "B" 失败（退出码 1）' } },
    });
    h.runtime.start();
    await h.runtime.settle();
    assert.equal(h.root.mounts.length, 0);
    const view = h.runtime.status().servers[0];
    assert.equal(view?.state, "failed");
    assert.match(view?.error ?? "", /envFrom 取值失败/);
    assert.match(view?.error ?? "", /退出码 1/);
  });

  it("成功 ⇒ env 合并后交给官方插件，超时用服务器的 envFromTimeoutMs", async () => {
    const h = makeHarness(
      [
        server({
          serverName: "a",
          command: "node",
          env: { A: "1" },
          envFrom: { B: "echo b" },
          envFromTimeoutMs: 1234,
        }),
      ],
      { envFromResults: { B: { ok: true, value: "bval" } } },
    );
    h.runtime.start();
    await h.runtime.settle();
    assert.deepEqual(h.root.mounts[0]?.config.env, { A: "1", B: "bval" });
    assert.deepEqual(h.envFromCalls, [{ variable: "B", command: "echo b", timeoutMs: 1234 }]);
  });

  it("没有 envFrom 时不执行任何命令", async () => {
    const h = makeHarness([server({ serverName: "a", command: "node", env: { A: "1" } })]);
    h.runtime.start();
    await h.runtime.settle();
    assert.deepEqual(h.envFromCalls, []);
    assert.deepEqual(h.root.mounts[0]?.config.env, { A: "1" });
  });
});

// ------------------------------------------------------------------ 按会话

describe("runtime: scope=session", () => {
  const sess = () => server({ serverName: "s", command: "node", scope: "session" });

  it("agentCreated 挂到该 agent 的作用域，failOnStartupError=false", async () => {
    const h = makeHarness([sess()]);
    h.runtime.start();
    await h.runtime.settle();
    const a1 = h.agentScope("s1");
    await h.runtime.settle();
    assert.equal(h.root.mounts.length, 0);
    assert.equal(a1.mounts.length, 1);
    assert.equal(a1.mounts[0]?.config.failOnStartupError, false);
    assert.equal(a1.mounts[0]?.config.serverName, "s");
  });

  it("status 的 sessions 数随 agentCreated / agentDisposed 增减", async () => {
    const h = makeHarness([sess()]);
    h.runtime.start();
    await h.runtime.settle();
    assert.equal(h.runtime.status().servers[0]?.sessions, 0);
    const a1 = h.agentScope("s1");
    const a2 = h.agentScope("s2");
    await h.runtime.settle();
    assert.equal(h.runtime.status().servers[0]?.state, "session");
    assert.equal(h.runtime.status().servers[0]?.sessions, 2);
    h.runtime.agentDisposed("s1");
    assert.equal(h.runtime.status().servers[0]?.sessions, 1);
    h.runtime.agentDisposed("s2");
    assert.equal(h.runtime.status().servers[0]?.sessions, 0);
    // 挂载随 agent 作用域由 DSH 回收，这里只记账：fiber 不被本插件 dispose
    assert.equal(a1.mounts[0]?.fiber.disposeCount, 0);
    assert.equal(a2.mounts[0]?.fiber.disposeCount, 0);
  });

  it("配置变化会在现存 agent 上重挂", async () => {
    const h = makeHarness([sess()]);
    h.runtime.start();
    await h.runtime.settle();
    const a1 = h.agentScope("s1");
    const a2 = h.agentScope("s2");
    await h.runtime.settle();
    h.config.set([server({ serverName: "s", command: "deno", scope: "session" })]);
    await h.runtime.settle();
    assert.equal(a1.mounts.length, 2);
    assert.equal(a2.mounts.length, 2);
    assert.equal(a1.mounts[0]?.fiber.disposeCount, 1);
    assert.equal(a1.mounts[1]?.config.command, "deno");
  });

  it("停用按会话的服务器会从现存 agent 上卸下", async () => {
    const h = makeHarness([sess()]);
    h.runtime.start();
    await h.runtime.settle();
    const a1 = h.agentScope("s1");
    await h.runtime.settle();
    h.config.set([server({ serverName: "s", command: "node", scope: "session", disabled: true })]);
    await h.runtime.settle();
    assert.equal(a1.mounts[0]?.fiber.disposeCount, 1);
    assert.equal(h.runtime.status().servers[0]?.state, "disabled");
  });

  it("同一个 agent 重复 agentCreated 只挂一次", async () => {
    const h = makeHarness([sess()]);
    h.runtime.start();
    await h.runtime.settle();
    const a1 = new FakeScope("agent:s1");
    h.runtime.agentCreated("s1", a1);
    h.runtime.agentCreated("s1", a1);
    await h.runtime.settle();
    assert.equal(a1.mounts.length, 1);
  });
});

// ------------------------------------------------------------------ 按会话的 envFrom 缓存与失败隔离

describe("runtime: 按会话的 envFrom 与失败隔离", () => {
  const envSess = () => server({ serverName: "s", command: "node", scope: "session", envFrom: { TOKEN: "echo t" } });

  it("按会话的 envFrom 多个 agent 共用一个缓存，指纹变了或 reconnect 才重新取值", async () => {
    const h = makeHarness([envSess()], { envFromResults: { TOKEN: { ok: true, value: "tok" } } });
    h.runtime.start();
    await h.runtime.settle();
    const a1 = h.agentScope("s1");
    const a2 = h.agentScope("s2");
    await h.runtime.settle();
    assert.equal(h.envFromCalls.length, 1, "同一个服务器在两个 agent 上只解析一次");
    assert.deepEqual(a1.mounts[0]?.config.env, { TOKEN: "tok" });
    assert.deepEqual(a2.mounts[0]?.config.env, { TOKEN: "tok" });

    // 描述这类不进指纹的字段变了：不重挂，也不重新取值
    h.config.set([server({ ...envSess(), meta: { description: "换个描述" } })]);
    await h.runtime.settle();
    assert.equal(h.envFromCalls.length, 1);
    assert.equal(a1.mounts.length, 1);

    // 影响挂载的字段变了 ⇒ 指纹变 ⇒ 缓存自然失效，重新取值
    h.config.set([server({ ...envSess(), command: "deno" })]);
    await h.runtime.settle();
    assert.equal(h.envFromCalls.length, 2, "指纹变了就重新取值");
    assert.equal(a1.mounts.length, 2);
    assert.deepEqual(a1.mounts[1]?.config.env, { TOKEN: "tok" });

    // reconnect 主动清缓存 ⇒ 再取一次
    await h.runtime.reconnect("s");
    assert.equal(h.envFromCalls.length, 3, "reconnect 清掉缓存后重新取值");
  });

  it("按会话激活失败不冒泡：agentCreated 不抛、settle 不 reject，同 agent 上其他服务器照挂", async () => {
    const h = makeHarness([
      server({ serverName: "boom", command: "node", scope: "session" }),
      server({ serverName: "fine", command: "node", scope: "session" }),
    ]);
    h.runtime.start();
    await h.runtime.settle();
    let a1: FakeScope | undefined;
    // 只让 boom 激活失败：failWith 在激活时读「最后一次 plugin 挂的是谁」
    const failWith = (): unknown => {
      const last = a1?.mounts[a1.mounts.length - 1]?.config.serverName;
      return last === "boom" ? new Error("initial connection failed") : undefined;
    };
    a1 = h.agentScope("s1", failWith);
    await h.runtime.settle();
    assert.equal(a1.mounts.length, 2, "两台都尝试过挂载");
    assert.equal(a1.mounts[0]?.config.serverName, "boom");
    assert.equal(a1.mounts[1]?.config.serverName, "fine", "同 agent 上其他服务器照挂");
    const warns = h.logger.lines.filter((line) => line.startsWith("warn ") && line.includes("boom"));
    assert.equal(warns.length, 1, "只记一条 warn，不冒泡给 agent");
    assert.match(warns[0] ?? "", /挂到会话 s1 失败/);
    assert.match(warns[0] ?? "", /initial connection failed/);
  });

  it("按会话的 envFrom 取值失败 ⇒ 不在该 agent 上挂载，warn 说明原因", async () => {
    const h = makeHarness([envSess()], {
      envFromResults: { TOKEN: { ok: false, message: 'envFrom: "TOKEN" 失败（退出码 1）' } },
    });
    h.runtime.start();
    await h.runtime.settle();
    const a1 = h.agentScope("s1");
    await h.runtime.settle();
    assert.equal(a1.mounts.length, 0, "取不到值就不挂，绝不注入空值");
    const warns = h.logger.lines.filter((line) => line.startsWith("warn ") && line.includes("envFrom 取值失败"));
    assert.equal(warns.length, 1);
    assert.match(warns[0] ?? "", /服务器 s/);
    assert.match(warns[0] ?? "", /s1/);
    assert.match(warns[0] ?? "", /退出码 1/);
  });
});

// ------------------------------------------------------------------ reconnect

describe("runtime: reconnect", () => {
  it("未知服务器 404、已停用 409", async () => {
    const h = makeHarness([server({ serverName: "off", command: "node", disabled: true })]);
    h.runtime.start();
    await h.runtime.settle();
    await assert.rejects(
      h.runtime.reconnect("nope"),
      (error: { status?: number; code?: string }) => error.status === 404 && error.code === "NOT_FOUND",
    );
    await assert.rejects(
      h.runtime.reconnect("off"),
      (error: { status?: number; code?: string }) => error.status === 409 && error.code === "CONFLICT",
    );
  });

  it("全局服务器：卸下再挂上，返回该服务器视图", async () => {
    const h = makeHarness([server({ serverName: "g", command: "node" })]);
    h.setTools([{ name: "mcp__g__t" }]);
    h.runtime.start();
    await h.runtime.settle();
    const first = h.root.mounts[0]?.fiber;
    const view = await h.runtime.reconnect("g");
    assert.equal(view.name, "g");
    assert.equal(view.scope, "global");
    assert.equal(view.state, "connected");
    assert.equal(h.root.mounts.length, 2);
    assert.equal(first?.disposeCount, 1);
  });

  it("按会话服务器：在每个现存 agent 上重挂", async () => {
    const h = makeHarness([server({ serverName: "s", command: "node", scope: "session" })]);
    h.runtime.start();
    await h.runtime.settle();
    const a1 = h.agentScope("s1");
    const a2 = h.agentScope("s2");
    await h.runtime.settle();
    const view = await h.runtime.reconnect("s");
    assert.equal(view.name, "s");
    assert.equal(view.state, "session");
    assert.equal(view.sessions, 2);
    assert.equal(a1.mounts.length, 2);
    assert.equal(a2.mounts.length, 2);
    assert.equal(a1.mounts[0]?.fiber.disposeCount, 1);
    assert.equal(a2.mounts[0]?.fiber.disposeCount, 1);
  });
});

// ------------------------------------------------------------------ 挂载串行化

/** 串行化用的假 fiber：dispose() 挂在作用域的闸门上，release() 之前不会结束。 */
interface GatedFiber {
  scope: string;
  serverName: string;
  disposed: boolean;
  disposeCount: number;
  dispose(): Promise<void>;
  then(onFulfilled: (value: unknown) => unknown, onRejected: (error: unknown) => unknown): void;
}

/**
 * 带闸门的假作用域（挂载串行化的用例专用）：
 *   - plugin() 立即返回可 await 的 fiber（激活即时成功；给了 failWith 就按它失败）；
 *   - fiber.dispose() 一直挂到 release() 为止（手动 deferred，不用定时器），
 *     这样就能把「旧挂载还没卸完」这一刻定住；
 *   - live / maxLive 记同一名字的存活 fiber 数：plugin 时 +1，dispose 真正结束时 -1。
 */
class GatedScope {
  name: string;
  failWith: (() => unknown) | undefined;
  mounts: { config: Record<string, unknown>; fiber: GatedFiber }[] = [];
  live = new Map<string, number>();
  maxLive = new Map<string, number>();
  private opened = false;
  private waiters: (() => void)[] = [];

  constructor(name: string, failWith?: () => unknown) {
    this.name = name;
    this.failWith = failWith;
  }

  plugin(_plugin: unknown, config: unknown): unknown {
    const record = config as Record<string, unknown>;
    const serverName = String(record.serverName);
    const scope = this;
    const failWith = this.failWith;
    const fiber: GatedFiber = {
      scope: this.name,
      serverName,
      disposed: false,
      disposeCount: 0,
      dispose(): Promise<void> {
        fiber.disposeCount += 1;
        return new Promise<void>((resolve) => {
          const finish = (): void => {
            fiber.disposed = true;
            scope.live.set(serverName, (scope.live.get(serverName) ?? 1) - 1);
            resolve();
          };
          if (scope.opened) finish();
          else scope.waiters.push(finish);
        });
      },
      then(onFulfilled, onRejected): void {
        const error = failWith === undefined ? undefined : failWith();
        if (error === undefined) onFulfilled(undefined);
        else onRejected(error);
      },
    };
    this.mounts.push({ config: record, fiber });
    const count = (this.live.get(serverName) ?? 0) + 1;
    this.live.set(serverName, count);
    this.maxLive.set(serverName, Math.max(this.maxLive.get(serverName) ?? 0, count));
    return fiber;
  }

  /** 放行所有挂起中的 dispose()；之后新发起的 dispose() 立即结束。 */
  release(): void {
    this.opened = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  /** 这个作用域上某台服务器被挂过几次。 */
  mountsOf(serverName: string): { config: Record<string, unknown>; fiber: GatedFiber }[] {
    return this.mounts.filter((entry) => entry.config.serverName === serverName);
  }
}

/** 把已经排队的微任务跑完（被闸门挡住的卸载不算），替代定时器与 sleep。 */
async function flush(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

interface SerialHarness {
  runtime: McpRuntimeInternal;
  config: FakeConfig;
  root: GatedScope;
  logger: TestLogger;
  envFromCalls: { variable: string; command: string; timeoutMs: number }[];
  setTools(tools: RegisteredTool[]): void;
  agentScope(sessionId: string, failWith?: () => unknown): GatedScope;
}

/** 与 makeHarness 同形，只是把假作用域换成带闸门的 GatedScope。 */
function makeSerialHarness(servers: EffectiveServer[]): SerialHarness {
  const logger = testLogger();
  const config = new FakeConfig(servers);
  const root = new GatedScope("root");
  const envFromCalls: { variable: string; command: string; timeoutMs: number }[] = [];
  let tools: RegisteredTool[] = [];
  const runner: EnvFromRunner = async (variable, command, timeoutMs) => {
    envFromCalls.push({ variable, command, timeoutMs });
    return { ok: false, message: 'envFrom: "' + variable + '" 没有准备返回值' };
  };
  const runtime = createMcpRuntime({
    config,
    client: { Config: (input: Record<string, unknown>) => input },
    root,
    listTools: () => tools,
    logger,
    envFromRunner: runner,
  });
  return {
    runtime,
    config,
    root,
    logger,
    envFromCalls,
    setTools(next) {
      tools = next;
    },
    agentScope(sessionId, failWith) {
      const scope = new GatedScope("agent:" + sessionId, failWith);
      runtime.agentCreated(sessionId, scope);
      return scope;
    },
  };
}

describe("挂载串行化", () => {
  it("全局：旧挂载没卸完之前不挂新的，卸完才用新配置挂一次", async () => {
    const h = makeSerialHarness([server({ serverName: "a", command: "node" })]);
    h.setTools([{ name: "mcp__a__t" }]);
    h.runtime.start();
    await h.runtime.settle();
    assert.equal(h.root.mountsOf("a").length, 1);

    h.config.set([server({ serverName: "a", command: "deno" })]);
    await flush();
    assert.equal(h.root.mountsOf("a")[0]?.fiber.disposeCount, 1, "旧挂载开始卸下");
    assert.equal(h.root.mountsOf("a").length, 1, "旧挂载没卸完之前不得调用 plugin 挂新的");

    h.root.release();
    await h.runtime.settle();
    assert.equal(h.root.mountsOf("a").length, 2, "卸完之后恰好再挂一次");
    assert.equal(h.root.mountsOf("a")[1]?.config.command, "deno", "挂的是新配置");
    assert.equal(h.root.live.get("a"), 1, "该名字的存活 fiber 恰好 1 个");
    assert.equal(h.root.maxLive.get("a"), 1);
    assert.equal(h.runtime.status().servers[0]?.state, "connected");
  });

  it("按会话：旧挂载没卸完之前不在该 agent 上挂新的，卸完才用新配置挂一次", async () => {
    const h = makeSerialHarness([server({ serverName: "s", command: "node", scope: "session" })]);
    h.runtime.start();
    await h.runtime.settle();
    const a1 = h.agentScope("s1");
    await h.runtime.settle();
    assert.equal(a1.mountsOf("s").length, 1);

    h.config.set([server({ serverName: "s", command: "deno", scope: "session" })]);
    await flush();
    assert.equal(a1.mountsOf("s")[0]?.fiber.disposeCount, 1, "旧挂载开始卸下");
    assert.equal(a1.mountsOf("s").length, 1, "旧挂载没卸完之前不得再挂");

    a1.release();
    await h.runtime.settle();
    assert.equal(a1.mountsOf("s").length, 2, "卸完之后恰好再挂一次");
    assert.equal(a1.mountsOf("s")[1]?.config.command, "deno", "挂的是新配置");
    assert.equal(a1.maxLive.get("s"), 1);
  });

  it("全局 reconnect：先卸完再挂上", async () => {
    const h = makeSerialHarness([server({ serverName: "g", command: "node" })]);
    h.setTools([{ name: "mcp__g__t" }]);
    h.runtime.start();
    await h.runtime.settle();
    const first = h.root.mountsOf("g")[0]?.fiber;

    const done = h.runtime.reconnect("g");
    await flush();
    assert.equal(first?.disposeCount, 1, "reconnect 先卸下旧挂载");
    assert.equal(h.root.mountsOf("g").length, 1, "旧挂载没卸完之前不得挂上新的");

    h.root.release();
    const view = await done;
    await h.runtime.settle();
    assert.equal(h.root.mountsOf("g").length, 2, "卸完之后挂上");
    assert.equal(view.state, "connected");
    assert.equal(h.root.live.get("g"), 1);
    assert.equal(h.root.maxLive.get("g"), 1);
  });

  it("连改两次配置：最终挂上最新配置，同一名字的存活 fiber 始终不超过 1 个", async () => {
    const h = makeSerialHarness([server({ serverName: "a", command: "node" })]);
    h.setTools([{ name: "mcp__a__t" }]);
    h.runtime.start();
    await h.runtime.settle();

    h.config.set([server({ serverName: "a", command: "deno" })]);
    await flush();
    // 第一次卸载还没结束，配置又变了一次
    h.config.set([server({ serverName: "a", command: "bun" })]);
    await flush();
    assert.equal(h.root.mountsOf("a").length, 1, "两次卸载都没完成，谁都不许挂");

    h.root.release();
    await h.runtime.settle();
    const mounted = h.root.mountsOf("a");
    assert.equal(mounted.length, 2, "只挂了最初那次与最终那次，中间那次被代次挡掉");
    assert.equal(mounted[1]?.config.command, "bun", "挂上的是最新配置");
    assert.equal(h.root.live.get("a"), 1, "任何时刻存活 fiber 不超过 1 个");
    assert.equal(h.root.maxLive.get("a"), 1);
    assert.equal(h.runtime.status().servers[0]?.state, "connected");
  });

  it("按会话 reconnect：每个 agent 各自先卸完再挂", async () => {
    const h = makeSerialHarness([server({ serverName: "s", command: "node", scope: "session" })]);
    h.runtime.start();
    await h.runtime.settle();
    const a1 = h.agentScope("s1");
    const a2 = h.agentScope("s2");
    await h.runtime.settle();

    const done = h.runtime.reconnect("s");
    await flush();
    assert.equal(a1.mountsOf("s").length, 1, "s1 的旧挂载没卸完之前不得再挂");
    assert.equal(a2.mountsOf("s").length, 1, "s2 的旧挂载没卸完之前不得再挂");
    assert.equal(a1.mountsOf("s")[0]?.fiber.disposeCount, 1);
    assert.equal(a2.mountsOf("s")[0]?.fiber.disposeCount, 1);

    a1.release();
    await flush();
    assert.equal(a1.mountsOf("s").length, 2, "s1 卸完就先挂 s1");
    assert.equal(a2.mountsOf("s").length, 1, "s2 还没卸完，不挂");

    a2.release();
    await done;
    await h.runtime.settle();
    assert.equal(a2.mountsOf("s").length, 2);
    assert.equal(a1.maxLive.get("s"), 1);
    assert.equal(a2.maxLive.get("s"), 1);
  });
});

// ------------------------------------------------------------------ dispose

describe("runtime: dispose", () => {
  it("卸下全部全局与按会话的挂载，且幂等", async () => {
    const h = makeHarness([
      server({ serverName: "g", command: "node" }),
      server({ serverName: "s", command: "node", scope: "session" }),
    ]);
    h.runtime.start();
    await h.runtime.settle();
    const a1 = h.agentScope("s1");
    await h.runtime.settle();
    await h.runtime.dispose();
    assert.equal(h.root.mounts[0]?.fiber.disposeCount, 1);
    assert.equal(a1.mounts[0]?.fiber.disposeCount, 1);
    await h.runtime.dispose();
    assert.equal(h.root.mounts[0]?.fiber.disposeCount, 1);
  });

  it("dispose 后配置变化不再挂载", async () => {
    const h = makeHarness([server({ serverName: "a", command: "node" })]);
    h.runtime.start();
    await h.runtime.settle();
    await h.runtime.dispose();
    h.config.set([server({ serverName: "b", command: "node" })]);
    await h.runtime.settle();
    assert.equal(h.root.mounts.length, 1);
  });
});
