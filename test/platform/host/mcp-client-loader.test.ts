/**
 * mcp-client-loader.ts：加载 DSH 官方 MCP 插件（ADR-0010）。永不 reject，失败只降级。
 *
 * 注入 importer，不真的去 import 官方包。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadMcpClient } from "../../../src/platform/host/mcp-client-loader.ts";

describe("mcp-client-loader", () => {
  it("正常导出（Config + apply）⇒ loaded，plugin 就是该模块", async () => {
    const plugin = { Config: (input: Record<string, unknown>) => input, apply: () => {} };
    const state = await loadMcpClient(async (specifier) => {
      assert.equal(specifier, "@deepseek-ai/dsh-mcp-client");
      return plugin;
    });
    assert.equal(state.status, "loaded");
    assert.equal(state.status === "loaded" && state.plugin, plugin);
  });

  it("缺少 Config 或 apply ⇒ failed，原因写明导出不符合预期", async () => {
    const noConfig = await loadMcpClient(async () => ({ apply: () => {} }));
    assert.equal(noConfig.status, "failed");
    assert.match(noConfig.status === "failed" ? noConfig.message : "", /缺少 Config 或 apply/);
    const noApply = await loadMcpClient(async () => ({ Config: () => ({}) }));
    assert.equal(noApply.status, "failed");
    const empty = await loadMcpClient(async () => undefined);
    assert.equal(empty.status, "failed");
  });

  it("importer 抛错 ⇒ failed，原因带原始消息", async () => {
    const state = await loadMcpClient(async () => {
      throw new Error("Cannot find module");
    });
    assert.equal(state.status, "failed");
    assert.match(
      state.status === "failed" ? state.message : "",
      /加载 DSH 官方 MCP 插件（dsh-mcp-client）失败：Cannot find module/,
    );
  });
});
