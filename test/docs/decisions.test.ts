/**
 * docs/DECISIONS.md 的结构检查（本文件由 retro 加）：决策表是代码注释里 `D-xx` 的唯一解释来源，
 * 手写表格最容易出的两类错——**重复 id** 与**段内乱序**——用测试钉住，不让它们再靠人眼发现。
 *
 * 只检查可机械判定的部分：id 唯一、同一段内编号严格递增、每行至少两列。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const file = path.join(repoRoot, "docs", "DECISIONS.md");

/** 一行决策：| D-B18 | 正文 | */
const ROW = /^\|\s*(D-[A-Z][0-9]+)\s*\|/;

test("DECISIONS：决策 id 唯一、每段按编号递增、每行至少两列", () => {
  const lines = readFileSync(file, "utf8").split("\n");
  const seen = new Set();
  /** 当前段（## A. …）里上一个编号 */
  const lastInSection = new Map();
  let section = "(开头)";
  lines.forEach((line, index) => {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading !== null) {
      section = heading[1].trim();
      return;
    }
    const match = ROW.exec(line);
    if (match === null) return;
    const id = match[1];
    const where = "docs/DECISIONS.md:" + String(index + 1) + " 的 " + id;
    assert.equal(seen.has(id), false, where + " 重复出现（id 必须唯一）");
    seen.add(id);
    assert.equal(line.split("|").length >= 3, true, where + " 至少要有 id 与正文两列");
    const number = Number(id.slice(3));
    const previous = lastInSection.get(section);
    if (previous !== undefined) {
      assert.equal(
        number > previous,
        true,
        where + " 在「" + section + "」里乱序：上一个编号是 " + String(previous) + "，应递增",
      );
    }
    lastInSection.set(section, number);
  });
});
