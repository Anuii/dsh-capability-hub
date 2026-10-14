/**
 * 降级横幅的判定（UI-DESIGN §2）：一切正常时**必须**返回 undefined ——
 * 否则页头下方会常驻一条横幅，正是这次要消灭的东西。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { degradeInfo, hostVersionMismatch } from "../../../src/platform/client/degrade.ts";
import type { HealthPayload } from "../../../src/platform/client/api.ts";

function health(overrides: { modules?: Array<{ name: string; status: string }> }): HealthPayload {
  return {
    ok: true,
    plugin: "dsh-capability-hub",
    profileName: "capability-hub-dev",
    homeDir: "H",
    dshHome: "D",
    hubHome: "U",
    profileDir: "P",
    customSkillDirs: [],
    bundledSkillDir: null,
    mcpClient: { status: "loaded", version: "0.2.0" },
    modules: (overrides.modules ?? [{ name: "health", status: "ok" }]).map((module) => ({ ...module, routes: [] })),
    mcpServers: [],
    host: { pid: 1, nodeVersion: "24", startedAt: "" },
    wiring: { lockStashBound: true, notes: [] },
    serverTime: "",
  } as HealthPayload;
}

test("health 还没到时不显示横幅", () => {
  assert.equal(degradeInfo(undefined), undefined);
});

test("一切正常时不显示横幅（还没配置服务器也不算降级）", () => {
  assert.equal(degradeInfo(health({})), undefined);
});

test("有模块降级时列出模块名（DSH 官方 MCP 插件加载不了时就是 mcp-runtime 降级）", () => {
  const info = degradeInfo(
    health({
      modules: [
        { name: "health", status: "ok" },
        { name: "mcp-config", status: "degraded" },
        { name: "mcp-runtime", status: "degraded" },
      ],
    }),
  );
  assert.deepEqual(info, { degraded: ["mcp-config", "mcp-runtime"] });
});

test("升级后没重启：宿主与浏览器半版本不一致时给出提示；一致、开发构建或没有 health 时不提示", () => {
  const base = health({});
  const withHost = (pluginVersion?: string): HealthPayload => ({
    ...base,
    host: { ...base.host, ...(pluginVersion === undefined ? {} : { pluginVersion }) },
  });
  assert.equal(hostVersionMismatch(undefined, "0.3.1"), undefined);
  assert.equal(hostVersionMismatch(withHost("0.3.1"), "0.3.1"), undefined);
  assert.equal(hostVersionMismatch(withHost("0.3.0"), "0.3.1"), "0.3.0");
  assert.equal(hostVersionMismatch(withHost(), "0.3.1"), "旧版本", "0.3.0 及更早的宿主没有 pluginVersion");
  assert.equal(hostVersionMismatch(withHost("0.3.0"), "dev"), undefined, "直接跑源码（单测）不比对");
});
