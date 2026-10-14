/**
 * schema.ts 与 rules/server.ts：白名单、类型/枚举/边界、条件必填、envFrom 静态校验、默认值归一化。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setFieldsOf, toEffectiveServer } from "../../../src/mcp/config/schema.ts";
import {
  DEFAULT_ENV_FROM_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  DEPRECATED_FIELDS,
  DEPRECATED_META_FIELDS,
  parseServerInput,
} from "../../../src/mcp/rules/server.ts";

const stdio = { serverName: "demo", transport: "stdio", command: "node" };

function errorsOf(input: unknown, existingNames: string[] = []): { path: string; message: string }[] {
  return parseServerInput(input, { existingNames }).errors;
}

function paths(input: unknown, existingNames: string[] = []): string[] {
  return errorsOf(input, existingNames).map((e) => e.path);
}

describe("schema: 未知字段", () => {
  it("拒绝未知字段与拼写错误", () => {
    assert.deepEqual(paths({ ...stdio, commnad: "node" }), ["server.commnad"]);
    assert.deepEqual(paths({ ...stdio, transfer: "stdio" }), ["server.transfer"]);
    assert.deepEqual(paths({ ...stdio, envs: {} }), ["server.envs"]);
  });

  it("对官方客户端插件的字段给出专门说明", () => {
    const errors = errorsOf({ ...stdio, directTools: ["x"] });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /这是已停用的 dsh-mcp-lazy 的字段，本插件不支持/);
    for (const field of ["freezeDirectTools", "reconnect", "failOnStartupError", "maxInstructionBytes"]) {
      const one = errorsOf({ ...stdio, [field]: true });
      assert.equal(one.length, 1, field + " 应被拒绝");
      assert.match(one[0].message, /不支持的字段「/);
    }
  });

  it("0.7.0 废弃的字段被拒绝，并说明为什么没了", () => {
    for (const field of Object.keys(DEPRECATED_FIELDS)) {
      const errors = errorsOf({ ...stdio, [field]: "x" });
      assert.equal(errors.length, 1, field + " 应被拒绝");
      assert.equal(errors[0].path, "server." + field);
      assert.match(errors[0].message, /已废弃/);
    }
    assert.deepEqual(Object.keys(DEPRECATED_FIELDS).sort(), [
      "debug",
      "excludeTools",
      "idleTimeout",
      "includeTools",
      "lifecycle",
      "searchKeywords",
    ]);
  });

  it("白名单覆盖 15 个字段 + meta.description，且全部字段被接受", () => {
    const full = {
      serverName: "full-1",
      transport: "stdio",
      command: "node",
      args: ["-e", "x"],
      cwd: "C:/tmp",
      env: { A: "1" },
      envFrom: { B: "echo b" },
      allowEmpty: ["B"],
      envFromTimeoutMs: 5000,
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
      toolCallTimeoutMs: 1234,
      scope: "session",
      disabled: true,
      meta: { description: "d" },
    };
    assert.deepEqual(errorsOf(full), []);
  });
});

describe("schema: serverName / transport", () => {
  it("名称正则与唯一性", () => {
    assert.deepEqual(paths({ ...stdio, serverName: "" }), ["server.serverName"]);
    assert.deepEqual(paths({ ...stdio, serverName: "a".repeat(33) }), ["server.serverName"]);
    assert.deepEqual(paths({ ...stdio, serverName: "有中文" }), ["server.serverName"]);
    assert.deepEqual(paths({ ...stdio, serverName: "ok_name-1" }), []);
    assert.deepEqual(paths(stdio, ["demo"]), ["server.serverName"]);
    assert.deepEqual(paths(stdio, ["other"]), []);
    assert.deepEqual(parseServerInput(stdio, { existingNames: ["demo"], originalName: "demo" }).errors, []);
  });

  it("transport 枚举", () => {
    assert.deepEqual(paths({ serverName: "x" }), ["server.transport"]);
    assert.deepEqual(paths({ serverName: "x", transport: "sse" }), ["server.transport"]);
    assert.deepEqual(paths({ serverName: "x", transport: "Streamable-HTTP" }), ["server.transport"]);
    assert.deepEqual(paths({ serverName: "x", transport: "streamable-http", url: "https://example.com/mcp" }), []);
  });
});

describe("schema: 类型与边界", () => {
  it("args 必须是字符串数组", () => {
    assert.deepEqual(paths({ ...stdio, args: "node" }), ["server.args"]);
    assert.deepEqual(paths({ ...stdio, args: [1] }), ["server.args[0]"]);
    assert.deepEqual(paths({ ...stdio, args: [] }), []);
  });

  it("env / headers / envFrom 必须是字符串映射", () => {
    assert.deepEqual(paths({ ...stdio, env: ["A"] }), ["server.env"]);
    assert.deepEqual(paths({ ...stdio, env: { A: 1 } }), ["server.env.A"]);
    assert.deepEqual(paths({ ...stdio, headers: { Authorization: 1 } }), ["server.headers.Authorization"]);
    assert.deepEqual(paths({ ...stdio, envFrom: { A: 1 } }), ["server.envFrom.A"]);
  });

  it("envFrom 的变量名必须合法", () => {
    assert.deepEqual(paths({ ...stdio, envFrom: { "1BAD": "echo" } }), ["server.envFrom.1BAD"]);
    assert.deepEqual(paths({ ...stdio, envFrom: { "A-B": "echo" } }), ["server.envFrom.A-B"]);
    assert.deepEqual(paths({ ...stdio, envFrom: { GOOD_1: "echo" } }), []);
  });

  it("envFromTimeoutMs 为自然数", () => {
    assert.deepEqual(paths({ ...stdio, envFromTimeoutMs: -1 }), ["server.envFromTimeoutMs"]);
    assert.deepEqual(paths({ ...stdio, envFromTimeoutMs: 1.5 }), ["server.envFromTimeoutMs"]);
    assert.equal(parseServerInput({ ...stdio, envFromTimeoutMs: 0 }).errors.length, 0);
  });

  it("toolCallTimeoutMs 为数字，≤0 表示不设超时", () => {
    assert.deepEqual(paths({ ...stdio, toolCallTimeoutMs: "60000" }), ["server.toolCallTimeoutMs"]);
    assert.deepEqual(paths({ ...stdio, toolCallTimeoutMs: -1 }), []);
    assert.deepEqual(paths({ ...stdio, toolCallTimeoutMs: 0 }), []);
    assert.equal(parseServerInput({ ...stdio, toolCallTimeoutMs: 0 }).server.toolCallTimeoutMs, 0);
    assert.equal(parseServerInput({ ...stdio, toolCallTimeoutMs: -1000 }).server.toolCallTimeoutMs, -1000);
  });

  it("scope 枚举：global / session，global 是默认不落盘", () => {
    assert.deepEqual(paths({ ...stdio, scope: "everywhere" }), ["server.scope"]);
    assert.deepEqual(paths({ ...stdio, scope: 1 }), ["server.scope"]);
    assert.deepEqual(paths({ ...stdio, scope: "global" }), []);
    assert.deepEqual(paths({ ...stdio, scope: "session" }), []);
    assert.equal(parseServerInput({ ...stdio, scope: "session" }).server.scope, "session");
    assert.equal(parseServerInput({ ...stdio, scope: "global" }).server.scope, undefined);
  });

  it("disabled 必须是布尔", () => {
    assert.deepEqual(paths({ ...stdio, disabled: "true" }), ["server.disabled"]);
    assert.deepEqual(paths({ ...stdio, disabled: true }), []);
    assert.deepEqual(paths({ ...stdio, disabled: false }), []);
  });

  it("meta 只接受 description；tags / homepage 报已废弃", () => {
    assert.deepEqual(paths({ ...stdio, meta: { extra: 1 } }), ["server.meta.extra"]);
    assert.deepEqual(paths({ ...stdio, meta: { description: "d" } }), []);
    assert.deepEqual(paths({ ...stdio, meta: { description: 1 } }), ["server.meta.description"]);
    assert.deepEqual(paths({ ...stdio, meta: "x" }), ["server.meta"]);
    for (const key of Object.keys(DEPRECATED_META_FIELDS)) {
      const errors = errorsOf({ ...stdio, meta: { [key]: ["t"] } });
      assert.equal(errors.length, 1, key + " 应被拒绝");
      assert.equal(errors[0].path, "server.meta." + key);
      assert.match(errors[0].message, /已废弃/);
    }
  });
});

describe("schema: 条件必填", () => {
  it("stdio 必须有非空 command", () => {
    assert.deepEqual(paths({ serverName: "x", transport: "stdio" }), ["server.command"]);
    assert.deepEqual(paths({ serverName: "x", transport: "stdio", command: "   " }), ["server.command"]);
  });

  it("streamable-http 必须有合法 url", () => {
    assert.deepEqual(paths({ serverName: "x", transport: "streamable-http" }), ["server.url"]);
    assert.deepEqual(paths({ serverName: "x", transport: "streamable-http", url: "ftp://x/y" }), ["server.url"]);
    assert.deepEqual(paths({ serverName: "x", transport: "streamable-http", url: "不是地址" }), ["server.url"]);
    assert.deepEqual(paths({ serverName: "x", transport: "streamable-http", url: "http://127.0.0.1:3000/mcp" }), []);
  });
});

describe("schema: envFrom 静态校验（4 条）", () => {
  it("envFrom 不能用于非 stdio", () => {
    const errors = errorsOf({
      serverName: "x",
      transport: "streamable-http",
      url: "https://example.com/mcp",
      envFrom: { A: "echo a" },
    });
    assert.deepEqual(
      errors.map((e) => e.path),
      ["server.envFrom"],
    );
    assert.match(errors[0].message, /只能用于 stdio/);
  });

  it("同名变量不能同时出现在 env 与 envFrom", () => {
    const errors = errorsOf({ ...stdio, env: { A: "1" }, envFrom: { A: "echo a" } });
    assert.deepEqual(
      errors.map((e) => e.path),
      ["server.envFrom.A"],
    );
    assert.match(errors[0].message, /同时出现在 env 与 envFrom/);
  });

  it("envFrom 的命令不能是空字符串", () => {
    const errors = errorsOf({ ...stdio, envFrom: { A: "" } });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, "server.envFrom.A");
  });

  it("allowEmpty 里的名字必须在 envFrom 中声明", () => {
    const errors = errorsOf({ ...stdio, envFrom: { A: "echo a" }, allowEmpty: ["B"] });
    assert.deepEqual(
      errors.map((e) => e.path),
      ["server.allowEmpty"],
    );
    assert.match(errors[0].message, /没有在 envFrom 中声明/);
    assert.deepEqual(errorsOf({ ...stdio, envFrom: { A: "echo a" }, allowEmpty: ["A"] }), []);
    assert.deepEqual(paths({ ...stdio, allowEmpty: ["A"] }), ["server.allowEmpty"]);
    assert.deepEqual(paths({ ...stdio, allowEmpty: ["1BAD"] }), ["server.allowEmpty"]);
  });
});

describe("schema: 默认值不落盘", () => {
  it("归一化结果只保留非默认字段", () => {
    const parsed = parseServerInput({
      serverName: "demo",
      transport: "stdio",
      command: "node",
      args: [],
      env: {},
      envFrom: {},
      allowEmpty: [],
      envFromTimeoutMs: DEFAULT_ENV_FROM_TIMEOUT_MS,
      headers: {},
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
      scope: "global",
      disabled: false,
      meta: {},
    });
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.server, { serverName: "demo", transport: "stdio", command: "node" });
    assert.deepEqual(setFieldsOf(parsed.server).sort(), ["command", "serverName", "transport"]);
  });

  it("显式设置的 scope=session 会落盘", () => {
    const parsed = parseServerInput({ ...stdio, scope: "session" });
    assert.equal(parsed.server.scope, "session");
    assert.equal(setFieldsOf(parsed.server).includes("scope"), true);
  });

  it("生效值补齐默认", () => {
    const effective = toEffectiveServer({ serverName: "demo", transport: "stdio", command: "node" });
    assert.deepEqual(effective.args, []);
    assert.deepEqual(effective.env, {});
    assert.deepEqual(effective.envFrom, {});
    assert.deepEqual(effective.allowEmpty, []);
    assert.deepEqual(effective.headers, {});
    assert.equal(effective.envFromTimeoutMs, DEFAULT_ENV_FROM_TIMEOUT_MS);
    assert.equal(effective.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS);
    assert.equal(effective.scope, "global");
    assert.equal(effective.disabled, false);
    assert.deepEqual(effective.meta, {});
  });

  it("scope=session 与 meta.description 原样生效", () => {
    const effective = toEffectiveServer({
      serverName: "demo",
      transport: "stdio",
      command: "node",
      scope: "session",
      meta: { description: "会话级" },
    });
    assert.equal(effective.scope, "session");
    assert.deepEqual(effective.meta, { description: "会话级" });
  });
});
