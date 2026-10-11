/**
 * MCP 工具的 inputSchema → DSH 工具注册接受的 JSON Schema 子集。
 *
 * DSH（dsh-tools 的 assertSupportedJsonSchema）只接受：单个字符串的 type、oneOf、properties、required、
 * additionalProperties（布尔）、items（单个 schema）、enum（只能是字符串、要有 type）、const（要有 type），
 * 外加注解 description / title / default / examples；根必须是 type: "object"。MCP 服务器（尤其 Python 写的）
 * 常用 anyOf、类型数组、format、minimum、prefixItems、$ref…… 原样注册会被拒绝。
 *
 * 转换只会**放宽**约束，不会让原本合法的参数变得不合法（服务器自己还会再校验一次）：
 *   - anyOf / 类型数组：各分支类型互不相同时改成等价的 oneOf；分支类型有重叠时放宽成「任意值」；
 *   - $ref（#/$defs/…、#/definitions/…）就地展开，循环或太深时放宽成任意值；allOf 能合并就合并；
 *   - format、范围、长度、pattern、元素个数、非字符串的 enum 等丢掉，改成写在 description 末尾的一句提示，
 *     模型照样看得到；
 *   - 其余不认识的关键字直接丢掉。
 */

export type JsonSchema = Record<string, unknown>;

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const MAX_DEPTH = 12;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface Walk {
  root: Record<string, unknown>;
  depth: number;
  /** 正在展开的 $ref（防循环） */
  refs: ReadonlySet<string>;
}

/** 转换整份 inputSchema；结果的根一定是 type: "object"。 */
export function toDshInputSchema(input: unknown): JsonSchema {
  const root = isRecord(input) ? input : {};
  const out = convert(root, { root, depth: 0, refs: new Set() });
  if (out.type === "object") return out;
  // 根不是对象（或转换后成了任意值 / oneOf）：工具参数总是一个对象，退回「任意对象」
  const fallback: JsonSchema = { type: "object" };
  if (typeof out.description === "string") fallback.description = out.description;
  return fallback;
}

/** 把一个 schema 节点转成子集。 */
function convert(node: Record<string, unknown>, walk: Walk): JsonSchema {
  if (walk.depth > MAX_DEPTH) return annotations(node, []);
  const resolved = resolveRef(node, walk);
  if (resolved === undefined) return annotations(node, []);
  const { schema: merged, walk: inner } = resolved;
  const next: Walk = { ...inner, depth: inner.depth + 1 };
  const hints = constraintHints(merged);

  // 组合：anyOf / oneOf / 类型数组
  const branches = branchesOf(merged);
  if (branches !== undefined) {
    const converted = branches.map((branch) => convert(branch.schema, next));
    // 任一分支是「任意值」，整体就是任意值
    if (converted.some((branch) => Object.keys(branch).every((key) => !STRUCTURAL.has(key)))) {
      return annotations(merged, hints);
    }
    if (converted.length === 1) return withAnnotations(converted[0]!, merged, hints);
    const types = converted.map((branch) => branch.type);
    const distinct = types.every((type) => typeof type === "string") && new Set(types).size === types.length;
    if (branches.exact || distinct) return { ...annotations(merged, hints), oneOf: converted };
    return annotations(merged, [...hints, "可以是几种形式之一"]);
  }

  const type = typeOf(merged);
  if (type === undefined) return annotations(merged, hints);
  const out: JsonSchema = { type };
  if (type === "object") {
    const properties = isRecord(merged.properties) ? merged.properties : {};
    const converted: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(properties)) {
      converted[key] = convert(isRecord(value) ? value : {}, next);
    }
    if (Object.keys(converted).length > 0) out.properties = converted;
    const required = Array.isArray(merged.required)
      ? [...new Set(merged.required.filter((name): name is string => typeof name === "string" && name in converted))]
      : [];
    if (required.length > 0) out.required = required;
    if (typeof merged.additionalProperties === "boolean") out.additionalProperties = merged.additionalProperties;
  } else if (type === "array") {
    const items = itemsOf(merged, next);
    if (items !== undefined) out.items = items;
  }
  const values = enumOf(merged);
  if (values !== undefined && type === "string") out.enum = values;
  if ("const" in merged && constMatches(merged.const, type)) out.const = merged.const;
  return { ...annotations(merged, hints), ...out };
}

/** 结构关键字：没有它们的节点就是「任意值」。 */
const STRUCTURAL = new Set(["type", "oneOf", "properties", "items", "enum", "const"]);

