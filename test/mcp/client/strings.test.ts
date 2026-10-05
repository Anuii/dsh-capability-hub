/**
 * 字典一致性单测：
 *   1. 源码里出现的每一个 t("mcp.xxx") 都能在 strings.ts 的 zh 里找到（否则界面会渲染出 key）；
 *   2. zh 里的每个 key 都真的被用到（防止留下死文案）；
 *   3. 带 {占位符} 的文案，调用点必须传参数对象。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zh } from "../../../src/mcp/client/strings.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpDir = path.resolve(here, "..", "..", "..", "src", "mcp", "client");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // running/ 是「运行中」区域，有自己的字典（runtime.* / running.*），由它自己的测试检查。
      if (entry.name !== "running") out.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of sourceFiles(mcpDir)) {
    if (file.endsWith("strings.ts")) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bt\(\s*"([^"]+)"/g)) keys.add(match[1]);
    for (const match of text.matchAll(/\bt\(\s*'([^']+)'/g)) keys.add(match[1]);
  }
  return keys;
}

test("用到的每个 key 都在字典里", () => {
  const missing = [...usedKeys()].filter((key) => !(key in zh)).sort();
  assert.deepEqual(missing, [], "这些 key 在 strings.ts 里不存在：" + missing.join("、"));
});

test("字典里没有没被用到的 key", () => {
  const used = usedKeys();
  const orphans = Object.keys(zh).filter((key) => !used.has(key)).sort();
  assert.deepEqual(orphans, [], "这些 key 没有被任何组件使用：" + orphans.join("、"));
});

test("带占位符的文案，调用点都传了参数", () => {
  const withPlaceholder = Object.entries(zh).filter(([, text]) => /\{[a-zA-Z]+\}/.test(text));
  assert.ok(withPlaceholder.length > 0, "字典里应当有带占位符的文案");
  const problems: string[] = [];
  for (const [key] of withPlaceholder) {
    const pattern = new RegExp('t\\(\\s*"' + key.replace(/\./g, "\\.") + '"(\\s*,\\s*\\{)?', "g");
    for (const file of sourceFiles(mcpDir)) {
      if (file.endsWith("strings.ts")) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(pattern)) {
        if (match[1] === undefined) problems.push(path.basename(file) + " 里的 " + key + " 缺少模板参数");
      }
    }
  }
  assert.deepEqual(problems, []);
});
