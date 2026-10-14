/**
 * modules.ts 的阶段 B 接线表：上游缺失时下游**主动抛错**降级（D-F1「永不失败外壳」）。
 *
 * 只测降级分支：mcp-runtime 在「mcp-config 没加载」与「官方 MCP 插件加载失败」两种情况下的行为，
 * 以及 mcp-config 本身不受官方插件加载失败牵连。其余模块的接线由各自的功能测试覆盖。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFeatureModuleEntries,
  makeFeatureState,
  ModuleRegistry,
  type ModuleEntry,
} from "../../../src/platform/host/modules.ts";
import type { McpClientLoadState } from "../../../src/platform/host/mcp-client-loader.ts";
import type { HubContext, HubLogger } from "../../../src/platform/contract/host.ts";

function recordingLogger(): HubLogger & { lines: string[] } {
  const lines: string[] = [];
  const push =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(level + " " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  return { lines, debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") };
}

/** 只填模块真正会用到的字段，其余按 never 占位（这些分支不碰它们）。 */
function makeCtx(hubHome: string, logger: HubLogger): HubContext {
  return {
    homeDir: hubHome,
    dshHome: hubHome,
    hubHome,
    profileName: "test",
    logger,
    customSkillDirs: [],
  };
}

function entriesFor(options: { mcpClient: McpClientLoadState; hubHome: string; logger: HubLogger }): ModuleEntry[] {
  return createFeatureModuleEntries({
    ctx: makeCtx(options.hubHome, options.logger),
    mcpClient: options.mcpClient,
    root: {} as never,
    listTools: () => [],
    yaml: { status: "failed", message: "测试里不加载技能模块" } as never,
    state: makeFeatureState(),
  });
}

function entryNamed(entries: ModuleEntry[], name: string): ModuleEntry {
  const entry = entries.find((item) => item.name === name);
  assert.ok(entry !== undefined, "接线表里应该有 " + name);
  return entry;
}

describe("host modules: 依赖缺失时的降级", () => {
  it("官方 MCP 插件加载失败 ⇒ mcp-runtime 带着插件给的中文原因降级，不牵连其他模块", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "host-modules-test-"));
    const logger = recordingLogger();
    try {
      const reason = "加载 DSH 官方 MCP 插件（dsh-mcp-client）失败：Cannot find module";
      const ctx = makeCtx(dir, logger);
      const entries = entriesFor({
        mcpClient: { status: "failed", message: reason },
        hubHome: dir,
        logger,
      });
      // 按接线顺序加载：mcp-config 照常起来，mcp-runtime 因官方插件缺失而降级
      const registry = new ModuleRegistry(ctx, {});
      await registry.loadAll([entryNamed(entries, "mcp-config"), entryNamed(entries, "mcp-runtime")]);
      const configModule = registry.get<{ routes: Record<string, unknown> }>("mcp-config");
      assert.ok(configModule !== undefined, "mcp-config 不该因为官方插件缺失而降级");
      assert.ok(Object.keys(configModule.routes).length > 0, "mcp-config 照常注册路由");
      const degraded = registry.degraded();
      assert.equal(degraded.length, 1);
      assert.equal(degraded[0]?.name, "mcp-runtime");
      assert.equal(degraded[0]?.message, reason, "降级原因就是插件加载失败的中文原因");
      assert.match(logger.lines.join("\n"), /模块 mcp-runtime 加载失败，已降级/);
      assert.ok(registry.get("mcp-runtime") === undefined, "降级的模块不进 live 表");
      await registry.disposeAll();
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("mcp-config 没加载 ⇒ mcp-runtime 抛出「依赖 mcp-config 未加载」", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "host-modules-test-"));
    const logger = recordingLogger();
    try {
      const plugin = { Config: (input: Record<string, unknown>) => input, apply: () => {} };
      const entries = entriesFor({ mcpClient: { status: "loaded", plugin }, hubHome: dir, logger });
      const entry = entryNamed(entries, "mcp-runtime");
      assert.throws(() => entry.load(makeCtx(dir, logger)), {
        message: "依赖 mcp-config 未加载：缺少配置来源，MCP 服务器不会挂载",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
