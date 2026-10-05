import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  hashFiles,
  hashLocalDirectory,
  hashTarDirectory,
  recordedHash,
  hashesEqual,
  toCrlf,
  isProbablyBinary,
} from "../../../src/skills/remote/hash.ts";
import { locateSkillDirectory, readTarEntries } from "../../../src/skills/remote/tar.ts";
import { buildTar } from "./tarfixture.ts";
import { makeTempDir, writeTree } from "./helpers.ts";

test("排序按 localeCompare、路径与内容都参与哈希", () => {
  // 与 npx skills 的算法一致：hash.update(relativePath) + hash.update(content)
  const files = [
    { rel: "b.txt", data: Buffer.from("2") },
    { rel: "a.txt", data: Buffer.from("1") },
  ];
  const manual = createHash("sha256").update("a.txt").update("1").update("b.txt").update("2").digest("hex");
  assert.equal(hashFiles(files).raw, manual);
  // 顺序不影响结果
  assert.equal(hashFiles([...files].reverse()).raw, manual);
});

test("改名（内容不变）会改变哈希", () => {
  const a = hashFiles([{ rel: "a.txt", data: Buffer.from("x") }]).raw;
  const b = hashFiles([{ rel: "b.txt", data: Buffer.from("x") }]).raw;
  assert.notEqual(a, b);
});

test("本地目录哈希跳过 .git 与 node_modules（任意层级）", async () => {
  const dir = makeTempDir();
  await writeTree(dir, {
    "SKILL.md": "body",
    "agents/openai.yaml": "name: x",
    ".git/config": "should-be-ignored",
    "node_modules/pkg/index.js": "ignored",
    "nested/node_modules/x.js": "ignored",
    "nested/keep.md": "kept",
  });
  const result = await hashLocalDirectory(dir);
  const expected = hashFiles([
    { rel: "SKILL.md", data: Buffer.from("body") },
    { rel: "agents/openai.yaml", data: Buffer.from("name: x") },
    { rel: "nested/keep.md", data: Buffer.from("kept") },
  ]);
  assert.equal(result.raw, expected.raw);
  assert.equal(result.fileCount, 3);
});

test("__pycache__ 不排除（与 npx skills 算法一致）", async () => {
  const dir = makeTempDir();
  await writeTree(dir, { "SKILL.md": "a", "__pycache__/x.pyc": "bin" });
  const result = await hashLocalDirectory(dir);
  assert.equal(result.fileCount, 2);
});

test("CRLF 规范化：文本文件 LF→CRLF 后哈希变化，二进制不变", () => {
  const text = Buffer.from("line1\nline2\n");
  const crlf = toCrlf(text);
  assert.equal(crlf.toString("binary"), "line1\r\nline2\r\n");
  const binary = Buffer.from([0x00, 0x0a, 0xff]);
  assert.equal(isProbablyBinary(binary), true);
  assert.equal(isProbablyBinary(text), false);

  const files = [{ rel: "a.txt", data: text }];
  const hashes = hashFiles(files);
  assert.notEqual(hashes.raw, hashes.normalized);
  assert.equal(hashes.normalized, hashFiles([{ rel: "a.txt", data: crlf }]).raw);
});

test("tar 内目录哈希与「解压到本地」的哈希一致", async () => {
  const tar = buildTar([
    { path: "r/", type: "dir" },
    { path: "r/skills/x/SKILL.md", data: "body\n" },
    { path: "r/skills/x/a/b.md", data: "nested" },
    { path: "r/skills/y/SKILL.md", data: "other" },
  ]);
  const entries = readTarEntries(tar);
  const fromTar = hashTarDirectory(entries, "skills/x");

  const dir = makeTempDir();
  await writeTree(dir, { "SKILL.md": "body\n", "a/b.md": "nested" });
  const fromDisk = await hashLocalDirectory(dir);
  assert.equal(fromTar.raw, fromDisk.raw);
  assert.equal(fromTar.normalized, fromDisk.normalized);
});

test("hashesEqual：raw 或 normalized 任一相等即视为无变化", () => {
  const files = hashFiles([{ rel: "SKILL.md", data: Buffer.from("a\nb\n") }]);
  assert.equal(hashesEqual(files, files.raw), true);
  assert.equal(hashesEqual(files, files.normalized), true);
  assert.equal(hashesEqual(files, "deadbeef"), false);
  assert.equal(hashesEqual(files, undefined), false);
  assert.equal(recordedHash(files), files.normalized);
});

test("真实数据回归：6 条 lock 条目与「上游 tar + CRLF 规范化」逐条吻合", async (t) => {
  if (process.env["RUN_LIVE"] !== "1") {
    t.skip("设置 RUN_LIVE=1 才执行（需要访问 codeload.github.com）");
    return;
  }
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const lockPath = path.join(os.homedir(), ".agents", ".skill-lock.json");
  const raw = await fs.readFile(lockPath, "utf8");
  const lock = JSON.parse(raw) as {
    skills: Record<string, { source: string; skillPath: string; skillFolderHash: string }>;
  };

  const cache = new Map<string, ReturnType<typeof readTarEntries>>();
  let matched = 0;
  let total = 0;
  for (const [name, entry] of Object.entries(lock.skills)) {
    total += 1;
    const [owner, repo] = entry.source.split("/");
    let entries = cache.get(entry.source);
    if (!entries) {
      const response = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`, {
        signal: AbortSignal.timeout(60000),
      });
      assert.equal(response.status, 200, `下载 ${entry.source} 失败`);
      entries = readTarEntries(gunzipSync(Buffer.from(await response.arrayBuffer())));
      cache.set(entry.source, entries);
    }
    // 与模块一致：skillPath 直接命中失败时按目录名唯一回退（retro 的 skillPath 已过期）
    const located = locateSkillDirectory(entries, entry.skillPath);
    assert.ok(located, `上游找不到 ${entry.skillPath}`);
    const upstream = hashTarDirectory(entries, located.path);
    const ok = hashesEqual(upstream, entry.skillFolderHash);
    if (ok) matched += 1;
    console.log(
      `${name.padEnd(16)} 记录=${entry.skillFolderHash.slice(0, 12)} 上游raw=${upstream.raw.slice(0, 12)} 上游crlf=${upstream.normalized.slice(0, 12)}` +
        ` 定位=${located.path} => ${ok ? "MATCH" : "MISMATCH"}`,
    );
  }
  console.log(`上游哈希复现：${matched}/${total}`);
  assert.equal(matched, total, "上游哈希应逐条与 lock 记录一致");
});
