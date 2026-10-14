/**
 * view-model.ts 的纯逻辑单测：一行服务器的摘要、状态点、副标题、状态文字，筛选与计数，排序。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  compactSummaryText,
  isPathLike,
  matchesFilter,
  matchesQuery,
  reorderNames,
  rowSubtitleText,
  runtimeIndex,
  scopeLabel,
  serverFilterCounts,
  serverStatusTone,
  serverSummaryText,
  shortPart,
  stateText,
  statusTitle,
  viewSummaryText,
  visibleServers,
} from "../../../src/mcp/client/view-model.ts";
import { makeRow, makeRuntime, makeServerView } from "./fixtures.ts";

test("reorderNames（拖动排序）", () => {
  const names = ["a", "b", "c"];
  assert.deepEqual(reorderNames(names, 0, 2), ["b", "c", "a"]);
  assert.deepEqual(reorderNames(names, 2, 0), ["c", "a", "b"]);
  assert.deepEqual(names, ["a", "b", "c"], "原数组不能被改动");
});

test("serverSummaryText 与 viewSummaryText；scopeLabel", () => {
  assert.equal(serverSummaryText({ transport: "stdio", command: "node", args: ["-y", "pkg"] }), "node -y pkg");
  assert.equal(serverSummaryText({ transport: "stdio" }).length > 0, true);
  assert.equal(serverSummaryText({ transport: "streamable-http", url: "https://x/y" }), "https://x/y");
  assert.equal(viewSummaryText(makeServerView({ args: ["a"] })), "node a");
  assert.match(scopeLabel("global"), /全局一份/);
  assert.match(scopeLabel("session"), /按会话/);
});

test("matchesFilter：全部 / 已启用 / 已停用 / 有错误（连接失败或未连接；停用的不算）", () => {
  const on = makeServerView({ serverName: "on" });
  const off = makeServerView({ serverName: "off", disabled: true });
  const failed = makeRow({ name: "on", state: "failed", tools: [], error: "x" });
  const lost = makeRow({ name: "on", state: "disconnected", tools: [] });
  assert.equal(matchesFilter(on, undefined, "all"), true);
  assert.equal(matchesFilter(on, undefined, "enabled"), true);
  assert.equal(matchesFilter(off, undefined, "disabled"), true);
  assert.equal(matchesFilter(on, makeRow({ name: "on" }), "failing"), false);
  assert.equal(matchesFilter(on, failed, "failing"), true);
  assert.equal(matchesFilter(on, lost, "failing"), true);
  assert.equal(matchesFilter(off, failed, "failing"), false);
});

test("matchesQuery：名称 / 命令 / 描述，大小写不敏感", () => {
  const view = makeServerView({ serverName: "GitHub", args: ["server.js"], meta: { description: "Issues 与 PR" } });
  assert.equal(matchesQuery(view, ""), true);
  assert.equal(matchesQuery(view, "github"), true);
  assert.equal(matchesQuery(view, "SERVER.JS"), true);
  assert.equal(matchesQuery(view, "issues"), true);
  assert.equal(matchesQuery(view, "nope"), false);
});

test("serverFilterCounts / visibleServers：计数与搜索筛选一致", () => {
  const servers = [
    makeServerView({ serverName: "a" }),
    makeServerView({ serverName: "b", disabled: true }),
    makeServerView({ serverName: "c" }),
  ];
  const rows = runtimeIndex(makeRuntime([makeRow({ name: "a" }), makeRow({ name: "c", state: "failed", tools: [] })]));
  assert.deepEqual(serverFilterCounts(servers, rows), { all: 3, enabled: 2, disabled: 1, failing: 1 });
  assert.deepEqual(
    visibleServers(servers, rows, "", "failing").map((s) => s.serverName),
    ["c"],
  );
  assert.deepEqual(
    visibleServers(servers, rows, "a", "all").map((s) => s.serverName),
    ["a"],
  );
});

test("serverStatusTone / statusTitle：连接中琥珀、出错红、已连接或有会话挂着强调色、其余灰", () => {
  const view = makeServerView({ serverName: "a" });
  assert.equal(serverStatusTone(view, undefined), "idle");
  assert.equal(serverStatusTone(makeServerView({ disabled: true }), makeRow({ name: "a" })), "idle");
  assert.equal(serverStatusTone(view, makeRow({ name: "a", state: "connecting" })), "cooling");
  assert.equal(serverStatusTone(view, makeRow({ name: "a", state: "failed" })), "failed");
  assert.equal(serverStatusTone(view, makeRow({ name: "a", state: "disconnected" })), "failed");
  assert.equal(serverStatusTone(view, makeRow({ name: "a" })), "active");
  assert.equal(serverStatusTone(view, makeRow({ name: "a", state: "session", sessions: 0 })), "idle");
  assert.equal(serverStatusTone(view, makeRow({ name: "a", state: "session", sessions: 2 })), "active");
  assert.equal(statusTitle("idle"), undefined);
  assert.equal(statusTitle("active"), "已连接");
  assert.equal(statusTitle("failed"), "连接失败");
  assert.equal(statusTitle("cooling"), "正在连接");
});

test("rowSubtitleText：命令 / 地址 + 「· N 个工具」或「· 按会话」；没连上或停用时只有命令", () => {
  const view = makeServerView({ serverName: "a", args: ["x.js"] });
  assert.equal(rowSubtitleText(view, undefined), "node x.js");
  assert.equal(rowSubtitleText(view, makeRow({ name: "a" })), "node x.js · 2 个工具");
  assert.equal(rowSubtitleText(view, makeRow({ name: "a", state: "session", tools: [] })), "node x.js · 按会话");
  assert.equal(rowSubtitleText(view, makeRow({ name: "a", state: "failed", tools: [] })), "node x.js");
  assert.equal(
    rowSubtitleText(makeServerView({ disabled: true, args: ["x.js"] }), makeRow({ name: "a" })),
    "node x.js",
  );
});

test("stateText：抽屉「工具」一节的状态文字", () => {
  const view = makeServerView({ serverName: "a" });
  assert.match(stateText(makeServerView({ disabled: true }), makeRow({ name: "a" })), /已停用/);
  assert.match(stateText(view, undefined), /还没读到/);
  assert.match(stateText(view, makeRow({ name: "a", state: "connecting" })), /正在连接/);
  assert.match(stateText(view, makeRow({ name: "a" })), /已连接 · 2 个工具/);
  assert.match(stateText(view, makeRow({ name: "a", state: "disconnected" })), /未连接/);
  assert.match(
    stateText(view, makeRow({ name: "a", state: "failed", error: "spawn ENOENT" })),
    /连接失败：spawn ENOENT/,
  );
  assert.match(stateText(view, makeRow({ name: "a", state: "failed" })), /详见 DSH 日志/);
  assert.match(stateText(view, makeRow({ name: "a", state: "session", sessions: 3 })), /当前 3 个会话已连接/);
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
