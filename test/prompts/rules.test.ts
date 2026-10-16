/**
 * 规则层（src/prompts/rules）：文件名与顺序、同层重复、预算估算、trashId。
 * 纯函数，不碰文件系统。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateNames,
  DEFAULT_INSTRUCTION_FILE_CANDIDATES,
  DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES,
  disabledNameOf,
  GLOBAL_FILE_NAME,
} from "../../src/prompts/rules/names.ts";
import { duplicatesOf } from "../../src/prompts/rules/duplicate.ts";
import { byteLengthOf, costOf, estimateBudget, instructionHeader } from "../../src/prompts/rules/budget.ts";
import { isValidTrashId, TRASH_ID_PATTERN } from "../../src/prompts/rules/trash-id.ts";

test("提示词规则：候选名默认值与 DSH 一致，顺序 = instruction 接 local", () => {
  assert.deepEqual([...DEFAULT_INSTRUCTION_FILE_CANDIDATES], ["AGENTS.md", "CLAUDE.md"]);
  assert.deepEqual([...DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES], ["AGENTS.local.md", "CLAUDE.local.md"]);
  assert.deepEqual(
    candidateNames({
      instructionFileCandidates: DEFAULT_INSTRUCTION_FILE_CANDIDATES,
      localInstructionFileCandidates: DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES,
    }),
    ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"],
  );
  assert.equal(GLOBAL_FILE_NAME, "AGENTS.md");
  // 配置改过时顺序跟着配置走（不写死）
  assert.deepEqual(
    candidateNames({ instructionFileCandidates: ["X.md"], localInstructionFileCandidates: ["Y.local.md"] }),
    ["X.md", "Y.local.md"],
  );
});

test("提示词规则：停用态的文件名 = 原名 + .disabled", () => {
  assert.equal(disabledNameOf("AGENTS.md"), "AGENTS.md.disabled");
  assert.equal(disabledNameOf("CLAUDE.local.md"), "CLAUDE.local.md.disabled");
});

test("提示词规则：同层重复 —— 后出现的标先出现的那个文件名", () => {
  assert.deepEqual(duplicatesOf([{ name: "AGENTS.md", digest: "a" }]), [undefined]);
  assert.deepEqual(
    duplicatesOf([
      { name: "AGENTS.md", digest: "a" },
      { name: "CLAUDE.md", digest: "b" },
      { name: "AGENTS.local.md", digest: "a" },
    ]),
    [undefined, undefined, "AGENTS.md"],
  );
});

test("提示词规则：预算估算 —— 不超预算不标记；超了从最前 omitted；只剩最后一个仍超就 truncated", () => {
  const header = instructionHeader("AGENTS.md");
  assert.equal(header, "Instructions from: AGENTS.md\n\n");
  const headerBytes = byteLengthOf(header);

  const one = { name: "AGENTS.md", displayPath: "AGENTS.md", bytes: 100 };
  assert.equal(costOf(one), 100 + headerBytes);

  // 不超预算
  const fit = estimateBudget([one, { ...one, displayPath: "CLAUDE.md" }], 10_000);
  assert.deepEqual(fit.marks, [undefined, undefined]);
  assert.equal(fit.omitted, 0);
  assert.equal(fit.truncated, false);
  assert.equal(fit.usedBytes, (100 + headerBytes) * 2);

  // 刚好放得下最后一个：前面的全丢
  const tight = estimateBudget([one, { ...one, displayPath: "CLAUDE.md" }], 100 + headerBytes);
  assert.deepEqual(tight.marks, ["omitted", undefined]);
  assert.equal(tight.omitted, 1);
  assert.equal(tight.truncated, false);

  // 只剩最后一个仍超出：标 truncated（不丢光）
  const tiny = estimateBudget([one, { ...one, displayPath: "CLAUDE.md" }], 50);
  assert.deepEqual(tiny.marks, ["omitted", "truncated"]);
  assert.equal(tiny.omitted, 1);
  assert.equal(tiny.truncated, true);

  // 只有一个文件且超预算：truncated
  const solo = estimateBudget([one], 10);
  assert.deepEqual(solo.marks, ["truncated"]);
  assert.equal(solo.truncated, true);

  // 没有候选：什么都不标
  const empty = estimateBudget([], 0);
  assert.deepEqual(empty.marks, []);
  assert.equal(empty.usedBytes, 0);
});

test("提示词规则：trashId 必须是安全单段名", () => {
  assert.equal(isValidTrashId("20261016T224300123Z-ab12cd"), true);
  assert.equal(isValidTrashId("a"), true);
  assert.equal(isValidTrashId("."), false);
  assert.equal(isValidTrashId(".."), false);
  assert.equal(isValidTrashId(".hidden"), false);
  assert.equal(isValidTrashId("a/b"), false);
  assert.equal(isValidTrashId("a\\b"), false);
  assert.equal(isValidTrashId("a\u0000b"), false);
  assert.equal(isValidTrashId(""), false);
  assert.equal(isValidTrashId("x".repeat(65)), false);
  assert.equal(isValidTrashId(42), false);
  assert.equal(TRASH_ID_PATTERN.test("20261016T224300123Z-ab12cd"), true);
});
