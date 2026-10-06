/**
 * view-model.ts 的纯逻辑单测：一行服务器的摘要、状态点、副标题、缓存，筛选与计数，排序，时间与时长。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compactSummaryText, isPathLike, shortPart } from "../../../src/mcp/client/view-model.ts";
import {
  activeInstanceCount,
  cacheLineText,
  cachedToolNames,
  cooldownRemainingMs,
  cooldownText,
  formatClock,
  formatDuration,
  matchesFilter,
  matchesQuery,
  rowSubtitleText,
  runtimeIndex,
  formatTimestamp,
  lifecycleLabel,
  reorderNames,
  serverFilterCounts,
  serverStatusTone,
  serverSummaryText,
  statusTitle,
  viewSummaryText,
  visibleServers,
} from "../../../src/mcp/client/view-model.ts";
import { makeServerView } from "./fixtures.ts";

/* ---------------- UI-B：列表筛选 / 状态点 / 副标题 ---------------- */

const NOW = 1_760_000_000_000;

/* ---------------- 排序 ---------------- */

test("reorderNames（拖动排序）", () => {
  const names = ["a", "b", "c"];
  assert.deepEqual(reorderNames(names, 0, 2), ["b", "c", "a"]);
  assert.deepEqual(reorderNames(names, 2, 0), ["c", "a", "b"]);
  assert.deepEqual(names, ["a", "b", "c"], "原数组不能被改动");
});

/* ---------------- 展示 ---------------- */

test("serverSummaryText 与 viewSummaryText", () => {
  assert.equal(serverSummaryText({ transport: "stdio", command: "node", args: ["-y", "pkg"] }), "node -y pkg");
  assert.equal(serverSummaryText({ transport: "stdio" }).length > 0, true);
  assert.equal(serverSummaryText({ transport: "streamable-http", url: "https://x/y" }), "https://x/y");
  assert.equal(viewSummaryText(makeServerView({ args: ["a"] })), "node a");
});

test("lifecycleLabel / formatTimestamp", () => {
  assert.equal(lifecycleLabel("eager").startsWith("eager"), true);
  assert.equal(lifecycleLabel("lazy-keep-alive").startsWith("lazy-keep-alive"), true);
  assert.equal(lifecycleLabel("nonsense").startsWith("lazy"), true);
  assert.equal(formatTimestamp(0).length, 16);
  assert.equal(formatTimestamp(undefined), "");
});

test("matchesFilter：全部 / 已启用 / 已停用 / 有错误", () => {
  const enabled = makeServerView({ serverName: "a" });
  const disabled = makeServerView({ serverName: "b", disabled: true });
  const failing = makeServerView({ serverName: "c", setFields: ["serverName", "transport", "command"] });
  const rows = new Map([["c", { name: "c", disabled: false, lastFailure: { message: "启动失败", at: NOW } }]]);
  assert.equal(matchesFilter(enabled, undefined, "all"), true);
  assert.equal(matchesFilter(disabled, undefined, "enabled"), false);
  assert.equal(matchesFilter(disabled, undefined, "disabled"), true);
  assert.equal(matchesFilter(failing, rows.get("c"), "failing"), true);
  assert.equal(matchesFilter(enabled, undefined, "failing"), false);
});

test("matchesQuery：名称 / 命令 / 描述 / 标签，大小写不敏感", () => {
  const view = makeServerView({
    serverName: "Demo",
    args: ["-y", "pkg"],
    meta: { description: "本地回显", tags: ["走查"] },
  });
  assert.equal(matchesQuery(view, ""), true);
  assert.equal(matchesQuery(view, "demo"), true);
  assert.equal(matchesQuery(view, "node"), true);
  assert.equal(matchesQuery(view, "回显"), true);
  assert.equal(matchesQuery(view, "走查"), true);
  assert.equal(matchesQuery(view, "nope"), false);
});

test("serverFilterCounts / visibleServers：计数与搜索筛选一致", () => {
  const servers = [
    makeServerView({ serverName: "a" }),
    makeServerView({ serverName: "b", disabled: true }),
    makeServerView({ serverName: "c" }),
  ];
  const rows = new Map([["c", { name: "c", disabled: false, lastFailure: { message: "启动失败", at: NOW } }]]);
  assert.deepEqual(serverFilterCounts(servers, rows), { all: 3, enabled: 2, disabled: 1, failing: 1 });
  assert.deepEqual(
    visibleServers(servers, rows, "", "disabled").map((view) => view.serverName),
    ["b"],
  );
  assert.deepEqual(
    visibleServers(servers, rows, "c", "all").map((view) => view.serverName),
    ["c"],
  );
  assert.deepEqual(
    visibleServers(servers, rows, "c", "failing").map((view) => view.serverName),
    ["c"],
  );
  assert.deepEqual(visibleServers(servers, rows, "c", "disabled"), []);
});

test("serverStatusTone：冷却 > 失败 > 有活跃实例 > 空闲", () => {
  const cooling = {
    name: "x",
    disabled: false,
    lastFailure: { message: "启动失败", at: NOW, cooldownUntil: NOW + 30_000 },
  };
  assert.equal(serverStatusTone(cooling, 2, NOW), "cooling");
  assert.equal(serverStatusTone(cooling, 2, NOW + 30_000), "failed");
  assert.equal(
    serverStatusTone({ name: "x", disabled: false, lastFailure: { message: "启动失败", at: NOW } }, 0, NOW),
    "failed",
  );
  assert.equal(serverStatusTone(undefined, 1, NOW), "active");
  assert.equal(serverStatusTone(undefined, 0, NOW), "idle");
  assert.equal(statusTitle("idle"), undefined);
  assert.equal(typeof statusTitle("active"), "string");
  assert.equal(typeof statusTitle("failed"), "string");
  assert.equal(typeof statusTitle("cooling"), "string");
});

