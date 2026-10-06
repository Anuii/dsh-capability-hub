import test from "node:test";
import assert from "node:assert/strict";
import { createTranslator } from "../../src/kit/translate.ts";

test("createTranslator：按 key 取中文，替换 {参数}；没给的参数原样保留", () => {
  const t = createTranslator({ "x.saved": "已生效：「{name}」（{count} 个）", "x.plain": "好" } as const);
  assert.equal(t("x.plain"), "好");
  assert.equal(t("x.saved", { name: "demo", count: 3 }), "已生效：「demo」（3 个）");
  assert.equal(t("x.saved", { name: "demo" }), "已生效：「demo」（{count} 个）");
});
