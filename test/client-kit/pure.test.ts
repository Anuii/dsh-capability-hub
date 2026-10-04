/**
 * kit 纯逻辑的单测。
 *
 * 为什么只测纯逻辑：仓库里没有 jsdom，组件渲染测试的性价比太低；
 * 而「筛选计数、Enter 打开、Tab 环绕、Esc 关闭」这些**行为本身**都在 pure.ts 里，
 * 组件只负责把事件翻译成这些函数的输入 —— 所以这里测到的就是真实行为。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  clampBadges,
  countByPredicates,
  drawerIsFullWidth,
  drawerKey,
  drawerWidth,
  filterTestId,
  MAX_ROW_BADGES,
  passthroughAttrs,
  rowKeyDecision,
  searchFlag,
  SKELETON_ROWS,
  wrapIndex,
} from "../../src/client/shell/kit/pure.ts";

test("countByPredicates 统计每个分段下的条目数", () => {
  const rows = [
    { id: "a", enabled: true, broken: false, update: true },
    { id: "b", enabled: false, broken: true, update: false },
    { id: "c", enabled: true, broken: true, update: false },
  ];
  const counts = countByPredicates(rows, {
    all: () => true,
    enabled: (row) => row.enabled,
    disabled: (row) => !row.enabled,
    attention: (row) => row.broken || row.update,
  });
  assert.deepEqual(counts, { all: 3, enabled: 2, disabled: 1, attention: 3 });
});

test("countByPredicates 谓词表为空时返回空表（不炸）", () => {
  assert.deepEqual(countByPredicates([1, 2], {}), {});
  assert.deepEqual(countByPredicates([], { all: () => true }), { all: 0 });
});

test("行：Enter 与空格打开详情，其余键不管", () => {
  assert.deepEqual(rowKeyDecision("Enter"), { kind: "open" });
  assert.deepEqual(rowKeyDecision(" "), { kind: "open" });
  assert.deepEqual(rowKeyDecision("a"), { kind: "ignore" });
  assert.deepEqual(rowKeyDecision("Tab"), { kind: "ignore" });
  assert.deepEqual(rowKeyDecision("Escape"), { kind: "ignore" });
});

test("抽屉：Esc 关闭", () => {
  assert.deepEqual(drawerKey("Escape", false, 0, 3), { kind: "close" });
  assert.deepEqual(drawerKey("Esc", false, 0, 3), { kind: "close" });
});

test("抽屉：Tab 在内部环绕，Shift+Tab 反向", () => {
  // 0 -> 1 -> 2 -> 0
  assert.deepEqual(drawerKey("Tab", false, 0, 3), { kind: "focus", index: 1 });
  assert.deepEqual(drawerKey("Tab", false, 2, 3), { kind: "focus", index: 0 });
  // 2 -> 1 -> 0 -> 2
  assert.deepEqual(drawerKey("Tab", true, 2, 3), { kind: "focus", index: 1 });
  assert.deepEqual(drawerKey("Tab", true, 0, 3), { kind: "focus", index: 2 });
  // 单元素时原地不动
  assert.deepEqual(drawerKey("Tab", false, 0, 1), { kind: "focus", index: 0 });
});

test("抽屉：焦点不在列表里时，Tab 从头/尾进入", () => {
  assert.deepEqual(drawerKey("Tab", false, -1, 3), { kind: "focus", index: 0 });
  assert.deepEqual(drawerKey("Tab", true, -1, 3), { kind: "focus", index: 2 });
});

test("抽屉：没有可聚焦元素时原地困住，不把焦点漏出去", () => {
  assert.deepEqual(drawerKey("Tab", false, -1, 0), { kind: "trap" });
  assert.deepEqual(drawerKey("Tab", true, -1, 0), { kind: "trap" });
});

test("抽屉：其它键一概不管", () => {
  assert.deepEqual(drawerKey("a", false, 0, 3), { kind: "ignore" });
  assert.deepEqual(drawerKey("ArrowDown", false, 0, 3), { kind: "ignore" });
});

test("wrapIndex 环绕与空表", () => {
  assert.equal(wrapIndex(0, 4, false), 1);
  assert.equal(wrapIndex(3, 4, false), 0);
  assert.equal(wrapIndex(0, 4, true), 3);
  assert.equal(wrapIndex(-1, 4, false), 0);
  assert.equal(wrapIndex(-1, 4, true), 3);
  assert.equal(wrapIndex(0, 0, false), -1);
});

test("一行最多两个标记，多余的截掉", () => {
  assert.deepEqual(clampBadges(["a", "b", "c"]), ["a", "b"]);
  assert.deepEqual(clampBadges(["a"]), ["a"]);
  assert.deepEqual(clampBadges(undefined), []);
  assert.deepEqual(clampBadges(["a", "b", "c"], 0), []);
  assert.equal(MAX_ROW_BADGES, 2);
  assert.equal(SKELETON_ROWS, 6);
});

test("抽屉宽度：窄视口退化为整屏", () => {
  assert.equal(drawerWidth(1440), 560);
  assert.equal(drawerWidth(400), 400);
  assert.equal(drawerWidth(0), 560);
  assert.equal(drawerIsFullWidth(400), true);
  assert.equal(drawerIsFullWidth(1440), false);
  assert.equal(drawerIsFullWidth(0), false);
  assert.equal(drawerWidth(1440, 720), 720);
  assert.equal(drawerIsFullWidth(600, 720), true);
});

/* ---------------- UI-C 增量 ---------------- */

