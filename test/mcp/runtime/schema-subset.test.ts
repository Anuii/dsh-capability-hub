/**
 * schema-subset.ts：MCP inputSchema → DSH 注册接受的子集。这里检查转换后的形状；
 * 「DSH 真的收」由 Electron-as-node 下的 integration/schema-subset-check.mjs 用 DSH 自带校验器核对。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { toDshInputSchema } from "../../../src/mcp/runtime/atoms/schema-subset.ts";
import { SCHEMA_CORPUS } from "./fixtures/schema-corpus.ts";

const props = (schema: Record<string, unknown>): Record<string, Record<string, unknown>> =>
  schema.properties as Record<string, Record<string, unknown>>;
const byName = (name: string): Record<string, unknown> =>
  toDshInputSchema(SCHEMA_CORPUS.find((item) => item.name.startsWith(name))!.schema);

test("Optional（anyOf 加 null）改成等价的 oneOf；元组各项相同时变成 items；个数写进说明", () => {
  const out = byName("maa-screencap");
  assert.equal(out.type, "object");
  assert.equal(out.additionalProperties, false);
  assert.deepEqual(out.required, ["controller_id"]);
  assert.deepEqual(props(out).region, {
    default: null,
    oneOf: [{ type: "array", items: { type: "integer" }, description: "（元素个数 4）" }, { type: "null" }],
  });
  assert.deepEqual(props(out).resolution, { default: 720, oneOf: [{ type: "integer" }, { type: "null" }] });
});

test("format / 范围 / 长度等约束丢掉，改成说明里的提示；不认识的关键字直接丢", () => {
  const optional = props(byName("optional-path")).resource_path!;
  assert.deepEqual(optional.oneOf, [{ type: "string", description: "（格式：path）" }, { type: "null" }]);
  const mixed = props(byName("type-array"));
  assert.deepEqual(mixed.count, { description: "（取值 ≤ 100）", oneOf: [{ type: "integer" }, { type: "null" }] });
  assert.deepEqual(mixed.level, { type: "integer", description: "（可选值：1、2、3）" }, "DSH 的 enum 只收字符串");
  assert.deepEqual(mixed.label, { type: "string" });
  assert.deepEqual(mixed.tag, { description: '（可选值："a"、1）' }, "混合类型的 enum 放宽成任意值");
  assert.deepEqual(mixed.fixed, { type: "integer", const: 42 }, "const 没写 type 时按值推断");
});

test("$ref 就地展开；required 里不存在的键去掉；$schema / $defs 不进结果", () => {
  const out = byName("pydantic-defs");
  assert.equal("$schema" in out, false);
  assert.equal("$defs" in out, false);
  assert.equal(out.title, "Args");
  assert.deepEqual(out.required, ["point"]);
  assert.deepEqual(props(out).point, {
    type: "object",
    properties: { x: { type: "integer", description: "（取值 ≥ 0）" }, y: { type: "integer" } },
    required: ["x", "y"],
  });
  assert.deepEqual(props(out).mode, { type: "string", enum: ["fast", "slow"] });
});

test("循环引用：展开到第二次遇到同一个引用时放宽成任意值，不死循环", () => {
  const tree = props(byName("recursive")).tree!;
  assert.equal(tree.type, "object");
  const children = (tree.properties as Record<string, Record<string, unknown>>).children!;
  assert.deepEqual(children.items, {});
});

test("allOf 合并；重叠的 anyOf 放宽成任意值；混合元组放宽并写出各项类型", () => {
  const out = byName("allOf");
  assert.equal(out.type, "object");
  assert.deepEqual(out.required, ["a"]);
  assert.deepEqual(props(out).a, { type: "string" });
  assert.deepEqual(props(out).b, { description: "（可以是几种形式之一）" });
  assert.deepEqual(props(out).pair, { type: "array", items: {}, description: "（依次为 string、integer）" });
});

test("additionalProperties 只留布尔；patternProperties 丢掉", () => {
  assert.deepEqual(props(byName("additionalProperties")).env, { type: "object" });
});

test("根：空 schema 与没写 type 的都成为对象；根是数组时退回任意对象；本来合规的原样保留", () => {
  assert.deepEqual(byName("空 schema"), { type: "object" });
  assert.deepEqual(byName("根没写 type"), { type: "object", properties: { q: { type: "string" } }, required: ["q"] });
  assert.deepEqual(byName("根是数组"), { type: "object" });
  const codegraph = SCHEMA_CORPUS.find((item) => item.name.startsWith("codegraph"))!.schema;
  assert.deepEqual(toDshInputSchema(codegraph), codegraph);
  assert.deepEqual(toDshInputSchema(undefined), { type: "object" });
});