function withAnnotations(schema: JsonSchema, outer: Record<string, unknown>, hints: string[]): JsonSchema {
  const outerNotes = annotations(outer, hints);
  // 外层的说明优先（字段说明通常写在外层，分支里只有类型）
  return { ...schema, ...outerNotes };
}

/** 保留的注解 + 把丢掉的约束写成提示接在 description 后面。 */
function annotations(node: Record<string, unknown>, hints: string[]): JsonSchema {
  const out: JsonSchema = {};
  if (typeof node.title === "string") out.title = node.title;
  if ("default" in node && node.default !== undefined) out.default = node.default;
  if (Array.isArray(node.examples)) out.examples = node.examples;
  const base = typeof node.description === "string" ? node.description.trim() : "";
  const note = hints.length > 0 ? "（" + hints.join("；") + "）" : "";
  if (base !== "" || note !== "") out.description = base === "" ? note : base + (note === "" ? "" : " " + note);
  return out;
}

/** 展开本地 $ref 并合并 allOf；循环引用或解析不了时 undefined（调用方放宽成任意值）。 */
function resolveRef(
  node: Record<string, unknown>,
  walk: Walk,
): { schema: Record<string, unknown>; walk: Walk } | undefined {
  let schema = node;
  let refs = walk.refs;
  for (let hop = 0; typeof schema.$ref === "string"; hop += 1) {
    const ref = schema.$ref as string;
    if (hop > MAX_DEPTH || refs.has(ref)) return undefined;
    const target = lookup(walk.root, ref);
    if (target === undefined) return undefined;
    refs = new Set([...refs, ref]);
    const { $ref: _ignored, ...rest } = schema;
    schema = { ...target, ...rest };
  }
  if (Array.isArray(schema.allOf)) {
    const parts = schema.allOf.filter(isRecord).map((part) => resolveRef(part, { ...walk, refs })?.schema ?? {});
    const { allOf: _ignored, ...rest } = schema;
    schema = parts.reduce<Record<string, unknown>>((acc, part) => mergeAll(acc, part), rest);
  }
  return { schema, walk: { ...walk, refs } };
}

function lookup(root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined {
  if (ref === "#") return root;
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (match === null) return undefined;
  const table = root[match[1]!];
  if (!isRecord(table)) return undefined;
  const target = table[decodeURIComponent(match[2]!).replace(/~1/g, "/").replace(/~0/g, "~")];
  return isRecord(target) ? target : undefined;
}

/** allOf 的一个分支并进来：properties / required 取并集，其余以先出现的为准。 */
function mergeAll(acc: Record<string, unknown>, part: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...part, ...acc };
  if (isRecord(acc.properties) || isRecord(part.properties)) {
    out.properties = {
      ...(isRecord(part.properties) ? part.properties : {}),
      ...(isRecord(acc.properties) ? acc.properties : {}),
    };
    if (out.type === undefined) out.type = "object";
  }
  const required = [
    ...(Array.isArray(acc.required) ? acc.required : []),
    ...(Array.isArray(part.required) ? part.required : []),
  ];
  if (required.length > 0) out.required = required;
  return out;
}

interface Branches {
  schema: Record<string, unknown>;
}

/** anyOf / oneOf / 类型数组拆成分支；exact = 原本就是 oneOf（「恰好一个」的语义可以原样保留）。 */
function branchesOf(node: Record<string, unknown>): (Branches[] & { exact?: boolean }) | undefined {
  const { anyOf, oneOf, type } = node;
  // 只把结构关键字带进每个分支；注解与约束提示留在外层，免得每个分支各说一遍
  const rest: Record<string, unknown> = {};
  for (const key of ["properties", "required", "additionalProperties", "items", "prefixItems", "enum", "const"]) {
    if (key in node) rest[key] = node[key];
  }
  const list = Array.isArray(oneOf) ? oneOf : Array.isArray(anyOf) ? anyOf : undefined;
  if (list !== undefined) {
    const out = list.map((branch) => ({
      // 外层的 type / properties 之类同时作用于每个分支
      schema: { ...(typeof type === "string" ? { type } : {}), ...rest, ...(isRecord(branch) ? branch : {}) },
    })) as Branches[] & { exact?: boolean };
    if (Array.isArray(oneOf)) out.exact = true;
    return out;
  }
  if (Array.isArray(type)) {
    const kinds = [...new Set(type.filter((item): item is string => typeof item === "string" && TYPES.has(item)))];
    if (kinds.length === 0) return [{ schema: rest }];
    return kinds.map((kind) => ({ schema: { ...rest, type: kind } }));
  }
  return undefined;
}