test("筛选分段的 testid：给了工具栏 testId 就不撞车", () => {
  assert.equal(filterTestId(undefined, "all"), "kit-filter-all");
  assert.equal(filterTestId("skills-toolbar", "all"), "skills-toolbar-filter-all");
  assert.equal(filterTestId("mcp-toolbar", "disabled"), "mcp-toolbar-filter-disabled");
  // 三个标签同时挂载时，同一套 id 在不同工具栏下互不相同
  const ids = ["skills-toolbar", "mcp-toolbar", "runtime-toolbar"].map((prefix) => filterTestId(prefix, "all"));
  assert.equal(new Set(ids).size, 3);
});

test("ListRow 的 attrs 只放行 data-* 与 aria-*", () => {
  assert.deepEqual(passthroughAttrs({ "data-repo": "a/b", "aria-expanded": "true" }), {
    "data-repo": "a/b",
    "aria-expanded": "true",
  });
  // 其余键一律忽略（不能被拿来绕开 kit 的样式与交互约定）
  assert.deepEqual(passthroughAttrs({ className: "x", style: "color:red", id: "y", onClick: "z" }), {});
  assert.deepEqual(passthroughAttrs(undefined), {});
  assert.deepEqual(passthroughAttrs({}), {});
  // 大小写敏感：只有真正的前缀才算
  assert.deepEqual(passthroughAttrs({ "Data-x": "1", "DATA-x": "1" }), {});
});

test("searchFlag 只认 URL 上显式打开的开关", () => {
  assert.equal(searchFlag("?hubKitPreview=1", "hubKitPreview"), true);
  assert.equal(searchFlag("hubKitPreview=1", "hubKitPreview"), true);
  assert.equal(searchFlag("?a=1&hubKitPreview=1", "hubKitPreview"), true);
  assert.equal(searchFlag("?hubKitPreview=0", "hubKitPreview"), false);
  assert.equal(searchFlag("?hubKitPreview=false", "hubKitPreview"), false);
  assert.equal(searchFlag("?hubKitPreview", "hubKitPreview"), false);
  assert.equal(searchFlag("", "hubKitPreview"), false);
  assert.equal(searchFlag("?other=1", "hubKitPreview"), false);
  assert.equal(searchFlag("?token=abc", "hubKitPreview"), false);
});
