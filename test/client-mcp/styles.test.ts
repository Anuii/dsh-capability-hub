/**
 * 样式一致性单测：
 *   1. 组件里引用的每一个 styles.xxx 都真的存在于 styles 表里（拼错就是静默无样式）；
 *   2. styles 表里每个类名在 CSS 字符串里都有对应规则（防止死类名）；
 *   3. CSS 里不出现硬编码颜色（只允许主题变量）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_CSS, styles } from "../../src/client/mcp/styles.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpDir = path.resolve(here, "..", "..", "src", "client", "mcp");

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(mcpDir);
  return out.filter((file) => !file.endsWith("styles.ts"));
}

test("组件里引用的 styles.x 都存在于样式表", () => {
  const known = new Set(Object.keys(styles));
  const missing: string[] = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?<!["/])styles\.([A-Za-z0-9_]+)/g)) {
      if (!known.has(match[1])) missing.push(path.basename(file) + " -> styles." + match[1]);
    }
  }
  assert.deepEqual([...new Set(missing)].sort(), []);
});

test("样式表里每个类名都有 CSS 规则", () => {
  const dead = Object.entries(styles)
    .filter(([, className]) => !MCP_CSS.includes("." + className + "{"))
    .map(([key, className]) => key + " (" + className + ")");
  assert.deepEqual(dead.sort(), []);
});

test("CSS 只用主题变量，没有硬编码颜色", () => {
  const hardcoded = MCP_CSS.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
  assert.deepEqual(hardcoded, [], "CSS 里出现了硬编码颜色，请改用 --dsw-* 变量");
  const plainColors = MCP_CSS.match(/:(?!\s*var\()\s*(red|blue|green|black|white|gray|grey)\b/g) ?? [];
  assert.deepEqual(plainColors, []);
});

test("样式表覆盖了关键容器类", () => {
  const keys = ["root", "field", "jsonTextarea", "settings", "dialogBody", "form", "actions", "importSection"] as const;
  for (const key of keys) {
    assert.ok(MCP_CSS.includes("." + styles[key] + "{"), key);
  }
});
