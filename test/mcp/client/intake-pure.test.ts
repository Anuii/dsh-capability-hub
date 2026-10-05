/**
 * intake/pure.ts 的纯逻辑单测（不碰 DOM / React / 网络）。
 *
 * 覆盖：粘贴预览计划（同名冲突 / 非法名 / 同批重复）、改名建议、默认勾选与阻断、
 * 落盘形态 → upsert 体、遮罩占位符检测、导入候选与计数。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  blockedRows,
  defaultSelection,
  hiddenKeys,
  importableNames,
  importCounts,
  planPasteRows,
  placeholderNames,
  rawSummary,
  rawToSubmit,
  renameRow,
  secretSummary,
  selectedNames,
  suggestAvailableName,
  toggleSelection,
} from "../../../src/mcp/client/intake/pure.ts";
import type { RawParsedServer } from "../../../src/mcp/client/types.ts";

const FAKE = "C:\\x\\fake-mcp-server.mjs";

function stdio(name: string, command = "node"): RawParsedServer {
  return { serverName: name, transport: "stdio", command, args: [FAKE] };
}

test("rawSummary：stdio 显示命令与参数，http 显示地址", () => {
  assert.equal(rawSummary(stdio("a", "node")), "stdio · node " + FAKE);
  assert.equal(rawSummary({ serverName: "b", transport: "streamable-http", url: "https://x/mcp" }), "streamable-http · https://x/mcp");
  assert.equal(rawSummary({ serverName: "c", transport: "stdio" }), "stdio · （未设置启动命令）");
});

test("planPasteRows：干净的名字是 new，重名是 conflict，非法名是 invalid", () => {
  const rows = planPasteRows([
    stdio("alpha"),
    stdio("alpha2"),
    stdio("坏名字"),
    stdio("beta"),
  ], ["beta"]);
  assert.deepEqual(rows.map((row) => row.status), ["new", "new", "invalid", "conflict"]);
  assert.equal(rows[0].name, "alpha");
  assert.equal(rows[3].originalName, "beta");
});

test("planPasteRows：同一批里重名算冲突（不能一次提交两个同名）", () => {
  const rows = planPasteRows([stdio("alpha"), stdio("alpha")], []);
  assert.deepEqual(rows.map((row) => row.status), ["conflict", "conflict"]);
});

test("planPasteRows：冲突行给出可用建议名（避开现有配置与同批名字）", () => {
  const rows = planPasteRows([stdio("beta"), stdio("beta-2")], ["beta", "beta-2"]);
  assert.equal(rows[0].status, "conflict");
  assert.equal(rows[0].suggestedName, "beta-3");
  assert.equal(rows[1].suggestedName, "beta-2-2");
});

test("suggestAvailableName：非法字符先清洗，再按 -2、-3 递增", () => {
  assert.equal(suggestAvailableName("ok-name", []), "ok-name");
  assert.equal(suggestAvailableName("bad name!", []), "bad-name-");
  assert.equal(suggestAvailableName("a", ["a"]), "a-2");
  assert.equal(suggestAvailableName("a", ["a", "a-2"]), "a-3");
  // 超长名字截断到 32 位
  const long = "x".repeat(40);
  assert.equal(suggestAvailableName(long, []).length, 32);
  assert.equal(suggestAvailableName("", []), "server");
});

test("renameRow：改名后重算该行状态，其他行不动", () => {
  const rows = planPasteRows([stdio("alpha"), stdio("alpha")], []);
  const renamed = renameRow(rows, 1, "alpha-copy", []);
  assert.equal(renamed[1].name, "alpha-copy");
  assert.equal(renamed[1].status, "new");
  assert.equal(renamed[0].status, "new");
  // 其他行改成与第一行同名 → 第一行变成冲突
  const clashed = renameRow(renamed, 1, "alpha", []);
  assert.equal(clashed[1].status, "conflict");
  assert.equal(clashed[0].status, "conflict");
});

test("renameRow：改成一个已存在的名字仍然是冲突（不能靠改名绕过）", () => {
  const rows = planPasteRows([stdio("alpha")], ["taken"]);
  const renamed = renameRow(rows, 0, "taken", ["taken"]);
  assert.equal(renamed[0].status, "conflict");
  assert.equal(renamed[0].suggestedName, "taken-2");
});

test("默认勾选：只有没有问题的行被勾上", () => {
  const rows = planPasteRows([stdio("alpha"), stdio("alpha"), stdio("bad name"), stdio("gamma")], []);
  assert.deepEqual(defaultSelection(rows), [3]);
  assert.deepEqual(blockedRows(rows, [3, 1]), [rows[1]]);
  assert.deepEqual(blockedRows(rows, [3]), []);
});

test("toggleSelection：加/减并保持升序", () => {
  assert.deepEqual(toggleSelection([], 2), [2]);
  assert.deepEqual(toggleSelection([2], 0), [0, 2]);
  assert.deepEqual(toggleSelection([0, 2], 0), [2]);
});

test("selectedNames / rawToSubmit：只带认识的字段，名字用改名后的", () => {
  const rows = renameRow(planPasteRows([stdio("alpha")], ["alpha"]), 0, "alpha-2", ["alpha"]);
  assert.deepEqual(selectedNames(rows, [0]), ["alpha-2"]);
  const submit = rawToSubmit({ ...rows[0].server, serverName: rows[0].name });
  assert.deepEqual(Object.keys(submit).sort(), ["args", "command", "serverName", "transport"]);
  assert.equal(submit.serverName, "alpha-2");
});

test("rawToSubmit：不把 undefined 写进去（默认值不落盘）", () => {
  const submit = rawToSubmit({ serverName: "a", transport: "stdio", command: "node", args: undefined, cwd: undefined });
  assert.deepEqual(submit, { serverName: "a", transport: "stdio", command: "node" });
});

test("hiddenKeys / placeholderNames / secretSummary：只认遮罩占位符与键数", () => {
  const withHidden: RawParsedServer = { serverName: "a", transport: "stdio", env: { TOKEN: "***hidden***" }, headers: { Authorization: "***hidden***" } };
  const plain: RawParsedServer = { serverName: "b", transport: "stdio", env: { TOKEN: "real" } };
  assert.deepEqual(hiddenKeys(withHidden).sort(), ["env.TOKEN", "headers.Authorization"]);
  assert.deepEqual(hiddenKeys(plain), []);
  assert.deepEqual(placeholderNames([withHidden, plain]), ["a"]);
  assert.equal(secretSummary(withHidden), "env 1 项（值已遮罩） · headers 1 项（值已遮罩）");
  assert.equal(secretSummary(plain), "env 1 项（值已遮罩）");
  assert.equal(secretSummary({ serverName: "c", transport: "stdio" }), "");
});

test("importableNames：默认只勾选当前配置里没有的服务器", () => {
  const servers = [stdio("a"), stdio("b")];
  assert.deepEqual(importableNames(servers, ["b"]), ["a"]);
  assert.deepEqual(importableNames(servers, []), ["a", "b"]);
});

test("importCounts：数出 imported 与 skipped", () => {
  assert.deepEqual(importCounts(["a", "b"], [{ name: "c", reason: "同名" }]), { imported: 2, skipped: 1 });
});