test("cooldownText / formatDuration：倒计时文案随 now 变化，冷却结束就不显示", () => {
  const failure = { message: "启动失败", at: NOW, cooldownUntil: NOW + 47_000 };
  assert.equal(cooldownRemainingMs(failure, NOW), 47_000);
  assert.equal(cooldownText(failure, NOW), "冷却中，剩余 47 秒");
  assert.equal(cooldownText(failure, NOW + 47_000), undefined);
  assert.equal(cooldownText(undefined, NOW), undefined);
  assert.equal(formatDuration(65_000), "1 分 05 秒");
  assert.equal(formatDuration(999), "0 秒");
  assert.equal(formatDuration(3_900_000), "1 小时 05 分");
  assert.equal(
    cooldownRemainingMs({ message: "x", at: NOW, cooldownUntil: NOW + 1000 }, NOW + 60_000),
    0,
    "时钟回拨 / 已过期一律夹到 0",
  );
  assert.equal(cooldownRemainingMs({ message: "x", at: NOW }, NOW), 0, "cooldownUntil 缺失 = 冷却已结束");
});

test("rowSubtitleText：命令 / 地址 + 「· N 个工具」（没有缓存时省略）", () => {
  const view = makeServerView({ args: ["-y", "pkg"] });
  assert.equal(rowSubtitleText(view, undefined), "node -y pkg");
  assert.equal(
    rowSubtitleText(view, {
      name: "demo",
      disabled: false,
      cache: { toolCount: 4, updatedAt: NOW, stale: false, tools: [] },
    }),
    "node -y pkg · 4 个工具",
  );
  assert.equal(
    rowSubtitleText(makeServerView({ transport: "streamable-http", url: "https://x/y" }), undefined),
    "https://x/y",
  );
});

test("cacheLineText / cachedToolNames：抽屉「工具」小节", () => {
  assert.equal(cacheLineText(undefined), "还没有工具缓存（保存或刷新后会自动探测一次）");
  const row = {
    name: "demo",
    disabled: false,
    cache: { toolCount: 2, updatedAt: NOW, stale: true, tools: [{ name: "echo" }, { name: "slow" }] },
  };
  assert.equal(cacheLineText(row).includes("缓存 2 个工具"), true);
  assert.equal(cacheLineText(row).includes("缓存已过期"), true);
  assert.deepEqual(cachedToolNames(row), ["echo", "slow"]);
  assert.deepEqual(cachedToolNames(undefined), []);
  assert.deepEqual(
    cachedToolNames({
      name: "demo",
      disabled: false,
      cache: { toolCount: 1, updatedAt: NOW, stale: false, tools: [] },
    }),
    [],
  );
});

test("activeInstanceCount / runtimeIndex：从运行态会话里数实例", () => {
  const inst = (server: string) => ({ server, state: "ready", startedAt: NOW, lastUsedAt: NOW });
  const runtime = {
    servers: [{ name: "demo", disabled: false }],
    sessions: [
      { sessionId: "s1", instances: [inst("demo"), inst("other")] },
      { sessionId: "s2", instances: [inst("demo")] },
    ],
  };
  assert.equal(activeInstanceCount(runtime, "demo"), 2);
  assert.equal(activeInstanceCount(runtime, "nope"), 0);
  assert.equal(activeInstanceCount(undefined, "demo"), 0);
  assert.deepEqual([...runtimeIndex(runtime).keys()], ["demo"]);
});

test("formatClock：本地 HH:mm", () => {
  assert.match(formatClock(NOW), /^\d{2}:\d{2}$/);
  assert.equal(formatClock(undefined), "");
  assert.equal(formatClock(0), "");
});

test("列表行的紧凑命令：路径只留文件名，可执行文件去掉扩展名，包名与地址原样", () => {
  assert.equal(
    compactSummaryText({
      transport: "stdio",
      command: "D:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\x\\y\\fake-mcp-server.mjs"],
    }),
    "node fake-mcp-server.mjs",
  );
  assert.equal(
    compactSummaryText({ transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"] }),
    "npx -y @modelcontextprotocol/server-fetch",
  );
  assert.equal(
    compactSummaryText({
      transport: "stdio",
      command: "uvx",
      args: ["mcp-server-time", "--local-timezone=Asia/Shanghai"],
    }),
    "uvx mcp-server-time --local-timezone=Asia/Shanghai",
  );
  assert.equal(
    compactSummaryText({ transport: "stdio", command: "/usr/local/bin/python3", args: ["./server.py"] }),
    "python3 server.py",
  );
  assert.equal(
    compactSummaryText({ transport: "streamable-http", url: "https://example.com/mcp" }),
    "https://example.com/mcp",
  );
  assert.equal(isPathLike("@scope/pkg"), false);
  assert.equal(isPathLike("~/bin/tool"), true);
  assert.equal(shortPart("C:\\tools\\server.CMD", true), "server");
});
