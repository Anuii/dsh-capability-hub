/**
 * view-model.ts 的纯逻辑单测：一行服务器的摘要与副标题，筛选与计数，排序。
 *
 * 0.9.0 起页面上没有运行状态，所以状态点、状态文字、「N 个工具」与「有错误」筛选都不再测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  compactSummaryText,
  failedServers,
  isPathLike,
  matchesFilter,
  matchesQuery,
  reorderNames,
  rowSubtitleText,
  rowSubtitleTitle,
  scopeLabel,
  serverFilterCounts,
  serverSummaryText,
  shortPart,
  viewSummaryText,
  visibleServers,
} from "../../../src/mcp/client/view-model.ts";
import type { HealthPayload } from "../../../src/platform/client/api.ts";
import { makeServerView } from "./fixtures.ts";

const healthWith = (servers: unknown[]): HealthPayload => ({ mcpServers: servers }) as unknown as HealthPayload;

test("连接失败提示：只挑 failed / disconnected（connecting 是瞬态，不提示）", () => {
  const health = healthWith([
    { name: "a", scope: "global", state: "connected", toolCount: 5, sessions: 0 },
    { name: "b", scope: "global", state: "failed", toolCount: 0, sessions: 0, error: "Connection closed" },
    { name: "c", scope: "global", state: "connecting", toolCount: 0, sessions: 0 },
    { name: "d", scope: "global", state: "disconnected", toolCount: 0, sessions: 0 },
    { name: "e", scope: "global", state: "disabled", toolCount: 0, sessions: 0 },
    { name: "f", scope: "session", state: "session", toolCount: 0, sessions: 1 },
  ]);
  assert.deepEqual(failedServers(health), [{ name: "b", error: "Connection closed" }, { name: "d" }]);
  assert.deepEqual(failedServers(undefined), [], "没有 health 时不提示，也不抛");
  assert.deepEqual(failedServers(healthWith([])), []);
});

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

test("matchesFilter：全部 / 已启用 / 已停用（只看配置里的 disabled，与连接无关）", () => {
  const on = makeServerView({ serverName: "on" });
  const off = makeServerView({ serverName: "off", disabled: true });
  assert.equal(matchesFilter(on, "all"), true);
  assert.equal(matchesFilter(off, "all"), true);
  assert.equal(matchesFilter(on, "enabled"), true);
  assert.equal(matchesFilter(off, "enabled"), false);
  assert.equal(matchesFilter(on, "disabled"), false);
  assert.equal(matchesFilter(off, "disabled"), true);
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
  assert.deepEqual(serverFilterCounts(servers), { all: 3, enabled: 2, disabled: 1 });
  assert.deepEqual(
    visibleServers(servers, "", "disabled").map((s) => s.serverName),
    ["b"],
  );
  assert.deepEqual(
    visibleServers(servers, "a", "all").map((s) => s.serverName),
    ["a"],
  );
});

test("rowSubtitleText：只有紧凑的命令 / 地址，没有状态后缀；rowSubtitleTitle 给完整命令", () => {
  const view = makeServerView({ serverName: "a", args: ["x.js"] });
  assert.equal(rowSubtitleText(view), "node x.js");
  assert.equal(rowSubtitleText(makeServerView({ disabled: true, args: ["x.js"] })), "node x.js", "停用不影响副标题");
  assert.equal(
    rowSubtitleText(makeServerView({ transport: "streamable-http", url: "https://example.com/mcp" })),
    "https://example.com/mcp",
  );
  assert.equal(rowSubtitleTitle(makeServerView({ args: ["x.js"] })), "node x.js");
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
