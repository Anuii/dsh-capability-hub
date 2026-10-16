/**
 * view-model.ts 的纯逻辑单测：格式化、分组、一行副标题的各种情形、底部合计、新建位置可用性。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  budgetText,
  budgetTitle,
  createOptions,
  defaultCreateLocation,
  formatBudgetBytes,
  formatBytes,
  formatDateTime,
  groupPrompts,
  layerLabel,
  promptRowView,
} from "../../../src/prompts/client/view-model.ts";
import { makeFile, makeLayer, makeList } from "./fixtures.ts";

test("formatBytes / formatBudgetBytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(12), "12 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1_048_576), "1.0 MB");
  assert.equal(formatBytes(Number.NaN), "0 B");
  assert.equal(formatBudgetBytes(65536), "64 KB");
  assert.equal(formatBudgetBytes(1311), "1.3 KB");
  assert.equal(formatBudgetBytes(0), "0 KB");
});

test("formatDateTime：解析不了就原样返回", () => {
  assert.match(formatDateTime("2026-10-16T12:34:00Z"), /^2026-10-16 \d{2}:\d{2}$/);
  assert.equal(formatDateTime("不是时间"), "不是时间");
});

test("layerLabel：工作区优先于项目根，其余用相对路径", () => {
  assert.equal(layerLabel(makeLayer({ isProjectRoot: true, isWorkspace: true })), "当前工作区");
  assert.equal(layerLabel(makeLayer({ isProjectRoot: true, isWorkspace: false })), "项目根");
  assert.equal(
    layerLabel(makeLayer({ isProjectRoot: false, isWorkspace: false, displayDir: "packages/a" })),
    "packages/a",
  );
});

test("分组：全局一组、当前工作区一组；组内每行带所在层与文件名", () => {
  const list = makeList({
    layers: [
      makeLayer({
        scope: "global",
        displayDir: "~/.dsh",
        isProjectRoot: false,
        files: [makeFile({ name: "AGENTS.md", displayPath: "~/.dsh/AGENTS.md" })],
      }),
      makeLayer({
        displayDir: ".",
        isProjectRoot: true,
        files: [makeFile({ name: "CLAUDE.md" })],
      }),
      makeLayer({
        dir: "C:\\proj\\packages\\a",
        displayDir: "packages/a",
        isProjectRoot: false,
        isWorkspace: true,
        files: [makeFile({ name: "AGENTS.local.md" })],
      }),
    ],
  });
  const groups = groupPrompts(list);
  assert.deepEqual(
    groups.map((group) => group.id),
    ["global", "workspace"],
  );
  assert.equal(groups[0].title, "全局");
  assert.equal(groups[0].count, "1 个");
  assert.equal(groups[0].rows[0].title, "AGENTS.md");
  assert.match(groups[0].rows[0].subtitle, /^500 B$/);
  assert.equal(groups[1].rows.length, 2);
  assert.match(groups[1].rows[0].subtitle, /^项目根 · 500 B$/);
  assert.match(groups[1].rows[1].subtitle, /^当前工作区 · 500 B$/);
});

test("没有工作区时：工作区组只有一句说明", () => {
  const list = makeList({
    layers: [makeLayer({ scope: "global", isProjectRoot: false, displayDir: "~/.dsh" })],
    inGit: false,
  });
  const groups = groupPrompts(list);
  assert.equal(groups[1].rows.length, 0);
  assert.match(groups[1].note ?? "", /没有工作区/);
});

test("一行副标题的各情形：已停用 / 与 AGENTS.md 相同 / 超过 1 MiB / 超出预算", () => {
  assert.match(promptRowView(makeFile({ disabled: true })).subtitle, /已停用/);
  assert.match(promptRowView(makeFile({ duplicateOf: "AGENTS.md" })).subtitle, /与 AGENTS.md 相同，DSH 只加载一份/);
  assert.match(promptRowView(makeFile({ tooLarge: true })).subtitle, /超过 1 MiB，DSH 不加载/);
  assert.match(promptRowView(makeFile({ size: 40960, budget: "omitted" })).subtitle, /约 40 KB 超出预算，DSH 会省略/);
  assert.match(promptRowView(makeFile({ size: 40960, budget: "truncated" })).subtitle, /约 40 KB 超出预算，DSH 会截断/);
  const view = promptRowView(makeFile({ disabled: true, duplicateOf: "CLAUDE.md", tooLarge: true }));
  assert.equal(view.toggle.checked, false);
  assert.match(view.subtitleTitle, /AGENTS\.md/);
});

test("底部合计：约 xx KB / 64 KB；loaderDisabled 时改成说明", () => {
  const list = makeList({ budget: { maxBytes: 65536, usedBytes: 1311, source: "dsh-config" } });
  assert.equal(budgetText(list), "约 1.3 KB / 64 KB");
  assert.match(budgetTitle(list), /组合配置/);
  const off = makeList({ loaderDisabled: true });
  assert.match(budgetText(off), /加载已关闭/);
  assert.match(budgetTitle(makeList({ budget: { maxBytes: 65536, usedBytes: 0, source: "default" } })), /默认值/);
});

test("新建位置由 canCreate 推出：三个都列出来，不可用的置灰并说明原因", () => {
  const list = makeList({
    layers: [
      makeLayer({ scope: "global", displayDir: "~/.dsh", isProjectRoot: false, canCreate: false }),
      makeLayer({ isProjectRoot: true, isWorkspace: false, canCreate: true }),
      makeLayer({
        dir: "C:\\proj\\packages\\a",
        displayDir: "packages/a",
        isProjectRoot: false,
        isWorkspace: true,
        canCreate: false,
      }),
    ],
  });
  const options = createOptions(list);
  assert.deepEqual(
    options.map((option) => option.location),
    ["global", "project-root", "workspace"],
  );
  assert.equal(options[0].disabled, true);
  assert.match(options[0].reason ?? "", /已经有 AGENTS\.md/);
  assert.equal(options[1].disabled, false);
  assert.equal(defaultCreateLocation(options), "project-root");
  assert.equal(options[2].disabled, true);
  assert.equal(options[2].hint, "C:\\proj\\packages\\a");
});

test("全局层不在列表里：全局位置也不可用，并说明原因", () => {
  const options = createOptions(makeList({ layers: [makeLayer({ isProjectRoot: false })] }));
  assert.equal(options[0].disabled, true);
  assert.match(options[0].reason ?? "", /不可用/);
});

test("没有工作区：项目两个位置都不可用，原因是没有工作区", () => {
  const options = createOptions(
    makeList({ layers: [makeLayer({ scope: "global", isProjectRoot: false, canCreate: true })] }),
  );
  assert.equal(options[0].disabled, false);
  assert.equal(options[1].disabled, true);
  assert.equal(options[2].disabled, true);
  assert.match(options[1].reason ?? "", /没有当前会话工作区/);
  assert.equal(options[1].testId, "prompts-create-location-project-root");
});
