/**
 * 读 DSH 的组合树（ctx.loader）：DSH 按 cordis 配置装起来的全部插件条目。
 *
 * 实测定下来的事实（见 boot.json 的 skillSources）：
 *   - ctx.loader.entries() 返回**扁平的顶层条目**（本机 dev profile 187 条，
 *     其中 cordis:include 分组会把成员条目再列一遍，所以要按对象去重）；
 *   - 嵌套条目挂在 entry.subgroup / entry.subtree 上（分组条目才有），
 *     子条目本身也是同形状的 entry；
 *   - 运行期已解析的配置在 entry.fiber.config 上，entry.options.config 是原始配置。
 * 因为不知道 cordis 内部容器的确切类型，「子容器」做防御式枚举：数组 / Map /
 * 有 entries()|values()|children 的对象 / 可迭代对象都试一遍。任何读取失败都当作没有，绝不抛。
 */

import { safeGet } from "./host-ctx.ts";

/** 组合树里的一个条目（只读视图）。 */
export interface CompositionEntry {
  id: string;
  /** 插件包名，例如 @deepseek-ai/dsh-skill-filesystem */
  name: string;
  disabled: boolean;
  /** 原始配置（entry.options.config） */
  config: unknown;
  /** 运行期已解析的配置（entry.fiber.config）；没有就是 undefined */
  resolvedConfig: unknown;
}

/** 组合树的一个节点（诊断用，只保留名字与子节点）。 */
export interface EntryTreeNode {
  id: string;
  name: string;
  disabled: boolean;
  children: EntryTreeNode[];
  /** 被截断的子节点数。 */
  truncated: number;
}

interface RawEntry {
  options?: { id?: unknown; name?: unknown; disabled?: unknown; config?: unknown };
  fiber?: { config?: unknown };
  disabled?: unknown;
  subgroup?: unknown;
  subtree?: unknown;
}

function isRawEntry(value: unknown): value is RawEntry {
  return typeof value === "object" && value !== null && (value as RawEntry).options !== undefined;
}

function pushEntries(items: Iterable<unknown>, out: RawEntry[]): void {
  for (const item of items) if (isRawEntry(item)) out.push(item);
}

/** 把任意「子容器」里的条目收集出来（认不出来就当空）。 */
function collect(container: unknown, out: RawEntry[]): void {
  if (container === undefined || container === null) return;
  if (isRawEntry(container)) {
    out.push(container);
    return;
  }
  if (Array.isArray(container) || container instanceof Set) {
    pushEntries(container, out);
    return;
  }
  // Map 自己也有 entries()（产出 [键, 值] 对），必须先按 Map 认，否则会被下面的访问器吞掉
  if (container instanceof Map) {
    pushEntries(container.values(), out);
    return;
  }
  const record = container as Record<string, unknown>;
  for (const key of ["entries", "values", "children"]) {
    const value = record[key];
    if (typeof value === "function") {
      try {
        const produced = (value as () => unknown).call(container);
        if (
          produced !== undefined &&
          produced !== null &&
          typeof (produced as Iterable<unknown>)[Symbol.iterator] === "function"
        ) {
          pushEntries(produced as Iterable<unknown>, out);
        }
      } catch {
        // 认不出来就跳过这个访问器
      }
      return;
    }
    if (value instanceof Map) {
      pushEntries(value.values(), out);
      return;
    }
    if (Array.isArray(value)) {
      pushEntries(value, out);
      return;
    }
  }
  if (typeof (container as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function") {
    try {
      pushEntries(container as Iterable<unknown>, out);
    } catch {
      // 迭代失败就当没有子条目
    }
  }
}

function childrenOf(entry: RawEntry): RawEntry[] {
  const out: RawEntry[] = [];
  collect(entry.subgroup, out);
  collect(entry.subtree, out);
  return out;
}

function viewOf(entry: RawEntry): CompositionEntry {
  const name = typeof entry.options?.name === "string" ? entry.options.name : "";
  return {
    id: typeof entry.options?.id === "string" ? entry.options.id : name,
    name,
    disabled: entry.options?.disabled === true || entry.disabled === true,
    config: entry.options?.config,
    resolvedConfig: entry.fiber?.config,
  };
}

function rootsOf(ctx: unknown): RawEntry[] | undefined {
  const loader = safeGet(ctx, "loader") as { entries?(): Iterable<unknown> } | undefined;
  if (loader === undefined || typeof loader.entries !== "function") return undefined;
  try {
    return [...loader.entries()].filter(isRawEntry);
  } catch {
    return undefined;
  }
}

/** 组合树里的全部条目（广度优先、按对象去重、含嵌套）；拿不到 loader 时 roots = 0、entries 为空。 */
export function readComposition(ctx: unknown): { roots: number; entries: CompositionEntry[] } {
  const roots = rootsOf(ctx);
  if (roots === undefined) return { roots: 0, entries: [] };
  const entries: CompositionEntry[] = [];
  const queue = [...roots];
  const seen = new Set<RawEntry>();
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (seen.has(entry)) continue;
    seen.add(entry);
    entries.push(viewOf(entry));
    for (const child of childrenOf(entry)) if (!seen.has(child)) queue.push(child);
  }
  return { roots: roots.length, entries };
}

/** 组合树的结构快照（有限深度，诊断用）；拿不到 loader 时 undefined。 */
export function compositionTree(ctx: unknown, maxDepth = 3, maxChildren = 40): EntryTreeNode | undefined {
  const roots = rootsOf(ctx);
  if (roots === undefined) return undefined;
  const build = (entry: RawEntry, depth: number): EntryTreeNode => {
    const view = viewOf(entry);
    const children = depth >= maxDepth ? [] : childrenOf(entry);
    const shown = children.slice(0, maxChildren).map((child) => build(child, depth + 1));
    return {
      id: view.id,
      name: view.name,
      disabled: view.disabled,
      children: shown,
      truncated: Math.max(0, children.length - shown.length),
    };
  };
  return {
    id: "(root)",
    name: roots.length + " 个顶层条目",
    disabled: false,
    children: roots.slice(0, maxChildren).map((entry) => build(entry, 1)),
    truncated: Math.max(0, roots.length - maxChildren),
  };
}