/** 节点的单一类型；没写 type 时按 properties / items / enum / const 推断。 */
function typeOf(node: Record<string, unknown>): string | undefined {
  if (typeof node.type === "string") return TYPES.has(node.type) ? node.type : undefined;
  if (isRecord(node.properties) || node.additionalProperties === false || isRecord(node.patternProperties))
    return "object";
  if (node.items !== undefined || Array.isArray(node.prefixItems)) return "array";
  const values = Array.isArray(node.enum) ? node.enum : undefined;
  if (values !== undefined && values.length > 0 && values.every((value) => typeof value === "string")) return "string";
  if ("const" in node) {
    const value = node.const;
    if (typeof value === "string" || typeof value === "boolean") return typeof value;
    if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
    if (value === null) return "null";
  }
  return undefined;
}

/** items：单个 schema 直接转；元组（items 数组 / prefixItems）各项相同时取那一项，否则放宽成任意值。 */
function itemsOf(node: Record<string, unknown>, walk: Walk): JsonSchema | undefined {
  const tuple = Array.isArray(node.prefixItems) ? node.prefixItems : Array.isArray(node.items) ? node.items : undefined;
  if (tuple !== undefined) {
    const converted = tuple.map((item) => convert(isRecord(item) ? item : {}, walk));
    const first = converted[0];
    if (first !== undefined && converted.every((item) => JSON.stringify(item) === JSON.stringify(first))) return first;
    return {};
  }
  return isRecord(node.items) ? convert(node.items, walk) : undefined;
}

/** 只保留全是字符串的 enum（DSH 的限制）；其余的写进提示。 */
function enumOf(node: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(node.enum) || node.enum.length === 0) return undefined;
  if (!node.enum.every((value) => typeof value === "string")) return undefined;
  return [...new Set(node.enum as string[])];
}

function constMatches(value: unknown, type: string): boolean {
  if (type === "string" || type === "boolean") return typeof value === type;
  if (type === "number") return typeof value === "number";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "null") return value === null;
  return false;
}

/** 丢掉的约束写成一句中文提示（模型据此填对参数）。 */
function constraintHints(node: Record<string, unknown>): string[] {
  const hints: string[] = [];
  const num = (key: string): number | undefined => (typeof node[key] === "number" ? (node[key] as number) : undefined);
  if (typeof node.format === "string") hints.push("格式：" + node.format);
  const min = num("minimum");
  const max = num("maximum");
  const xmin = num("exclusiveMinimum");
  const xmax = num("exclusiveMaximum");
  const range: string[] = [];
  if (min !== undefined) range.push("≥ " + min);
  if (xmin !== undefined) range.push("> " + xmin);
  if (max !== undefined) range.push("≤ " + max);
  if (xmax !== undefined) range.push("< " + xmax);
  if (range.length > 0) hints.push("取值 " + range.join(" 且 "));
  if (num("multipleOf") !== undefined) hints.push("是 " + num("multipleOf") + " 的倍数");
  const size = (lo: number | undefined, hi: number | undefined, what: string): void => {
    if (lo === undefined && hi === undefined) return;
    if (lo !== undefined && lo === hi) hints.push(what + " " + lo);
    else if (lo !== undefined && hi !== undefined) hints.push(what + " " + lo + "–" + hi);
    else if (lo !== undefined) hints.push(what + "至少 " + lo);
    else hints.push(what + "至多 " + hi);
  };
  size(num("minLength"), num("maxLength"), "长度");
  size(num("minItems"), num("maxItems"), "元素个数");
  size(num("minProperties"), num("maxProperties"), "键的个数");
  if (node.uniqueItems === true) hints.push("元素不重复");
  if (typeof node.pattern === "string") hints.push("需匹配 /" + node.pattern + "/");
  if (Array.isArray(node.enum) && node.enum.length > 0 && !node.enum.every((value) => typeof value === "string")) {
    hints.push("可选值：" + node.enum.map((value) => JSON.stringify(value)).join("、"));
  }
  if (Array.isArray(node.prefixItems) || Array.isArray(node.items)) {
    const tuple = (Array.isArray(node.prefixItems) ? node.prefixItems : node.items) as unknown[];
    const kinds = tuple.map((item) => (isRecord(item) && typeof item.type === "string" ? item.type : "任意"));
    if (new Set(kinds).size > 1) hints.push("依次为 " + kinds.join("、"));
  }
  if ("const" in node && typeOf({ const: node.const }) === undefined)
    hints.push("固定为 " + JSON.stringify(node.const));
  return hints;
}
