/**
 * E3：search / describe / status 只读缓存、**绝不起进程**。
 * 另外覆盖 include/exclude 过滤、冷缓存友好提示、instructions 只读。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { callCtx, makeHarness, makeServer } from "./helpers.ts";

const SERVERS = [
  makeServer({ serverName: "alpha", command: "node", args: ["srv.js"] }),
  makeServer({ serverName: "beta", command: "node", args: ["srv.js"] }),
];

/** 预置一份缓存（不通过连接，直接写盘 + 让运行时重新加载）。 */
async function seed(h: Awaited<ReturnType<typeof makeHarness>>): Promise<void> {
  const { MetadataCache, computeConfigHash } = await import("../../../src/mcp/runtime/atoms/metadata-cache.ts");
  const cache = new MetadataCache(h.home.hubHome, h.clock, () => undefined);
  const entries: Record<string, unknown> = {};
  for (const server of SERVERS) {
    entries[server.serverName] = {
      configHash: computeConfigHash(server),
      updatedAt: h.clock.now(),
      instructions: server.serverName === "alpha" ? "ALPHA 用法说明：先 ping。" : undefined,
      tools:
        server.serverName === "alpha"
          ? [
              {
                name: "ping",
                description: "Ping alpha.",
                inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
              },
              {
                name: "read_file",
                description: "Read a file.",
                inputSchema: { type: "object", properties: { path: { type: "string" } } },
              },
            ]
          : [{ name: "ping", description: "Ping beta.", inputSchema: { type: "object", properties: {} } }],
    };
  }
  await cache.write(entries as never);
  await h.runtime.status(); // 触发缓存加载
}

test("search 只读缓存：不起进程、不连接", async () => {
  const h = await makeHarness({ servers: SERVERS, behaviors: [{ key: "node srv.js", tools: [] }] });
  try {
    await seed(h);
    const spawnsBefore = h.registry.spawned.length;
    await h.runtime.waitForBackgroundWork();
    const afterStart = h.registry.spawned.length;
    const text = await h.runtime.execute({ search: "ping" }, callCtx("main"));
    assert.match(text, /alpha__ping/);
    assert.match(text, /beta__ping/);
    assert.equal(h.registry.spawned.length, afterStart, "search 不得产生任何进程");
    assert.equal(h.registry.connectCalls, afterStart === 0 ? 0 : h.registry.connectCalls);
    void spawnsBefore;
  } finally {
    await h.dispose();
  }
});

