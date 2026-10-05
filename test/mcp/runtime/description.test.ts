/** 描述字节稳定（D-D1 的核心不变量）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DESCRIPTION_NO_SERVERS,
  DESCRIPTION_PREFIX,
  describeEnabledServers,
} from "../../../src/mcp/runtime/constants.ts";
import { makeHarness, makeServer } from "./helpers.ts";

test("没有服务器时用固定文案", async () => {
  const h = await makeHarness({ autoStart: false });
  try {
    assert.equal(h.runtime.toolDescription(), DESCRIPTION_PREFIX + "\n\n" + DESCRIPTION_NO_SERVERS);
  } finally {
    await h.dispose();
  }
});

test("描述 = 恒定前缀 + 已启用服务器清单（配置顺序），且不含工具数量", async () => {
  const servers = [
    makeServer({ serverName: "zeta", command: "node" }),
    makeServer({ serverName: "alpha", command: "node" }),
    makeServer({ serverName: "hidden", command: "node", disabled: true }),
  ];
  const h = await makeHarness({ servers, autoStart: false });
  try {
    const text = h.runtime.toolDescription();
    assert.ok(text.startsWith(DESCRIPTION_PREFIX));
    assert.ok(text.endsWith("已启用的 MCP 服务器（按配置顺序）：\n- zeta\n- alpha"), "按配置顺序列举，停用的不出现");
    assert.ok(!text.includes("hidden"));
    assert.ok(!/\d+\s*个工具/.test(text), "描述里不能出现工具数量");
  } finally {
    await h.dispose();
  }
});

test("只改工具缓存 / idleTimeout / searchKeywords / include-exclude 都不改变描述字节", async () => {
  const base = makeServer({ serverName: "alpha", command: "node", args: ["server.js"] });
  const h = await makeHarness({ servers: [base], autoStart: false });
  try {
    const before = Buffer.from(h.runtime.toolDescription(), "utf8");
    h.config.setServers([makeServer({ ...base, idleTimeoutMin: 0 })]);
    h.config.setServers([makeServer({ ...base, idleTimeoutMin: 0, lifecycle: "keep-alive" })]);
    h.config.setServers([
      makeServer({
        ...base,
        idleTimeoutMin: 0,
        lifecycle: "keep-alive",
        searchKeywords: { x: ["y"] },
        includeTools: ["a"],
        excludeTools: ["b"],
        debug: true,
        toolCallTimeoutMs: 1,
      }),
    ]);
    h.config.setSettings({ outputGuard: { enabled: false, maxBytes: 1, maxLines: 1 }, failureBackoffMs: 1 });
    const after = Buffer.from(h.runtime.toolDescription(), "utf8");
    assert.equal(Buffer.compare(before, after), 0, "这些字段都不在描述里");
  } finally {
    await h.dispose();
  }
});

test("onDescriptionChange 只在文本真的变了时触发", async () => {
  const h = await makeHarness({ servers: [makeServer({ serverName: "alpha", command: "node" })], autoStart: false });
  try {
    let count = 0;
    const off = h.runtime.onDescriptionChange(() => {
      count += 1;
    });
    h.config.setSettings({ idleTimeoutMin: 20 });
    assert.equal(count, 0, "改 idleTimeout 不触发");
    h.config.setServers([
      makeServer({ serverName: "alpha", command: "node" }),
      makeServer({ serverName: "beta", command: "node" }),
    ]);
    assert.equal(count, 1, "新增服务器触发一次");
    const text = h.runtime.toolDescription();
    h.config.setServers([
      makeServer({ serverName: "alpha", command: "node" }),
      makeServer({ serverName: "beta", command: "node" }),
    ]);
    assert.equal(count, 1, "内容相同的变更不再触发");
    assert.equal(h.runtime.toolDescription(), text);
    off();
    h.config.setServers([makeServer({ serverName: "gamma", command: "node" })]);
    assert.equal(count, 1, "取消订阅后不再触发");
  } finally {
    await h.dispose();
  }
});

test("停用/启用服务器会改变描述（因为可见名单变了）", async () => {
  const server = makeServer({ serverName: "alpha", command: "node" });
  const h = await makeHarness({ servers: [server], autoStart: false });
  try {
    assert.ok(h.runtime.toolDescription().includes("alpha"));
    h.config.setServers([{ ...server, disabled: true }]);
    assert.ok(!h.runtime.toolDescription().includes("alpha"));
    h.config.setServers([server]);
    assert.ok(h.runtime.toolDescription().includes("alpha"));
  } finally {
    await h.dispose();
  }
});

test("重复调用返回逐字节相同的字符串", async () => {
  const h = await makeHarness({ servers: [makeServer({ serverName: "alpha", command: "node" })], autoStart: false });
  try {
    const a = h.runtime.toolDescription();
    const b = h.runtime.toolDescription();
    assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0);
  } finally {
    await h.dispose();
  }
});

/* ---------------- 服务器描述（meta.description） ---------------- */

