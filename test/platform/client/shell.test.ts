/**
 * 外壳改造（UI-DESIGN §2）的源码级守卫。
 *
 * 这些是「结构事实」，没有浏览器也能钉住：
 *   - 去掉副标题；
 *   - 常驻诊断卡片不再出现在页面上（它只在「ⓘ」模态框里）；
 *   - 三个标签**同时挂载**，切换只改 hidden（否则标签状态会丢）；
 *   - 中英文字典 key 一一对应。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { en, zh } from "../../../src/platform/client/strings.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.resolve(here, "..", "..", "..", "src", "platform", "client");
const panel = fs.readFileSync(path.join(shellDir, "panel.tsx"), "utf8");
const applier = fs.readFileSync(path.join(shellDir, "applier.ts"), "utf8");

test("页头不再有副标题", () => {
  assert.equal(panel.includes("styles.subtitle"), false);
  assert.equal(panel.includes("panel.subtitle"), false);
  assert.equal(Object.keys(zh).includes("panel.subtitle"), false);
  assert.equal(Object.keys(en).includes("panel.subtitle"), false);
});

test("页头有「ⓘ」，它打开诊断模态框", () => {
  assert.ok(panel.includes('"data-testid": "capability-hub-info"'));
  assert.ok(panel.includes("setDiagnosticsOpen(true)"));
  assert.ok(panel.includes("Modal"));
});

test("诊断信息不再常驻：只有模态框正文带 data-testid=capability-hub-env", () => {
  const hits = panel.split('"data-testid": "capability-hub-env"').length - 1;
  assert.equal(hits, 1);
  // 它出现在 DiagnosticsBody 里，而 DiagnosticsBody 只被 Modal 使用
  assert.ok(panel.indexOf("function DiagnosticsBody") < panel.indexOf('"data-testid": "capability-hub-env"'));
  assert.ok(panel.includes("}, React.createElement(DiagnosticsBody, {"));
});

test("三个标签同时挂载，切换只改 hidden（状态不丢）", () => {
  assert.ok(panel.includes("hidden: tab !== entry.id"));
  assert.ok(panel.includes("role: \"tabpanel\""));
  assert.ok(panel.includes("aria-labelledby"));
  // 没有任何「按 tab 条件渲染」的写法
  assert.equal(/tab === "skills"\s*\?/.test(panel), false);
});

test("降级横幅只在有降级时渲染，并且带「查看详情」", () => {
  assert.ok(panel.includes("degrade === undefined"));
  assert.ok(panel.includes('"capability-hub-degraded"'));
  assert.ok(panel.includes('testId: "capability-hub-degraded-details"'));
});

test("kit 样式由 applier 统一注入一次", () => {
  assert.ok(applier.includes("injectKitStyles"));
  assert.equal(applier.split("injectKitStyles()").length - 1, 1);
});

test("中英文字典的 key 一一对应", () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

test("kit 预览只在 URL 带 hubKitPreview 时出现", () => {
  assert.ok(panel.includes("kitPreviewEnabled"));
  assert.ok(panel.includes("KitPreview"));
  assert.ok(panel.includes("hubKitPreview"));
});
