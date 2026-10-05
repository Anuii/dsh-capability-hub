/**
 * E1：工厂签名、三条路由（PLAN §3.6 / §3.7）、以及 mcp 工具的 schema/描述恒定。
 *
 * 这里走的是**模块工厂**（createMcpRuntimeModule），而不是 runtime 本身 ——
 * 路由是平台层（T0）真正接线的那一层，契约错在这里就是整块功能不可用。
 * 假 SDK 只用来让 refresh 能真的跑通一次 listTools。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createMcpRuntimeModule } from "../../../src/mcp/runtime/module.ts";
import { PARAMETER_NAMES } from "../../../src/mcp/runtime/tool-schema.ts";
import { DESCRIPTION_PREFIX, describeEnabledServers } from "../../../src/mcp/runtime/constants.ts";
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
    assert.equal(typeof h.module.runtime.execute, "function");
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

test("POST mcp/runtime/refresh：缺 name ⇒ 400，未知服务器 ⇒ 404", async () => {
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
  } finally {
    await h.dispose();
  }
});

test("POST mcp/runtime/disconnect：按会话断开、未知服务器 404、sessionId 类型错 400", async () => {
  const h = await makeModule();
  try {
    await h.module.runtime.execute({ connect: "alpha" }, { sessionId: "main", signal: new AbortController().signal });
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

interface ToolSchema {
  type?: string;
  properties?: Record<string, { type?: string; enum?: unknown; description?: string }>;
  additionalProperties?: unknown;
}

test("toolParameters 恒定：恒定的原始 JSON Schema（顶层 object），只有固定参数名、无枚举、无服务器名，且返回深拷贝", async () => {
  const h = await makeModule();
  try {
    const first = h.module.runtime.toolParameters() as ToolSchema;
    // PLAN §3.6 变更：交给 ctx.tools.register 的就是这份原始 JSON Schema。
    assert.equal(first.type, "object", "顶层必须是 type: object");
    assert.equal(first.additionalProperties, false, "不接受未声明的参数");
    const props = first.properties ?? {};
    assert.deepEqual(Object.keys(props).sort(), [...PARAMETER_NAMES].sort());
    for (const [name, spec] of Object.entries(props)) {
      assert.equal(spec.enum, undefined, name + " 不得有枚举");
      assert.ok(!JSON.stringify(spec).includes("alpha"), "参数 schema 里绝不能出现服务器名（D-D1：KV-cache 前缀稳定）");
    }
    // 类型照写：string/boolean/integer；任意值（args）只写 description、不带 type。
    assert.equal(props.search?.type, "string");
    assert.equal(props.regex?.type, "boolean");
    assert.equal(props.limit?.type, "integer");
    assert.equal(props.args?.type, undefined, "args 表示任意值：不带 type（不约束）");
    assert.ok(
      typeof props.args?.description === "string" && props.args.description.length > 0,
      "args 必须有 description",
    );
    // 深拷贝：调用方改了返回值，下一次拿到的必须还是原样。
    props.search!.type = "number";
    const second = h.module.runtime.toolParameters() as ToolSchema;
    assert.equal(second.properties?.search?.type, "string");
  } finally {
    await h.dispose();
  }
});

test("toolParameters 逐字节恒定：增删服务器与刷新缓存都不改动 schema", async () => {
  const h = await makeModule();
  try {
    const before = JSON.stringify(h.module.runtime.toolParameters());
    await h.module.runtime.refresh("alpha");
    assert.equal(JSON.stringify(h.module.runtime.toolParameters()), before, "刷新工具缓存后 schema 必须逐字节不变");
    assert.ok(!before.includes("alpha"), "schema 里绝不能出现服务器名");
  } finally {
    await h.dispose();
  }
});

test("toolDescription 只随「已启用服务器名」变化，绝不写工具数量", async () => {
  const h = await makeModule();
  try {
    // 逐字节等于「恒定前缀 + 已启用服务器名」：这是 D-D1 要的形式，也顺带证明描述里没有任何数字统计。
    const expected = DESCRIPTION_PREFIX + "\n\n" + describeEnabledServers(["alpha"]);
    assert.equal(h.module.runtime.toolDescription(), expected);
    assert.ok(!/beta/.test(h.module.runtime.toolDescription()), "停用的服务器不进描述");

    const before = h.module.runtime.toolDescription();
    let changes = 0;
    const off = h.module.runtime.onDescriptionChange(() => {
      changes += 1;
    });
    await h.module.runtime.refresh("alpha");
    assert.equal(h.module.runtime.toolDescription(), before, "刷新工具缓存不该改动描述一个字节");
    assert.equal(changes, 0, "描述没变就不该触发 onDescriptionChange");
    off();
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
    await module.runtime.execute({ connect: "alpha" }, { sessionId: "main", signal: new AbortController().signal });
    assert.equal(registry.liveProcessCount(), 1);
    await module.dispose?.();
    assert.equal(registry.liveProcessCount(), 0, "dispose 必须回收全部实例");
  } finally {
    await rm(home.dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