test("每个服务器接上 meta.description：模型从工具接口就知道它能干什么", async () => {
  const servers = [
    makeServer({
      serverName: "MaaMCP",
      command: "node",
      meta: {
        description: "MaaFramework 自动化：ADB 安卓设备 / Windows 窗口的 OCR、截图、点击、滑动、输入与 Pipeline",
        tags: ["automation", "maa"],
        homepage: "https://github.com/MAA-AI/MaaMCP",
      },
    }),
    makeServer({ serverName: "plain", command: "node" }),
    makeServer({ serverName: "codegraph", command: "node", meta: { description: "CodeGraph 本地代码知识图谱" } }),
  ];
  const h = await makeHarness({ servers, autoStart: false });
  try {
    assert.equal(
      h.runtime.toolDescription(),
      DESCRIPTION_PREFIX +
        "\n\n已启用的 MCP 服务器（按配置顺序）：\n" +
        "- MaaMCP：MaaFramework 自动化：ADB 安卓设备 / Windows 窗口的 OCR、截图、点击、滑动、输入与 Pipeline\n" +
        "- plain\n" +
        "- codegraph：CodeGraph 本地代码知识图谱",
    );
    assert.ok(!h.runtime.toolDescription().includes("automation"), "标签不进描述");
    assert.ok(!h.runtime.toolDescription().includes("https://"), "主页不进描述");
  } finally {
    await h.dispose();
  }
});

test("服务器描述只取第一行、最多 160 字；空白或缺失时退回只写名字", () => {
  const long = "长".repeat(200);
  assert.equal(
    describeEnabledServers([{ serverName: "a", meta: { description: long } }]).split("\n")[1],
    "- a：" + "长".repeat(160),
  );
  assert.equal(
    describeEnabledServers([{ serverName: "a", meta: { description: "  第一句。\r\n\r\n详细说明……" } }]).split("\n")[1],
    "- a：第一句。",
  );
  for (const meta of [undefined, {}, { description: "" }, { description: "   \n第二行" }]) {
    assert.equal(
      describeEnabledServers([{ serverName: "a", ...(meta === undefined ? {} : { meta }) }]).split("\n")[1],
      "- a",
    );
  }
  const emoji = "😀".repeat(100); // 每个 2 个码元，160 正好落在代理对边界
  const line = describeEnabledServers([{ serverName: "a", meta: { description: "x" + emoji } }]).split("\n")[1]!;
  assert.equal(line, "- a：x" + "😀".repeat(79), "不吐半个代理对");
  assert.equal(describeEnabledServers([]), DESCRIPTION_NO_SERVERS);
});

test("改 meta.description 会更新描述并触发一次通知；改标签 / 主页不改变描述字节", async () => {
  const base = makeServer({ serverName: "alpha", command: "node", meta: { description: "旧说明", tags: ["a"] } });
  const h = await makeHarness({ servers: [base], autoStart: false });
  try {
    let count = 0;
    const off = h.runtime.onDescriptionChange(() => {
      count += 1;
    });
    const before = h.runtime.toolDescription();
    h.config.setServers([
      makeServer({ ...base, meta: { description: "旧说明", tags: ["b", "c"], homepage: "https://x" } }),
    ]);
    assert.equal(h.runtime.toolDescription(), before, "标签与主页不在描述里");
    assert.equal(count, 0);
    h.config.setServers([makeServer({ ...base, meta: { description: "新说明" } })]);
    assert.ok(h.runtime.toolDescription().endsWith("- alpha：新说明"));
    assert.equal(count, 1, "描述变了就通知一次（外壳据此重新注册 mcp 工具）");
    off();
  } finally {
    await h.dispose();
  }
});
