/**
 * yaml-loader.ts：加载 DSH 自带的 yaml 库（ADR-0006）。永不 reject；拿不到时给中文原因，让技能模块降级。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as YAML from "yaml";
import { loadYaml } from "../../../src/platform/host/yaml-loader.ts";

test("能加载：命名导出与 default 导出两种形态都认", async () => {
  const named = await loadYaml(async () => YAML);
  assert.equal(named.status, "loaded");
  const wrapped = await loadYaml(async () => ({ default: YAML }));
  assert.equal(wrapped.status, "loaded");
});

test("加载失败或导出不完整：不抛，给中文原因", async () => {
  const missing = await loadYaml(async () => {
    throw new Error("Cannot find package 'yaml'");
  });
  assert.equal(missing.status, "failed");
  assert.match(missing.status === "failed" ? missing.message : "", /^DSH 自带的 yaml 库加载失败：Cannot find package/);
  const partial = await loadYaml(async () => ({ parseDocument() {} }));
  assert.equal(partial.status, "failed");
  assert.match(partial.status === "failed" ? partial.message : "", /缺少：visit, isMap, isSeq, isScalar, isPair/);
});
