/**
 * yaml-loader.ts：加载 DSH 判断技能能否加载时用的那份 yaml（ADR-0006）。永不 reject。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as YAML from "yaml";
import { loadYaml } from "../../../src/platform/host/yaml-loader.ts";

const fail = (message: string) => async (): Promise<never> => {
  throw new Error(message);
};

test("优先用 dsh-skill-filesystem 旁边的那份，并报版本", async () => {
  const state = await loadYaml({
    besideSkillFilesystem: async () => ({ module: YAML, version: "2.9.1" }),
    importYaml: fail("不该走到这里"),
  });
  assert.equal(state.status, "loaded");
  assert.equal(state.status === "loaded" && state.source, "dsh-skill-filesystem");
  assert.equal(state.status === "loaded" && state.version, "2.9.1");
});

test("找不到 dsh-skill-filesystem 时退回动态 import；default 导出也认", async () => {
  const state = await loadYaml({
    besideSkillFilesystem: fail("no anchor"),
    importYaml: async () => ({ default: YAML }),
  });
  assert.equal(state.status === "loaded" && state.source, "import");
});

test("两种都失败：不抛，给中文原因（两处原因都在）", async () => {
  const state = await loadYaml({
    besideSkillFilesystem: fail("no anchor"),
    importYaml: async () => ({ parseDocument() {} }),
  });
  assert.equal(state.status, "failed");
  const message = state.status === "failed" ? state.message : "";
  assert.match(
    message,
    /^DSH 自带的 yaml 库加载失败：no anchor；导出不完整，缺少：visit, isMap, isSeq, isScalar, isPair$/,
  );
});
