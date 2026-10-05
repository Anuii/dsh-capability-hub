/** 搜索排序的字段权重、分档、准入与稳定排序。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, rankDocuments, searchByRegex, tokenize } from "../../../src/mcp/runtime/atoms/search-ranking.ts";
import type { RankDocument } from "../../../src/mcp/runtime/atoms/search-ranking.ts";

function doc(server: string, name: string, description = "", keywords: string[] = []): RankDocument {
  return { qualifiedName: server + "__" + name, originalName: name, server, description, keywords };
}

test("归一化：先切 camelCase 再小写，非字母数字折成单空格", () => {
  assert.equal(normalize("readFile"), "read file");
  assert.equal(normalize("Read_File-Now"), "read file now");
  assert.equal(normalize("中文/测试"), "中文 测试");
  assert.deepEqual(tokenize("getWeather  now"), ["get", "weather", "now"]);
});

test("整字段精确命中排第一，短语各档都远高于裸子串", () => {
  // F3-Q4 的分档（照抄）：整字段精确 = weight*14 + 20；前缀 = weight*9；包含 = weight*6。
  // 注意「包含」还会叠加 token 命中（weight*4）与收尾加成，所以它可能高于前缀 —— 这是原文行为。
  const exact = doc("s", "exact");
  const prefix = doc("s", "exactness");
  const contains = doc("s", "the-exact-one");
  const substringOnly = doc("s", "theeexact");
  const ranked = rankDocuments([substringOnly, contains, prefix, exact], "exact");
  assert.equal(ranked[0].doc.originalName, "exact", "整字段精确必须排第一");
  const scoreOf = (name: string) => ranked.find((item) => item.doc.originalName === name)!.score;
  assert.ok(scoreOf("exact") > scoreOf("exactness"));
  assert.ok(scoreOf("exactness") > scoreOf("theeexact"), "短语命中必须高于裸子串");
  assert.ok(scoreOf("exactness") > 0 && scoreOf("theeexact") > 0);
});

test("qualifiedName 权重高于 description", () => {
  const nameHit = doc("s", "alpha", "nothing here");
  const descHit = doc("s", "beta", "alpha appears in the description");
  const ranked = rankDocuments([descHit, nameHit], "alpha");
  assert.equal(ranked[0].doc.originalName, "alpha");
});

test("关键词只影响排序，不影响是否可搜", () => {
  const withKeyword = doc("s", "zzz", "", ["气象"]);
  const without = doc("s", "yyy", "");
  const ranked = rankDocuments([without, withKeyword], "气象");
  assert.deepEqual(
    ranked.map((item) => item.doc.originalName),
    ["zzz"],
  );
});

test("短语命中直接准入；≤2 token 的查询必须全覆盖", () => {
  assert.equal(rankDocuments([doc("s", "read file")], "read file").length, 1);
  assert.equal(rankDocuments([doc("s", "read")], "read file").length, 0, "缺一个 token 应被挡下");
  assert.equal(rankDocuments([doc("s", "read now", "")], "read now").length, 1);
});

test("长查询允许 60% 覆盖", () => {
  const target = doc("s", "alpha beta gamma", "");
  assert.equal(rankDocuments([target], "alpha beta gamma delta epsilon").length, 1);
  const weak = doc("s", "alpha", "");
  assert.equal(rankDocuments([weak], "alpha beta gamma delta epsilon").length, 0);
});

test("并列时按限定名排序，结果稳定", () => {
  const docs = [doc("s", "b_item"), doc("s", "a_item")];
  const first = rankDocuments(docs, "item").map((item) => item.doc.qualifiedName);
  const second = rankDocuments([...docs].reverse(), "item").map((item) => item.doc.qualifiedName);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ["s__a_item", "s__b_item"]);
});

test("空查询不产生匹配（交给上层决定文案）", () => {
  assert.deepEqual(rankDocuments([doc("s", "x")], ""), []);
});

test("正则模式：命中按名字排序，语法错误透传，超长拒绝", () => {
  const docs = [doc("s", "read_file"), doc("s", "write_file"), doc("s", "other")];
  // 注意：haystack 是 qualifiedName + 描述 + 关键词拼起来的，^ 锚在整个串的开头，
  // 所以这里不能写 '^(read|write)_'（那是 F3-Q4 的原文行为，我们照抄）。
  const ok = searchByRegex(docs, "(read|write)_", 100);
  assert.equal(ok.ok, true);
  assert.deepEqual(
    ok.matches.map((item) => item.originalName),
    ["read_file", "write_file"],
  );

  const bad = searchByRegex(docs, "([", 100);
  assert.equal(bad.ok, false);
  assert.ok((bad.error ?? "").length > 0);

  const tooLong = searchByRegex(docs, "a".repeat(300), 100);
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error ?? "", /正则太长/);
});

test("正则模式在描述里也能命中", () => {
  const docs = [doc("s", "a", "find ME here"), doc("s", "b", "nothing")];
  const result = searchByRegex(docs, "me", 100);
  assert.deepEqual(
    result.matches.map((item) => item.originalName),
    ["a"],
  );
});
