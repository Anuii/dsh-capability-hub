/**
 * E1：工厂签名、三条路由、以及模块给外壳的工具清单与提示词文字。
 *
 * 这里走的是**模块工厂**（createMcpRuntimeModule），而不是 runtime 本身 ——
 * 路由是平台层（T0）真正接线的那一层，契约错在这里就是整块功能不可用。
 * 假 SDK 只用来让 refresh 能真的跑通一次 listTools。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createMcpRuntimeModule } from "../../../src/mcp/runtime/module.ts";
import { FakeConfigSource, makeContext, makeServer, makeTempHome } from "./helpers.ts";
import { FakeMcpRegistry, createFakeSdk } from "./fakes/fake-sdk.ts";
import type { RouteRequest } from "../../../src/platform/contract/host.ts";

const SERVERS = [
  makeServer({ serverName: "alpha", command: "node", args: ["srv.js"] }),
  makeServer({ serverName: "beta", command: "node", args: ["srv.js"], disabled: true }),
];

function req(body: unknown): RouteRequest {
  return { query: {}, body, signal: new AbortController().signal };
}

/** 起一个「模块级」夹具：真 runtime + 假 SDK，数据只在临时目录。 */
async function makeModule(servers = SERVERS) {
  const home = await makeTempHome("routes");
  const registry = new FakeMcpRegistry();
  registry.register({ key: "node srv.js", tools: [{ name: "ping" }], instructions: "ALPHA 说明" });
  const config = new FakeConfigSource(servers);
  const module = createMcpRuntimeModule(makeContext(home.hubHome, home.dir), { config, sdk: createFakeSdk(registry) });
  await module.start();
  await module.runtime.waitForBackgroundWork();
  return {
    module,
    registry,
    home,
    dispose: async () => {
      await module.dispose?.();
      await home.cleanup();
    },
  };
}

test("工厂返回 runtime、start/dispose 与三条路由（键名即契约）", async () => {
  const h = await makeModule();
  try {
    assert.equal(typeof h.module.runtime.call, "function");
    assert.equal(typeof h.module.runtime.tools, "function");
    assert.equal(typeof h.module.start, "function");
    assert.equal(typeof h.module.dispose, "function");
    assert.deepEqual(Object.keys(h.module.routes).sort(), [
      "GET mcp/runtime",
      "POST mcp/runtime/disconnect",
      "POST mcp/runtime/refresh",
    ]);
  } finally {
    await h.dispose();
  }
});

test("GET mcp/runtime 返回 { servers, sessions } 形状", async () => {
  const h = await makeModule();
  try {
    const status = (await h.module.routes["GET mcp/runtime"]!(req(undefined))) as {
      servers: Array<{ name: string; disabled: boolean }>;
      sessions: unknown[];
    };
    assert.deepEqual(
      status.servers.map((s) => s.name),
      ["alpha", "beta"],
    );
    assert.equal(status.servers[1]!.disabled, true, "停用状态必须在运行态里如实反映");
    assert.ok(Array.isArray(status.sessions));
  } finally {
    await h.dispose();
  }
});

test("POST mcp/runtime/refresh：正常刷新返回 toolCount", async () => {
  const h = await makeModule();
  try {
    const result = (await h.module.routes["POST mcp/runtime/refresh"]!(req({ name: "alpha" }))) as {
      toolCount: number;
    };
    assert.equal(result.toolCount, 1);
    assert.ok(h.registry.spawned.length >= 1, "刷新必须真的连一次");
  } finally {
    await h.dispose();
  }
});

test("POST mcp/runtime/refresh：缺 name ⇒ 400，未知服务器 ⇒ 404，已停用 ⇒ 409", async () => {
  const h = await makeModule();
  try {
    const refresh = h.module.routes["POST mcp/runtime/refresh"]!;
    await assert.rejects(
      refresh(req({})),
      (err: { status?: number; code?: string }) => err.status === 400 && err.code === "BAD_REQUEST",
    );
    await assert.rejects(refresh(req({ name: "  " })), (err: { status?: number }) => err.status === 400);
    await assert.rejects(
      refresh(req({ name: "nope" })),
      (err: { status?: number; code?: string }) => err.status === 404 && err.code === "NOT_FOUND",
    );
    await assert.rejects(
      refresh(req(42)),
      (err: { status?: number }) => err.status === 400,
      "非对象请求体要报 400 而不是崩",
    );
    await assert.rejects(
      refresh(req({ name: "beta" })),
      (err: { status?: number; code?: string }) => err.status === 409 && err.code === "CONFLICT",
      "已停用的服务器不刷新",
    );
  } finally {
    await h.dispose();
  }
});

test("POST mcp/runtime/disconnect：按会话断开、未知服务器 404、sessionId 类型错 400", async () => {
  const h = await makeModule();
  try {
    await h.module.runtime.call("mcp__alpha__ping", {}, { sessionId: "main", signal: new AbortController().signal });
    const disconnect = h.module.routes["POST mcp/runtime/disconnect"]!;
    const all = (await disconnect(req({ name: "alpha" }))) as { closed: number };
    assert.equal(all.closed, 1, "不带 sessionId = 断开所有会话的该服务器");
    const again = (await disconnect(req({ name: "alpha", sessionId: "main" }))) as { closed: number };
    assert.equal(again.closed, 0, "已经断开了就不该再报断开数");
    await assert.rejects(disconnect(req({ name: "nope" })), (err: { status?: number }) => err.status === 404);
    await assert.rejects(
      disconnect(req({ name: "alpha", sessionId: 7 })),
      (err: { status?: number }) => err.status === 400,
    );
  } finally {
    await h.dispose();
  }
});

test("模块给外壳的工具清单：只来自已启用服务器；刷新缓存内容不变时不通知", async () => {
  const h = await makeModule();
  try {
    const specs = h.module.runtime.tools();
    assert.deepEqual(
      specs.map((spec) => spec.name),
      ["mcp__alpha__ping"],
      "停用的 beta 不注册",
    );
    assert.deepEqual(specs[0]!.parameters, { type: "object" });
    let changes = 0;
    const off = h.module.runtime.onToolsChange(() => {
      changes += 1;
    });
    await h.module.runtime.refresh("alpha");
    assert.equal(changes, 0, "工具清单没变就不该通知（注册集合稳定）");
    off();
    const prompt = h.module.runtime.promptText();
    assert.match(prompt, /- alpha/);
    assert.match(prompt, /ALPHA 说明/, "服务器自带的用法说明进提示词");
    assert.ok(!prompt.includes("beta"));
  } finally {
    await h.dispose();
  }
});

test("模块 dispose 会关掉会话实例（不留进程）", async () => {
  const home = await makeTempHome("routes-dispose");
  const registry = new FakeMcpRegistry();
  registry.register({ key: "node srv.js", tools: [{ name: "ping" }] });
  const module = createMcpRuntimeModule(makeContext(home.hubHome, home.dir), {
    config: new FakeConfigSource(SERVERS),
    sdk: createFakeSdk(registry),
  });
  try {
    await module.start();
    await module.runtime.waitForBackgroundWork();
    await module.runtime.call("mcp__alpha__ping", {}, { sessionId: "main", signal: new AbortController().signal });
    assert.equal(registry.liveProcessCount(), 1);
    await module.dispose?.();
    assert.equal(registry.liveProcessCount(), 0, "dispose 必须回收全部实例");
  } finally {
    await rm(home.dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
