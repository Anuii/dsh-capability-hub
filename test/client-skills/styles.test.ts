/**
 * 样式一致性单测（没有构建、没有浏览器时的第一道防线）：
 *   1. 组件里引用的每一个 styles.xxx 都真的存在于 styles 表里（拼错就是静默无样式）；
 *   2. styles 表里每个类名在 CSS 字符串里都有对应规则（防止死类名）；
 *   3. CSS 里不出现硬编码颜色（只允许主题变量），否则暗色/亮色主题会崩；
 *   4. UI-A 之后本标签页只该剩下 kit 没有的形态 —— 列表/工具栏/抽屉/标记的类不该再出现。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILLS_CSS, styles } from "../../src/client/skills/styles.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = path.resolve(here, "..", "..", "src", "client", "skills");

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) out.push(full);
    }
  };
  walk(skillsDir);
  return out;
}

test("组件里引用的 styles.x 都存在于样式表", () => {
  const known = new Set(Object.keys(styles));
  const missing: string[] = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, "utf8");
    // 只看 `styles.xxx` 的用法（排除 import 里的 ".../styles.ts" 路径）
    for (const match of text.matchAll(/(?<!["/])styles\.([A-Za-z0-9_]+)/g)) {
      if (!known.has(match[1]!)) missing.push(path.basename(file) + " -> styles." + match[1]);
    }
  }
  assert.deepEqual([...new Set(missing)].sort(), []);
});

test("样式表里每个类名都有 CSS 规则", () => {
  const dead = Object.entries(styles)
    .filter(([, className]) => !SKILLS_CSS.includes("." + className + "{"))
    .map(([key, className]) => key + " (" + className + ")");
  assert.deepEqual(dead.sort(), []);
});

test("CSS 只用主题变量，没有硬编码颜色", () => {
  const hardcoded = SKILLS_CSS.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
  assert.deepEqual(hardcoded, [], "CSS 里出现了硬编码颜色，请改用 --dsw-* 变量");
  const plainColors = SKILLS_CSS.match(/:(?!\s*var\()\s*(red|blue|green|black|white|gray|grey)\b/g) ?? [];
  assert.deepEqual(plainColors, []);
});

test("UI-A 起本目录只保留 kit 没有的形态", () => {
  const keys = ["root", "errorBox", "note", "diag", "files", "codeWrap", "pathWrap", "form", "browseList", "modalBody", "repoRow", "repoGrow", "refGrow", "chip", "chipRemove"] as const;
  for (const key of keys) {
    assert.ok(SKILLS_CSS.includes("." + styles[key] + "{"), key);
  }
  // 列表 / 工具栏 / 抽屉 / 标记一律用 kit：本目录不该再定义这些类
  const forbidden = ["row", "toolbar", "banner", "empty", "trashList", "nav", "group", "badge"];
  for (const key of forbidden) {
    assert.equal(Object.hasOwn(styles, key), false, "样式表里不该再有 " + key + "（kit 提供）");
  }
});
