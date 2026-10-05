import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import {
  readTarEntries,
  parsePaxRecords,
  filesUnderDirectory,
  locateSkillDirectory,
} from "../../../src/skills/remote/tar.ts";
import { buildTar, buildTarWithPax, buildTarGz, repoArchive } from "./tarfixture.ts";

test("读取 ustar 归档：普通文件与目录", () => {
  const tar = buildTar([
    { path: "demo-main/", type: "dir" },
    { path: "demo-main/skills/foo/SKILL.md", data: "hello" },
    { path: "demo-main/skills/foo/agents/", type: "dir" },
    { path: "demo-main/skills/foo/agents/openai.yaml", data: "name: foo" },
    { path: "demo-main/README.md", data: "readme" },
  ]);
  const entries = readTarEntries(tar);
  assert.deepEqual(
    entries.map((e) => [e.path, e.type, e.data.toString("utf8")]),
    [
      // 根目录 "demo-main/" 被剥离后为空，不作为条目返回
      ["skills/foo/SKILL.md", "file", "hello"],
      ["skills/foo/agents", "dir", ""],
      ["skills/foo/agents/openai.yaml", "file", "name: foo"],
      ["README.md", "file", "readme"],
    ],
  );
});

test("路径超过 100 字节时用 prefix 字段拼接", () => {
  const long = "a".repeat(120) + "/SKILL.md";
  const tar = buildTar([
    { path: "demo-main/", type: "dir" },
    { path: `demo-main/${long}`, data: "x" },
  ]);
  const entries = readTarEntries(tar);
  assert.equal(entries.find((e) => e.type === "file")?.path, long);
});

test("pax 扩展头的长路径被正确采用", () => {
  const long = "deep/" + "b".repeat(150) + "/SKILL.md";
  const tar = buildTarWithPax([
    { path: "demo-main/", type: "dir" },
    { path: `demo-main/${long}`, data: "pax-content" },
  ]);
  const entries = readTarEntries(tar);
  const file = entries.find((e) => e.type === "file");
  assert.equal(file?.path, long);
  assert.equal(file?.data.toString("utf8"), "pax-content");
});

test("parsePaxRecords 解析多条记录", () => {
  const body = "12 path=abc\n9 size=3\n";
  const records = parsePaxRecords(Buffer.from(body, "utf8"));
  assert.deepEqual(records, { path: "abc", size: "3" });
});

test("截断的归档不会抛错，安全返回已读到的条目", () => {
  const tar = buildTar([
    { path: "demo-main/", type: "dir" },
    { path: "demo-main/SKILL.md", data: "x".repeat(600) },
  ]);
  const truncated = tar.subarray(0, 700);
  const entries = readTarEntries(truncated);
  assert.ok(entries.length >= 1);
});

test("gzip 解压后可直接读取（codeload 形态）", () => {
  const gz = buildTarGz([
    { path: "demo-main/", type: "dir" },
    { path: "demo-main/SKILL.md", data: "gzipped" },
  ]);
  const entries = readTarEntries(gunzipSync(gz));
  assert.equal(entries.find((e) => e.type === "file")?.data.toString("utf8"), "gzipped");
});

test("repoArchive 自动加根前缀，读取时被剥掉", () => {
  const gz = repoArchive([{ path: "skills/engineering/foo/SKILL.md", data: "fm" }]);
  const entries = readTarEntries(gunzipSync(gz));
  assert.deepEqual(
    entries.map((e) => e.path),
    ["skills/engineering/foo/SKILL.md"],
  );
});

test("filesUnderDirectory 返回相对路径", () => {
  const tar = buildTar([
    { path: "r/", type: "dir" },
    { path: "r/skills/a/SKILL.md", data: "1" },
    { path: "r/skills/a/sub/b.md", data: "2" },
    { path: "r/skills/b/SKILL.md", data: "3" },
  ]);
  const entries = readTarEntries(tar);
  const files = filesUnderDirectory(entries, "skills/a");
  assert.deepEqual(
    files.map((f) => f.rel),
    ["SKILL.md", "sub/b.md"],
  );
});

test("locateSkillDirectory：skillPath 命中；未命中时按目录名唯一匹配", () => {
  const tar = buildTar([
    { path: "r/", type: "dir" },
    { path: "r/skills/new-category/foo/SKILL.md", data: "1" },
  ]);
  const entries = readTarEntries(tar);
  assert.equal(locateSkillDirectory(entries, "skills/new-category/foo/SKILL.md")?.path, "skills/new-category/foo");
  // 旧分类目录 → 上游挪了位置，按目录名找回
  assert.equal(locateSkillDirectory(entries, "skills/old-category/foo/SKILL.md")?.path, "skills/new-category/foo");
  // 目录名不唯一 → 放弃
  const tar2 = buildTar([
    { path: "r/", type: "dir" },
    { path: "r/a/foo/SKILL.md", data: "1" },
    { path: "r/b/foo/SKILL.md", data: "2" },
  ]);
  assert.equal(locateSkillDirectory(readTarEntries(tar2), "skills/x/foo/SKILL.md"), undefined);
});
