/**
 * mcp-runtime 模块入口（ADR-0010）：0.9.0 起**没有任何 HTTP 路由**，只把运行时交给外壳。
 *
 * 页面不再显示运行状态、也没有「重新连接」，所以 GET mcp/runtime 与 POST mcp/runtime/reconnect
 * 都删了；挂载照常进行，状态只由外壳取 runtime.status() 填进 GET health 的 mcpServers 与 boot.json。
 * 夹具全假：假作用域记录挂载与卸下，假配置源提供一台启用、一台停用的服务器。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createMcpRuntimeModule } from "../../../src/mcp/runtime/module.ts";
import type { EffectiveMcpConfig, EffectiveServer, McpConfigSource } from "../../../src/mcp/contract/config.ts";
import type { RegisteredTool } from "../../../src/mcp/contract/runtime.ts";
import type { HubContext } from "../../../src/platform/contract/host.ts";

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

describe("mcp-runtime 模块：没有 HTTP 路由", () => {
  it("路由表为空，并暴露 runtime 与 dispose", () => {
    const h = makeHarness(SERVERS);
    assert.deepEqual(Object.keys(h.module.routes), []);
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

describe("mcp-runtime 模块：status()（health 的数据源）", () => {
  it("返回每台服务器的挂载状态与本服务器的工具，停用如实反映", async () => {
    const h = makeHarness(SERVERS, [{ name: "mcp__alpha__ping", description: "ping 一下\n第二行" }]);
    h.module.runtime.start();
    await h.module.runtime.settle();
    const status = h.module.runtime.status();
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
