/**
 * tool-registrar.ts：把运行时给出的 MCP 工具注册进 DSH，并随清单变化增量更新。
 * 用假的 ctx.tools 记录 register / dispose；假运行时可以改清单、可以让某个工具注册失败。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerMcpTools, type ToolDefinitionLike } from "../../../src/platform/host/tool-registrar.ts";
import type { McpCallContext, McpRuntime, McpToolSpec } from "../../../src/mcp/contract/runtime.ts";

const spec = (name: string, description = "d"): McpToolSpec => ({
  name,
  server: "s",
  tool: name.replace(/^mcp__s__/, ""),
  description,
  parameters: { type: "object" },
});

function setup(initial: McpToolSpec[], rejects: string[] = []) {
  let specs = initial;
  const listeners = new Set<() => void>();
  const calls: { name: string; args: unknown; ctx: McpCallContext }[] = [];
  const runtime: McpRuntime = {
    tools: () => specs,
    onToolsChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    promptText: () => "",
    async call(name, args, ctx) {
      calls.push({ name, args, ctx });
      if (name.endsWith("boom")) throw new Error("服务器炸了");
      return "ok:" + name;
    },
    sessionStarted() {},
    async sessionEnded() {},
    async dispose() {},
  };
  const live = new Map<string, ToolDefinitionLike>();
  const log: string[] = [];
  const tools = {
    register(definition: unknown) {
      const def = definition as ToolDefinitionLike;
      if (rejects.includes(def.name)) throw new Error("unsupported JSON schema");
      log.push("+" + def.name);
      live.set(def.name, def);
      return () => {
        log.push("-" + def.name);
        live.delete(def.name);
      };
    },
  };
  const warnings: string[] = [];
  const logger = { debug() {}, info() {}, warn: (...a: unknown[]) => void warnings.push(a.join(" ")), error() {} };
  const registration = registerMcpTools({ tools, runtime, logger });
  return {
    registration,
    live,
    log,
    calls,
    warnings,
    change(next: McpToolSpec[]) {
      specs = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

test("启动时注册全部工具；DSH 拒绝的工具只跳过它并记下原因", () => {
  const h = setup([spec("mcp__s__a"), spec("mcp__s__bad"), spec("mcp__s__c")], ["mcp__s__bad"]);
  assert.deepEqual(h.registration.registered(), ["mcp__s__a", "mcp__s__c"]);
  assert.deepEqual(h.registration.failed(), [{ name: "mcp__s__bad", error: "unsupported JSON schema" }]);
  assert.equal(h.warnings.length, 1);
});

test("清单变化只动变了的工具：新增注册、删除注销、描述变了重注册，其余不碰", () => {
  const h = setup([spec("mcp__s__a"), spec("mcp__s__b"), spec("mcp__s__c")]);
  h.log.length = 0;
  h.change([spec("mcp__s__a"), spec("mcp__s__b", "新描述"), spec("mcp__s__d")]);
  assert.deepEqual(h.log.sort(), ["+mcp__s__b", "+mcp__s__d", "-mcp__s__b", "-mcp__s__c"]);
  h.log.length = 0;
  h.change([spec("mcp__s__a"), spec("mcp__s__b", "新描述"), spec("mcp__s__d")]);
  assert.deepEqual(h.log, [], "内容相同不重注册");
});

test("工具定义：参数原样交给 DSH；执行时带上会话身份调用运行时；失败照样抛给 DSH", async () => {
  const h = setup([spec("mcp__s__a"), spec("mcp__s__boom")]);
  const def = h.live.get("mcp__s__a")!;
  assert.deepEqual(def.parameters, { type: "object" });
  assert.deepEqual(def.output.schema, { type: "string" });
  const signal = new AbortController().signal;
  const exec = {
    signal,
    agent: { session: { id: "sess-1", header: { parentSession: "parent-0", origin: "subagent" } } },
  };
  assert.equal(await def.execute({ x: 1 }, exec), "ok:mcp__s__a");
  assert.deepEqual(h.calls[0], {
    name: "mcp__s__a",
    args: { x: 1 },
    ctx: { sessionId: "sess-1", parentSessionId: "parent-0", signal },
  });
  await assert.rejects(h.live.get("mcp__s__boom")!.execute({}, exec), /服务器炸了/);
  assert.deepEqual(def.output.render({}, "文字"), [{ type: "text", text: "文字" }]);
});

test("dispose 注销全部工具并退订；之后的变化不再注册", () => {
  const h = setup([spec("mcp__s__a"), spec("mcp__s__b")]);
  h.registration.dispose();
  assert.equal(h.live.size, 0);
  assert.equal(h.listenerCount(), 0);
  h.change([spec("mcp__s__z")]);
  assert.equal(h.live.size, 0);
});
