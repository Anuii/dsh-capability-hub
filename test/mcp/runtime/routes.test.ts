/**
 * mcp-runtime 模块入口（ADR-0010）：两条路由与参数校验。
 *
 * 路由是平台层真正接线的那一层：键名与状态码错了，整块功能在界面上就不可用。
 * 夹具全假：假作用域记录挂载与卸下，假配置源提供一台启用、一台停用的服务器。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createMcpRuntimeModule } from "../../../src/mcp/runtime/module.ts";
import type { EffectiveMcpConfig, EffectiveServer, McpConfigSource } from "../../../src/mcp/contract/config.ts";
import type { RegisteredTool } from "../../../src/mcp/contract/runtime.ts";
import type { HubContext, RouteRequest } from "../../../src/platform/contract/host.ts";

function makeServer(overrides: Partial<EffectiveServer> & { serverName: string }): EffectiveServer {
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

function makeContext(): HubContext {
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  return {
    homeDir: "C:\\fixture\\home",
    dshHome: "C:\\fixture\\home\\.dsh",
    hubHome: "C:\\fixture\\home\\.dsh\\storages\\dsh-capability-hub",
    profileName: "test",
    logger,
    customSkillDirs: [],
  };
}

function req(body: unknown): RouteRequest {
  return { query: {}, body, signal: new AbortController().signal };
}

interface FakeFiber {
  disposed: boolean;
  dispose(): Promise<void>;
  then(onFulfilled: (value: unknown) => unknown, onRejected: (error: unknown) => unknown): void;
}

interface Harness {
  module: ReturnType<typeof createMcpRuntimeModule>;
  mounts: { config: Record<string, unknown>; fiber: FakeFiber }[];
  setTools(tools: RegisteredTool[]): void;
}

function makeHarness(servers: EffectiveServer[], tools: RegisteredTool[] = []): Harness {
  const mounts: { config: Record<string, unknown>; fiber: FakeFiber }[] = [];
  let current = tools;
  const config: McpConfigSource = {
    get: (): EffectiveMcpConfig => ({ servers }),
    onChange: () => () => {},
  };
  const root = {
    plugin(_plugin: unknown, input: unknown): unknown {
      const fiber: FakeFiber = {
        disposed: false,
        async dispose(): Promise<void> {
          fiber.disposed = true;
        },
        then(onFulfilled) {
          onFulfilled(undefined);
        },
      };
      mounts.push({ config: input as Record<string, unknown>, fiber });
      return fiber;
    },
  };
  const module = createMcpRuntimeModule(makeContext(), {
    config,
    client: { Config: (input: Record<string, unknown>) => input },
    root,
    listTools: () => current,
  });
  return {
    module,
    mounts,
    setTools(next) {
      current = next;
    },
  };
}

const SERVERS = [
  makeServer({ serverName: "alpha", command: "node" }),
  makeServer({ serverName: "beta", command: "node", disabled: true }),
];

describe("mcp-runtime 模块：路由表", () => {
  it("只有 GET mcp/runtime 与 POST mcp/runtime/reconnect 两条路由，并暴露 runtime", () => {
    const h = makeHarness(SERVERS);
    assert.deepEqual(Object.keys(h.module.routes).sort(), ["GET mcp/runtime", "POST mcp/runtime/reconnect"]);
    assert.equal(typeof h.module.runtime.start, "function");
    assert.equal(typeof h.module.runtime.status, "function");
    assert.equal(typeof h.module.dispose, "function");
  });

  it("模块 dispose 卸下全部已挂载的服务器", async () => {
    const h = makeHarness(SERVERS);
    h.module.runtime.start();
    await h.module.runtime.settle();
    assert.equal(h.mounts.length, 1);
    await h.module.dispose?.();
    assert.equal(h.mounts[0]?.fiber.disposed, true);
  });
});

describe("mcp-runtime 模块：GET mcp/runtime", () => {
  it("返回每台服务器的状态与工具，停用如实反映", async () => {
    const h = makeHarness(SERVERS, [{ name: "mcp__alpha__ping", description: "ping 一下\n第二行" }]);
    h.module.runtime.start();
    await h.module.runtime.settle();
    const status = (await h.module.routes["GET mcp/runtime"]!(req(undefined))) as {
      servers: { name: string; scope: string; state: string; tools: RegisteredTool[]; sessions: number }[];
    };
    assert.deepEqual(
      status.servers.map((s) => [s.name, s.state]),
      [
        ["alpha", "connected"],
        ["beta", "disabled"],
      ],
    );
    assert.deepEqual(status.servers[0]?.tools, [{ name: "mcp__alpha__ping", description: "ping 一下" }]);
    assert.equal(status.servers[0]?.scope, "global");
    assert.equal(status.servers[0]?.sessions, 0);
  });
});

describe("mcp-runtime 模块：POST mcp/runtime/reconnect", () => {
  it("正常重连返回 { server }，并真的卸下再挂上", async () => {
    const h = makeHarness(SERVERS);
    h.module.runtime.start();
    await h.module.runtime.settle();
    const result = (await h.module.routes["POST mcp/runtime/reconnect"]!(req({ name: "alpha" }))) as {
      server: { name: string; state: string };
    };
    assert.equal(result.server.name, "alpha");
    assert.equal(result.server.state, "disconnected");
    assert.equal(h.mounts.length, 2);
    assert.equal(h.mounts[0]?.fiber.disposed, true);
    assert.equal(h.mounts[1]?.config.serverName, "alpha");
  });

  it("缺 name ⇒ 400；非对象请求体 ⇒ 400", async () => {
    const h = makeHarness(SERVERS);
    const reconnect = h.module.routes["POST mcp/runtime/reconnect"]!;
    await assert.rejects(
      reconnect(req({})),
      (error: { status?: number; code?: string }) => error.status === 400 && error.code === "BAD_REQUEST",
    );
    await assert.rejects(reconnect(req({ name: 7 })), (error: { status?: number }) => error.status === 400);
    // requireString 不 trim：纯空白是个合法的字符串参数，只是找不到这台服务器
    await assert.rejects(
      reconnect(req({ name: "  " })),
      (error: { status?: number; code?: string }) => error.status === 404 && error.code === "NOT_FOUND",
    );
    await assert.rejects(reconnect(req(42)), (error: { status?: number }) => error.status === 400);
    await assert.rejects(reconnect(req(undefined)), (error: { status?: number }) => error.status === 400);
  });

  it("未知服务器 ⇒ 404，已停用 ⇒ 409", async () => {
    const h = makeHarness(SERVERS);
    const reconnect = h.module.routes["POST mcp/runtime/reconnect"]!;
    await assert.rejects(
      reconnect(req({ name: "nope" })),
      (error: { status?: number; code?: string }) => error.status === 404 && error.code === "NOT_FOUND",
    );
    await assert.rejects(
      reconnect(req({ name: "beta" })),
      (error: { status?: number; code?: string }) => error.status === 409 && error.code === "CONFLICT",
    );
  });
});
