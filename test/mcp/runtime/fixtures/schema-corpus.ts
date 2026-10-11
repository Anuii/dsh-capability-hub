/**
 * MCP 工具 inputSchema 的样本：真实服务器常见的写法（Python / pydantic 的 Optional、$defs、元组、数值枚举……）。
 * 单测检查转换结果的形状；集成脚本 schema-subset-check.mjs 用 DSH 自带的校验器逐个核对。
 */
export const SCHEMA_CORPUS: { name: string; schema: unknown }[] = [
  {
    name: "maa-screencap（Optional 元组 + 带默认值的 Optional 整数）",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        controller_id: { type: "string" },
        region: {
          anyOf: [
            {
              maxItems: 4,
              minItems: 4,
              prefixItems: [{ type: "integer" }, { type: "integer" }, { type: "integer" }, { type: "integer" }],
              type: "array",
            },
            { type: "null" },
          ],
          default: null,
        },
        resolution: { anyOf: [{ type: "integer" }, { type: "null" }], default: 720 },
      },
      required: ["controller_id"],
    },
  },
  {
    name: "optional-path（Optional 字符串 + format）",
    schema: {
      type: "object",
      properties: { resource_path: { anyOf: [{ type: "string", format: "path" }, { type: "null" }], default: null } },
    },
  },
  {
    name: "pydantic-defs（$ref + $defs + title）",
    schema: {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "Args",
      type: "object",
      properties: { point: { $ref: "#/$defs/Point" }, mode: { $ref: "#/definitions/Mode" } },
      required: ["point", "ghost"],
      $defs: {
        Point: {
          type: "object",
          properties: { x: { type: "integer", minimum: 0 }, y: { type: "integer" } },
          required: ["x", "y"],
        },
      },
      definitions: { Mode: { enum: ["fast", "slow"] } },
    },
  },
  {
    name: "recursive（循环引用）",
    schema: {
      type: "object",
      properties: { tree: { $ref: "#/$defs/Node" } },
      $defs: { Node: { type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/Node" } } } } },
    },
  },
  {
    name: "type-array（类型数组 + nullable + 数值枚举）",
    schema: {
      type: "object",
      properties: {
        count: { type: ["integer", "null"], maximum: 100 },
        level: { type: "integer", enum: [1, 2, 3] },
        label: { type: "string", nullable: true, deprecated: true, readOnly: true, $comment: "x" },
        tag: { enum: ["a", 1] },
        fixed: { const: 42 },
      },
    },
  },
  {
    name: "allOf + 重叠的 anyOf + 混合元组",
    schema: {
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { properties: { b: { anyOf: [{ type: "string" }, { type: "string", minLength: 3 }] } } },
      ],
      properties: { pair: { type: "array", items: [{ type: "string" }, { type: "integer" }] } },
    },
  },
  {
    name: "additionalProperties 是 schema + patternProperties",
    schema: {
      type: "object",
      properties: {
        env: { type: "object", additionalProperties: { type: "string" }, patternProperties: { "^X": {} } },
      },
    },
  },
  { name: "空 schema", schema: {} },
  { name: "根没写 type", schema: { properties: { q: { type: "string" } }, required: ["q"] } },
  { name: "根是数组（非法，退回任意对象）", schema: { type: "array", items: { type: "string" } } },
  {
    name: "codegraph-explore（本来就合规）",
    schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language question" },
        maxFiles: { type: "number" },
        projectPath: { type: "string" },
      },
      required: ["query", "projectPath"],
    },
  },
];
