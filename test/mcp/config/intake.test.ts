/**
 * intake.ts：粘贴 JSON 的识别（0.7.0 起是添加服务器的唯一入口，预设与导入已删除）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseMcpJson } from "../../../src/mcp/config/intake.ts";

describe("intake: parse-json", () => {
  it('识别 { "mcpServers": { ... } }', () => {
    const result = parseMcpJson(
      JSON.stringify({ mcpServers: { demo: { command: "uvx", args: ["mcp-server-fetch"] } } }),
    );
    assert.deepEqual(result.warnings, []);
    assert.equal(result.servers.length, 1);
    assert.deepEqual(result.servers[0], {
      serverName: "demo",
      transport: "stdio",
      command: "uvx",
      args: ["mcp-server-fetch"],
    });
  });

  it('识别 { "servers": { ... } } 与名称→对象映射', () => {
    const viaServers = parseMcpJson(JSON.stringify({ servers: { a: { command: "node" } } }));
    assert.deepEqual(
      viaServers.servers.map((s) => s.serverName),
      ["a"],
    );
    const viaMap = parseMcpJson(JSON.stringify({ a: { command: "node" }, b: { command: "node" } }));
    assert.deepEqual(
      viaMap.servers.map((s) => s.serverName),
      ["a", "b"],
    );
  });

  it("识别单个服务器对象与 servers 数组", () => {
    const solo = parseMcpJson(JSON.stringify({ serverName: "solo", transport: "stdio", command: "node", args: ["x"] }));
    assert.deepEqual(solo.servers[0], { serverName: "solo", transport: "stdio", command: "node", args: ["x"] });

    const array = parseMcpJson(
      JSON.stringify({ servers: [{ serverName: "one", command: "node" }, { command: "node" }] }),
    );
    assert.deepEqual(
      array.servers.map((s) => s.serverName),
      ["one"],
    );
    assert.equal(
      array.warnings.some((w) => w.includes("缺少 serverName")),
      true,
    );
  });

  it("type: http 映射为 streamable-http，type: sse 给警告", () => {
    const http = parseMcpJson(
      JSON.stringify({
        mcpServers: { r: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "x" } } },
      }),
    );
    assert.equal(http.servers[0].transport, "streamable-http");
    assert.deepEqual(http.servers[0].headers, { Authorization: "x" });

    const sse = parseMcpJson(JSON.stringify({ mcpServers: { r: { type: "sse", url: "https://example.com/sse" } } }));
    assert.equal(sse.servers[0].transport, "streamable-http");
    assert.equal(
      sse.warnings.some((w) => w.includes("不支持 SSE，可尝试 streamable-http")),
      true,
    );
  });

  it("未知字段给警告但不报错（导入路径宽容）", () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { a: { command: "node", reconnect: true } } }));
    assert.equal(result.servers.length, 1);
    assert.equal(
      result.warnings.some((w) => w.includes("reconnect")),
      true,
    );
  });

  it("非法 JSON 与空输入返回 warnings", () => {
    assert.match(parseMcpJson("{ 坏").warnings[0], /JSON 解析失败/);
    assert.equal(parseMcpJson("").warnings.length, 1);
    assert.equal(parseMcpJson("123").warnings.length >= 1, true);
  });

  it("不合法名称给出可操作警告", () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { 中文名: { command: "node" } } }));
    assert.equal(
      result.warnings.some((w) => w.includes("不合法")),
      true,
    );
  });
});

describe("intake: 扩展字段与废弃字段", () => {
  it("envFrom / allowEmpty / envFromTimeoutMs / toolCallTimeoutMs / scope / disabled / meta 原样带上", () => {
    const result = parseMcpJson(
      JSON.stringify({
        mcpServers: {
          a: {
            command: "node",
            envFrom: { TOKEN: "cat token.txt" },
            allowEmpty: ["TOKEN"],
            envFromTimeoutMs: 5000,
            toolCallTimeoutMs: 120000,
            scope: "session",
            disabled: true,
            meta: { description: "会话级服务器" },
          },
        },
      }),
    );
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.servers[0], {
      serverName: "a",
      transport: "stdio",
      command: "node",
      envFrom: { TOKEN: "cat token.txt" },
      allowEmpty: ["TOKEN"],
      envFromTimeoutMs: 5000,
      toolCallTimeoutMs: 120000,
      scope: "session",
      disabled: true,
      meta: { description: "会话级服务器" },
    });
  });

  it("废弃字段各给一条警告，且不落进服务器对象", () => {
    const result = parseMcpJson(
      JSON.stringify({
        mcpServers: {
          a: {
            command: "node",
            lifecycle: "lazy",
            idleTimeout: 3,
            debug: true,
            includeTools: ["x"],
            excludeTools: ["y"],
            searchKeywords: { t: ["k"] },
          },
        },
      }),
    );
    assert.equal(result.servers.length, 1);
    for (const key of ["lifecycle", "idleTimeout", "debug", "includeTools", "excludeTools", "searchKeywords"]) {
      assert.equal(
        result.warnings.some((w) => w.includes("字段 " + key + " 已废弃")),
        true,
        key + " 应有废弃警告",
      );
      assert.equal(
        key in (result.servers[0] as unknown as Record<string, unknown>),
        false,
        key + " 不该落进服务器对象",
      );
    }
    assert.equal(
      result.warnings.some((w) => w.includes("不受支持")),
      false,
      "废弃字段是「已废弃」，不是「不受支持」",
    );
  });

  it("env / headers 的非字符串值转成字符串，非对象给警告", () => {
    const result = parseMcpJson(
      JSON.stringify({ mcpServers: { a: { command: "node", env: { PORT: 3000, DEBUG: true }, headers: ["x"] } } }),
    );
    assert.deepEqual(result.servers[0].env, { PORT: "3000", DEBUG: "true" });
    assert.equal(
      result.warnings.some((w) => w.includes("headers 不是对象")),
      true,
    );
  });

  it("无法识别的结构给出提示", () => {
    const result = parseMcpJson(JSON.stringify({ hello: "world" }));
    assert.equal(result.servers.length, 0);
    assert.match(result.warnings.join(" "), /无法识别的 JSON 结构/);
  });

  it("mcpServers 为空时提示没有找到服务器", () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: {} }));
    assert.equal(result.servers.length, 0);
    assert.match(result.warnings.join(" "), /没有找到任何服务器/);
  });
});
