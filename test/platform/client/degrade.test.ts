/**
 * 降级横幅的判定（UI-DESIGN §2）：一切正常时**必须**返回 undefined ——
 * 否则页头下方会常驻一条横幅，正是这次要消灭的东西。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { degradeInfo, degradeNames, hostVersionMismatch } from "../../../src/platform/client/degrade.ts";
import type { HealthPayload } from "../../../src/platform/client/api.ts";

function health(overrides: {
  modules?: Array<{ name: string; status: string }>;
  registered?: boolean;
  runtimeSource?: "real" | "stub";
}): HealthPayload {
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
    sdk: { status: "loaded" },
    modules: (overrides.modules ?? [{ name: "demo", status: "ok" }]).map((module) => ({ ...module, routes: [] })),
    tool: { registered: overrides.registered ?? true, name: "mcp", description: "" },
    host: { pid: 1, nodeVersion: "24", startedAt: "" },
    sessionEvents: [],
    ...(overrides.runtimeSource === undefined
      ? {}
      : {
          wiring: { runtimeSource: overrides.runtimeSource, lockStashBound: true, runtimeStarted: true, notes: [] },
        }),
    serverTime: "",
  } as HealthPayload;
}

test("health 还没到时不显示横幅", () => {
  assert.equal(degradeInfo(undefined), undefined);
});

test("一切正常时不显示横幅（首屏常驻元素只有页头 / 标签 / 工具栏 / 列表）", () => {
  assert.equal(degradeInfo(health({})), undefined);
  assert.equal(degradeInfo(health({ runtimeSource: "real" })), undefined);
});

test("有模块降级时列出模块名", () => {
  const info = degradeInfo(
    health({
      modules: [
        { name: "demo", status: "ok" },
        { name: "mcp-runtime", status: "degraded" },
      ],
      runtimeSource: "real",
    }),
  );
  assert.deepEqual(info, { degraded: ["mcp-runtime"], stubTool: false });
  assert.deepEqual(degradeNames(info!, "mcp 工具"), ["mcp-runtime"]);
});

test("mcp 工具退回桩实现也算降级", () => {
  const info = degradeInfo(health({ runtimeSource: "stub" }));
  assert.deepEqual(info, { degraded: [], stubTool: true });
  assert.deepEqual(degradeNames(info!, "mcp 工具"), ["mcp 工具"]);
});

test("mcp 工具没注册也算降级", () => {
  const info = degradeInfo(health({ registered: false }));
  assert.equal(info?.stubTool, true);
});

test("模块降级 + 工具退回桩：两个名字都进横幅", () => {
  const info = degradeInfo(
    health({
      modules: [
        { name: "mcp-config", status: "degraded" },
        { name: "mcp-runtime", status: "degraded" },
      ],
      runtimeSource: "stub",
    }),
  );
  assert.deepEqual(degradeNames(info!, "mcp 工具"), ["mcp-config", "mcp-runtime", "mcp 工具"]);
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
