/**
 * 直接注册给模型的 MCP 工具清单（D-D1）与系统提示词里的服务器说明。
 * 清单稳定是硬要求：内容不变就逐字节相同、不通知——注册集合一变，提示词前缀缓存就失效。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { publicToolName } from "../../../src/mcp/runtime/atoms/tool-name.ts";
import { callCtx, makeHarness, makeServer } from "./helpers.ts";

const A = makeServer({ serverName: "a", command: "node", args: ["a.js"] });
const B = makeServer({ serverName: "b", command: "node", args: ["b.js"] });
const BEHAVIORS = [
  {
    key: "node a.js",
    instructions: "先调用 zeta 再调用 alpha。",
    tools: [
      { name: "zeta", description: "最后一个" },
      {
        name: "alpha",
        description: "第一个",
        inputSchema: {
          type: "object",
          properties: { n: { anyOf: [{ type: "integer" }, { type: "null" }], default: null } },
        },
      },
    ],
  },
  { key: "node b.js", tools: [{ name: "only" }] },
];

test("没有服务器：不注册任何工具，提示词段落为空", async () => {
  const h = await makeHarness();
  try {
    assert.deepEqual(h.runtime.tools(), []);
    assert.equal(h.runtime.promptText(), "");
  } finally {
    await h.dispose();
  }
});

test("工具来自已启用服务器的缓存：服务器按配置顺序、工具按名字；名字 mcp__<服务器>__<工具>；schema 已转换", async () => {
  const h = await makeHarness({ servers: [B, A], behaviors: BEHAVIORS });
  try {
    const specs = h.runtime.tools();
    assert.deepEqual(
      specs.map((spec) => spec.name),
      ["mcp__b__only", "mcp__a__alpha", "mcp__a__zeta"],
    );
    assert.deepEqual(specs[1], {
      name: "mcp__a__alpha",
      server: "a",
      tool: "alpha",
      description: "第一个",
      parameters: {
        type: "object",
        properties: { n: { default: null, oneOf: [{ type: "integer" }, { type: "null" }] } },
      },
    });
    assert.match(specs[0]!.description, /MCP 服务器「b」的工具 only/, "服务器没写描述时说明它属于哪个服务器");
    assert.equal(JSON.stringify(h.runtime.tools()), JSON.stringify(specs), "重复读取逐字节相同");
  } finally {
    await h.dispose();
  }
});

test("includeTools / excludeTools 过滤；pattern 可以写原名、<服务器>__<原名> 或模型看到的名字", async () => {
  const h = await makeHarness({ servers: [{ ...A, excludeTools: ["mcp__a__zeta"] }], behaviors: BEHAVIORS });
  try {
    assert.deepEqual(
      h.runtime.tools().map((spec) => spec.name),
      ["mcp__a__alpha"],
    );
    h.config.setServers([{ ...A, includeTools: ["a__zeta"] }]);
    assert.deepEqual(
      h.runtime.tools().map((spec) => spec.name),
      ["mcp__a__zeta"],
    );
  } finally {
    await h.dispose();
  }
});

test("变化通知：只改生命周期 / 超时 / 标签不通知；停用、启用、新服务器探测到清单才通知", async () => {
  const h = await makeHarness({ servers: [A], behaviors: BEHAVIORS });
  try {
    let count = 0;
    const off = h.runtime.onToolsChange(() => {
      count += 1;
    });
    h.config.setServers([
      { ...A, lifecycle: "keep-alive", idleTimeoutMin: 0, toolCallTimeoutMs: 1, meta: { tags: ["x"] } },
    ]);
    h.config.setSettings({ idleTimeoutMin: 3, failureBackoffMs: 1 });
    await h.runtime.refresh("a");
    assert.equal(count, 0, "清单没变就不通知");
    h.config.setServers([{ ...A, disabled: true }]);
    assert.equal(count, 1);
    assert.deepEqual(h.runtime.tools(), []);
    h.config.setServers([A, B]);
    assert.equal(count, 2, "重新启用 a：缓存还在，立刻回来");
    await h.runtime.waitForBackgroundWork();
    assert.equal(count, 3, "新服务器 b 后台探测到清单后再通知一次");
    assert.deepEqual(
      h.runtime.tools().map((spec) => spec.name),
      ["mcp__a__alpha", "mcp__a__zeta", "mcp__b__only"],
    );
    off();
  } finally {
    await h.dispose();
  }
});

test("提示词段落：列出有工具的服务器与 meta.description 摘要，附上服务器自带的用法说明", async () => {
  const described = { ...A, meta: { description: "第一行说明\n\n第二行不要" } };
  const h = await makeHarness({
    servers: [described, makeServer({ serverName: "ghost", command: "node", args: ["none.js"] })],
    behaviors: BEHAVIORS,
  });
  try {
    const text = h.runtime.promptText();
    assert.match(text, /mcp__<服务器>__<工具>/);
    assert.match(text, /^- a：第一行说明$/m);
    assert.ok(!text.includes("第二行不要"));
    assert.match(text, /### a 的用法说明（服务器自带）\n先调用 zeta 再调用 alpha。/);
    assert.ok(!text.includes("ghost"), "没有工具的服务器不列");
  } finally {
    await h.dispose();
  }
});

test("调用用 MCP 服务器上的原名，参数原样转给服务器", async () => {
  const h = await makeHarness({ servers: [A], behaviors: BEHAVIORS });
  try {
    assert.equal(await h.runtime.call("mcp__a__alpha", { n: 3 }, callCtx("main")), "fake:alpha");
    const last = h.registry.callCalls.at(-1)!;
    assert.equal(last.name, "alpha");
    assert.deepEqual(last.args, { n: 3 });
  } finally {
    await h.dispose();
  }
});

test("模型看到的名字与 DSH 官方 MCP 客户端同一算法：不合规字符替换并加哈希，最长 64 个字符", () => {
  assert.equal(publicToolName("codegraph", "codegraph_explore"), "mcp__codegraph__codegraph_explore");
  const dotted = publicToolName("my.server", "get/thing");
  assert.match(dotted, /^mcp__my_server__get_thing_[0-9a-f]{12}$/);
  assert.notEqual(publicToolName("a.b", "c"), publicToolName("a_b", "c"), "替换后同形的两个工具不撞名");
  const long = publicToolName("server", "x".repeat(100));
  assert.equal(long.length, 64);
  assert.match(long, /_[0-9a-f]{12}$/);
});