test("describe 只读缓存：给出 schema 与调用示例，不起进程", async () => {
  const h = await makeHarness({ servers: SERVERS, behaviors: [{ key: "node srv.js", tools: [] }] });
  try {
    await seed(h);
    await h.runtime.waitForBackgroundWork();
    const before = h.registry.spawned.length;
    const text = await h.runtime.execute({ describe: "alpha__ping" }, callCtx("main"));
    assert.match(text, /工具：alpha__ping/);
    assert.match(text, /parameters: text: string/);
    assert.match(text, /"type": "object"/);
    assert.match(text, /mcp\(\{ tool: "ping"/);
    assert.equal(h.registry.spawned.length, before, "describe 不得产生任何进程");
  } finally {
    await h.dispose();
  }
});

test("status 只读缓存：汇总服务器、缓存、实例", async () => {
  const h = await makeHarness({ servers: SERVERS, behaviors: [{ key: "node srv.js", tools: [] }] });
  try {
    await seed(h);
    await h.runtime.waitForBackgroundWork();
    const before = h.registry.spawned.length;
    const text = await h.runtime.execute({}, callCtx("main"));
    assert.match(text, /MCP 运行状态/);
    assert.match(text, /alpha：2 个工具/);
    assert.match(text, /beta：1 个工具/);
    assert.equal(h.registry.spawned.length, before, "status 不得产生任何进程");
  } finally {
    await h.dispose();
  }
});

test("instructions 只读缓存：没有缓存时提示先 connect，不起进程", async () => {
  // autoStart:false ⇒ 没有启动探测，缓存确实是冷的（否则 D-C6 的启动探测会先把缓存写好，
  // 这条用例就测不到「冷缓存」这条路了 —— 见上面 search 的冷缓存用例，同样处理）。
  const h = await makeHarness({
    servers: [SERVERS[0]],
    behaviors: [{ key: "node srv.js", tools: [] }],
    autoStart: false,
  });
  try {
    const before = h.registry.spawned.length;
    const cold = await h.runtime.execute({ instructions: "alpha" }, callCtx("main"));
    assert.match(cold, /还没有缓存/);
    assert.match(cold, /connect/);
    assert.equal(h.registry.spawned.length, before);
    await seed(h);
    const warm = await h.runtime.execute({ instructions: "alpha" }, callCtx("main"));
    assert.match(warm, /ALPHA 用法说明/);
    assert.equal(h.registry.spawned.length, before, "instructions 不得产生任何进程");
  } finally {
    await h.dispose();
  }
});

test("冷缓存时 search 给出对模型友好的、可执行的提示", async () => {
  // autoStart:false ⇒ 没有启动探测，缓存确实是冷的。
  const h = await makeHarness({
    servers: [SERVERS[0]],
    behaviors: [{ key: "node srv.js", tools: [] }],
    autoStart: false,
  });
  try {
    const text = await h.runtime.execute({ search: "ping" }, callCtx("main"));
    assert.match(text, /还没有任何 MCP 工具元数据被缓存/);
    assert.match(text, /mcp\(\{ connect: "alpha" \}\)/);
  } finally {
    await h.dispose();
  }
});

test("没有服务器时 search/status 用固定文案", async () => {
  const h = await makeHarness({ autoStart: false });
  try {
    const search = await h.runtime.execute({ search: "x" }, callCtx("main"));
    assert.match(search, /没有可搜索的工具/);
    const status = await h.runtime.execute({}, callCtx("main"));
    assert.match(status, /当前没有已启用的 MCP 服务器/);
  } finally {
    await h.dispose();
  }
});

test("includeTools / excludeTools 只影响读侧，不改缓存", async () => {
  const filtered = makeServer({ serverName: "alpha", command: "node", args: ["srv.js"], includeTools: ["ping"] });
  const h = await makeHarness({ servers: [filtered], behaviors: [{ key: "node srv.js", tools: [] }] });
  try {
    await seed(h);
    const text = await h.runtime.execute({ search: "ping" }, callCtx("main"));
    assert.match(text, /alpha__ping/);
    const hidden = await h.runtime.execute({ search: "read_file" }, callCtx("main"));
    assert.match(hidden, /没有匹配/);

    // 放开过滤后，被藏起来的工具必须回来（证明缓存里存的是完整清单）。
    h.config.setServers([makeServer({ ...filtered, includeTools: undefined })]);
    const back = await h.runtime.execute({ search: "read_file" }, callCtx("main"));
    assert.match(back, /alpha__read_file/, "过滤必须在读侧做，否则被 exclude 过的工具永远回不来");
  } finally {
    await h.dispose();
  }
});

test("excludeTools 后赢（同时命中 include 与 exclude 时被挡下）", async () => {
  const server = makeServer({
    serverName: "alpha",
    command: "node",
    args: ["srv.js"],
    includeTools: ["*"],
    excludeTools: ["read_*"],
  });
  const h = await makeHarness({ servers: [server], behaviors: [{ key: "node srv.js", tools: [] }] });
  try {
    await seed(h);
    const text = await h.runtime.execute({ search: "alpha" }, callCtx("main"));
    assert.match(text, /alpha__ping/);
    assert.ok(!text.includes("alpha__read_file"));
  } finally {
    await h.dispose();
  }
});

test("search 分页：limit / offset / 上限 40", async () => {
  const h = await makeHarness({ servers: [SERVERS[0]], behaviors: [{ key: "node srv.js", tools: [] }] });
  try {
    await seed(h);
    const all = await h.runtime.execute({ search: "a" }, callCtx("main"));
    assert.match(all, /找到 2 个工具/);
    const first = await h.runtime.execute({ search: "a", limit: 1 }, callCtx("main"));
    assert.match(first, /显示第 1–1 个/);
    assert.match(first, /offset: 1/);
    const second = await h.runtime.execute({ search: "a", limit: 1, offset: 1 }, callCtx("main"));
    assert.match(second, /显示第 2–2 个/);
  } finally {
    await h.dispose();
  }
});

test("search 正则模式与非法正则的报错文案", async () => {
  const h = await makeHarness({ servers: [SERVERS[0]], behaviors: [{ key: "node srv.js", tools: [] }] });
  try {
    await seed(h);
    const ok = await h.runtime.execute({ search: "read_", regex: true }, callCtx("main"));
    assert.match(ok, /正则搜索/);
    assert.match(ok, /alpha__read_file/);
    const bad = await h.runtime.execute({ search: "([", regex: true }, callCtx("main"));
    assert.match(bad, /无法执行这个正则搜索/);
  } finally {
    await h.dispose();
  }
});

test("describe 的歧义 / 未知 / 停用三种提示", async () => {
  const servers = [...SERVERS, makeServer({ serverName: "gamma", command: "node", args: ["srv.js"], disabled: true })];
  const h = await makeHarness({ servers, behaviors: [{ key: "node srv.js", tools: [] }] });
  try {
    await seed(h);
    const ambiguous = await h.runtime.execute({ describe: "ping" }, callCtx("main"));
    assert.match(ambiguous, /同时存在于多个服务器上/);
    const disambiguated = await h.runtime.execute({ describe: "ping", server: "beta" }, callCtx("main"));
    assert.match(disambiguated, /工具：beta__ping/);
    const unknown = await h.runtime.execute({ describe: "nope_nothing" }, callCtx("main"));
    assert.match(unknown, /没有名为 "nope_nothing" 的工具/);
    const asServer = await h.runtime.execute({ describe: "alpha" }, callCtx("main"));
    assert.match(asServer, /那是服务器名/);
  } finally {
    await h.dispose();
  }
});

test("未知动作参数被忽略（无 action = status）", async () => {
  const h = await makeHarness({ servers: [SERVERS[0]], behaviors: [{ key: "node srv.js", tools: [] }] });
  try {
    const text = await h.runtime.execute({ nonsense: 1 }, callCtx("main"));
    assert.match(text, /MCP 运行状态/);
  } finally {
    await h.dispose();
  }
});
