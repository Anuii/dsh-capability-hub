/**
 * json-model.ts：单服务器 JSON 编辑的纯逻辑——视图 → JSON（只列显式设置的字段、遮罩值原样），JSON → 对象。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseJsonServer, serverJsonText, serverJsonValues } from "../../../src/mcp/client/json-model.ts";
import { parseServerInput } from "../../../src/mcp/rules/server.ts";
import { makeServerView } from "./fixtures.ts";

test("只列显式设置过的字段，按白名单顺序；serverName 与 transport 总在；遮罩值原样", () => {
  const view = makeServerView({
    serverName: "gh",
    command: "npx",
    args: ["-y", "pkg"],
    env: { TOKEN: "***hidden***" },
    scope: "session",
    meta: { description: "GitHub" },
    setFields: ["serverName", "transport", "command", "args", "env", "scope", "meta"],
  });
  assert.deepEqual(Object.keys(serverJsonValues(view)), [
    "serverName",
    "transport",
    "command",
    "args",
    "env",
    "scope",
    "meta",
  ]);
  assert.deepEqual(serverJsonValues(view).env, { TOKEN: "***hidden***" });
  const bare = makeServerView({ serverName: "x", setFields: [] });
  assert.deepEqual(serverJsonValues(bare), { serverName: "x", transport: "stdio" });
  assert.equal(serverJsonText(bare), '{\n  "serverName": "x",\n  "transport": "stdio"\n}');
});

test("往返：视图转成的 JSON 能直接通过同一份规则的校验（除遮罩值由宿主合并）", () => {
  const view = makeServerView({ serverName: "a", command: "node", args: ["x.js"], setFields: ["command", "args"] });
  const parsed = parseJsonServer(serverJsonText(view));
  assert.deepEqual(parseServerInput(parsed.values).errors, []);
});

test("parseJsonServer：语法错误给原因；顶层不是对象给中文提示", () => {
  assert.match(parseJsonServer("{").error ?? "", /JSON|Expected|Unexpected/);
  assert.match(parseJsonServer("[1]").error ?? "", /顶层必须是一个 JSON 对象/);
  assert.deepEqual(parseJsonServer('{"serverName":"a"}').values, { serverName: "a" });
});
