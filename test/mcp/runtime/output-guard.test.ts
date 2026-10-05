/** 输出护栏边界：行数、字节、UTF-8 多字节边界、spill 文件。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyOutputGuard,
  countLines,
  createSpillWriter,
  cutAtBytes,
  humanBytes,
} from "../../../src/mcp/runtime/atoms/output-guard.ts";
import { makeTempHome } from "./helpers.ts";

const SETTINGS = { enabled: true, maxBytes: 51200, maxLines: 2000 };

test("未超出上限时原样返回，不写 spill", async () => {
  const outcome = await applyOutputGuard("hello\nworld", SETTINGS);
  assert.equal(outcome.truncated, false);
  assert.equal(outcome.text, "hello\nworld");
  assert.equal(outcome.spillPath, undefined);
});

test("行数超限时保头部（先按行）", async () => {
  const text = Array.from({ length: 10 }, (_, i) => "line" + i).join("\n");
  const outcome = await applyOutputGuard(text, { enabled: true, maxBytes: 1024 * 1024, maxLines: 3 });
  assert.equal(outcome.truncated, true);
  assert.ok(outcome.text.startsWith("line0\nline1\nline2"));
  assert.ok(outcome.text.includes("已被截断"));
  assert.equal(outcome.shownLines, 3);
  assert.equal(outcome.originalLines, 10);
});

test("字节超限时保头部（再按字节）", async () => {
  const text = "x".repeat(1000);
  const outcome = await applyOutputGuard(text, { enabled: true, maxBytes: 100, maxLines: 2000 });
  assert.equal(outcome.truncated, true);
  assert.ok(outcome.shownBytes <= 100);
  assert.ok(outcome.text.startsWith("x".repeat(100)));
});

test("字节切割不截断 UTF-8 多字节字符", async () => {
  // 每个汉字 3 字节；100 字节正好落在第 34 个字符中间。
  const text = "汉".repeat(100);
  const outcome = await applyOutputGuard(text, { enabled: true, maxBytes: 100, maxLines: 0 });
  const shown = outcome.text.slice(0, outcome.text.indexOf("\n\n[能力中心"));
  assert.equal(Buffer.byteLength(shown, "utf8") % 3, 0);
  assert.ok(!shown.includes("\uFFFD"), "不应出现替换字符");
  assert.equal(shown, "汉".repeat(33));
});

test("cutAtBytes 在续字节处回退", () => {
  const text = "aé"; // 'a' + U+00E9(2 字节)
  assert.equal(cutAtBytes(text, 1), "a");
  assert.equal(cutAtBytes(text, 2), "a");
  assert.equal(cutAtBytes(text, 3), "aé");
});

test("护栏关闭时不做任何截断", async () => {
  const text = "y".repeat(10_000);
  const outcome = await applyOutputGuard(text, { enabled: false, maxBytes: 10, maxLines: 1 });
  assert.equal(outcome.truncated, false);
  assert.equal(outcome.text, text);
});

test("超出时写 spill 文件，并把路径告诉模型", async () => {
  const home = await makeTempHome("spill");
  try {
    const spill = createSpillWriter(join(home.hubHome, "mcp", "spill"));
    const text = "z".repeat(50_000);
    const outcome = await applyOutputGuard(text, { enabled: true, maxBytes: 512, maxLines: 2000 }, spill);
    assert.equal(outcome.truncated, true);
    assert.ok(outcome.spillPath, "应当给出 spill 路径");
    assert.ok(outcome.text.includes(outcome.spillPath as string));
    const saved = await readFile(outcome.spillPath as string, "utf8");
    assert.equal(saved, text, "spill 里必须是完整内容");
    await spill.cleanup();
  } finally {
    await home.cleanup();
  }
});

test("spill 超过 16 MiB 时截断并注明", async () => {
  const home = await makeTempHome("spill-big");
  try {
    const spill = createSpillWriter(join(home.hubHome, "mcp", "spill"));
    const text = "q".repeat(17 * 1024 * 1024);
    const path = await spill.write(text);
    const saved = await readFile(path, "utf8");
    assert.ok(saved.length <= 17 * 1024 * 1024);
    assert.ok(saved.includes("spill 文件本身已被截断"));
    await spill.cleanup();
  } finally {
    await home.cleanup();
  }
});

test("spill 只保留最近 50 个文件", async () => {
  const home = await makeTempHome("spill-prune");
  try {
    const spill = createSpillWriter(join(home.hubHome, "mcp", "spill"));
    for (let i = 0; i < 55; i += 1) await spill.write("file-" + i);
    const { readdir } = await import("node:fs/promises");
    const names = await readdir(join(home.hubHome, "mcp", "spill"));
    assert.equal(names.length, 50);
    await spill.cleanup();
  } finally {
    await home.cleanup();
  }
});

test("spill 写不进去时降级为提示，不抛异常", async () => {
  const failing = {
    write: async () => {
      throw new Error("磁盘满了");
    },
  };
  const outcome = await applyOutputGuard("w".repeat(1000), { enabled: true, maxBytes: 10, maxLines: 0 }, failing);
  assert.equal(outcome.truncated, true);
  assert.ok(outcome.text.includes("完整内容未能保存：磁盘满了"));
});

test("countLines / humanBytes 的边界", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(humanBytes(51200), "50.0 KiB");
  assert.equal(humanBytes(2 * 1024 * 1024), "2.0 MiB");
});
