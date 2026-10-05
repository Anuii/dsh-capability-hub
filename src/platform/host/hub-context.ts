/**
 * HubContext 解析（PLAN §3.1）。
 *
 * 取值口径：
 *   - homeDir：默认 os.homedir()；插件配置 devOverrides.enabled 为真时取 devOverrides.homeDir。
 *   - dshHome：默认 <homeDir>/.dsh；可用 DSH_HOME 环境变量覆盖（与 DSH 的 resolveDshHome 一致）。
 *   - profileName：从 ctx.profileContext.name 取；拿不到时用 "unknown"。
 *   - customSkillDirs / bundledSkillDir：遍历**整棵组合树**里所有未停用的 skill-filesystem
 *     来源（含嵌套在 agent 预设分组里的），取已解析的 customSkillDirs 求并集；
 *     拿不到给空数组 / undefined（绝不抛错，也绝不因此让插件降级）。
 *
 * 本文件里对 ctx 的访问一律用「防御式」写法：DSH 的 Context 是 Proxy 语义，
 * 未知键可能抛错而不是返回 undefined。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlatformContext } from "./types.ts";
import type { HubLogger } from "../contract/host.ts";

/** 插件原始配置里属于平台层的部分。 */
export interface PlatformConfig {
  devOverrides?: {
    enabled?: boolean;
    homeDir?: string;
    /** 打开后启用「故意失败」的演示模块，用来验证降级不影响 DSH。 */
    failureDemo?: boolean;
    /**
     * 调试开关：让指定的真实模块在装载时**强制抛错**（降级验证用）。
     *
     * 只可能来自 dev profile 自己的 patch；包内 cordis.patch.yml 绝不写它。
     * 例：failModules: ['mcp-config'] ⇒ mcp-config 降级，且依赖它的 mcp-runtime 也降级，
     * mcp 工具退回桩实现（描述里写明原因）。见 docs/DEV.md「降级验证」。
     */
    failModules?: string[];
  };
}

/** 极简的 cordis ctx 视图（只列平台层用到的部分）。 */
export interface HostCtxView {
  get?(name: string, strict?: boolean): unknown;
  logger?: Partial<HubLogger> & Record<string, unknown>;
  [key: string]: unknown;
}

/** 安全读取 ctx 上的任意服务：失败/缺失都返回 undefined。 */
export function safeGet(ctx: unknown, name: string): unknown {
  const view = ctx as HostCtxView;
  if (typeof view?.get !== "function") return undefined;
  try {
    return view.get(name, false);
  } catch {
    return undefined;
  }
}

/** 包一个恒不抛错的 logger。 */
export function makeLogger(ctx: unknown, tag = "[capability-hub]"): HubLogger {
  const raw = (ctx as HostCtxView)?.logger as Record<string, unknown> | undefined;
  const bind = (level: keyof HubLogger, fallback: (...a: unknown[]) => void): ((...a: unknown[]) => void) => {
    const fn = raw?.[level];
    if (typeof fn !== "function") return fallback;
    return (...args: unknown[]) => {
      try {
        (fn as (...a: unknown[]) => void).call(raw, tag, ...args);
      } catch {
        fallback(...args);
      }
    };
  };
  return {
    debug: bind("debug", () => {}),
    info: bind("info", () => {}),
    warn: bind("warn", (...a) => console.warn(tag, ...a)),
    error: bind("error", (...a) => console.error(tag, ...a)),
  };
}

/**
 * 遍历组合树所需的「条目」形状。
 *
 * 实测定下来的事实（阶段 B，见 boot.json 的 skillSources）：
 *   - ctx.loader.entries() 返回**扁平的顶层条目**（本机 dev profile 187 条，
 *     其中 cordis:include 分组会把成员条目再列一遍）；
 *   - 嵌套条目挂在 entry.subgroup / entry.subtree 上（分组条目才有），
 *     子条目本身也是同形状的 entry（自己的 options / fiber / subgroup）；
 *   - 真正解析后的配置在 entry.fiber.config 上（entry.options.config 是原始配置）。
 * 因为不知道 cordis 内部容器的确切类型，这里对「子容器」做防御式枚举：
 * 数组 / Map / 有 entries()|values()|children 的对象 / 可迭代对象都试一遍。
 */
interface LoaderEntryLike {
  options?: { id?: unknown; name?: unknown; disabled?: unknown; config?: unknown };
  fiber?: { config?: unknown };
  disabled?: unknown;
  subgroup?: unknown;
  subtree?: unknown;
  [key: string]: unknown;
}

function isEntryLike(value: unknown): value is LoaderEntryLike {
  return typeof value === "object" && value !== null && (value as LoaderEntryLike).options !== undefined;
}

/** 把任意「子容器」里的条目收集出来（认不出来就当空，绝不抛）。 */
function collectChildren(container: unknown, out: LoaderEntryLike[]): void {
  if (container === undefined || container === null) return;
  if (isEntryLike(container)) {
    out.push(container);
    return;
  }
  if (Array.isArray(container)) {
    for (const item of container) if (isEntryLike(item)) out.push(item);
    return;
  }
  const record = container as Record<string, unknown>;
  for (const key of ["entries", "values", "children"]) {
    const value = record[key];
    if (typeof value === "function") {
      try {
        const produced = (value as () => unknown).call(container);
        if (Array.isArray(produced)) {
          for (const item of produced) if (isEntryLike(item)) out.push(item);
        } else if (produced !== undefined && produced !== null && typeof (produced as Iterable<unknown>)[Symbol.iterator] === "function") {
          for (const item of produced as Iterable<unknown>) if (isEntryLike(item)) out.push(item);
        }
      } catch {
        /* 认不出来就跳过这个访问器 */
      }
      return;
    }
    if (value instanceof Map) {
      for (const item of value.values()) if (isEntryLike(item)) out.push(item);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) if (isEntryLike(item)) out.push(item);
      return;
    }
  }
  const iterator = (container as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  if (typeof iterator === "function") {
    try {
      for (const item of container as Iterable<unknown>) if (isEntryLike(item)) out.push(item);
    } catch {
      /* 迭代失败就当没有子条目 */
    }
  }
}

/** 取一个条目的子条目（subgroup / subtree 两个已知挂点）。 */
function entryChildren(entry: LoaderEntryLike): LoaderEntryLike[] {
  const out: LoaderEntryLike[] = [];
  collectChildren(entry.subgroup, out);
  collectChildren(entry.subtree, out);
  return out;
}

/**
 * 已知的「官方内置技能目录」的 !!js 表达式特征串。
 *
 * desktop 的 agent 预设里那条 skill-filesystem 的 customSkillDirs 是一个 !!js 表达式：
 *   process.getBuiltinModule('node:path').join(
 *     ...dirname(createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')),
 *     'skills')
 * **实测：cordis 在组合期并不求值它**，运行时留给我们的是 { __jsExpr: "<表达式文本>" }
 * （见 boot.json 的 skillSources.presetSpecs.configPreview）。我们绝不 eval 别人的表达式，
 * 但这一条的语义是确定的（「该包同级的 skills 目录」），因此用 import.meta.resolve /
 * createRequire 等价地推一下 —— 推不出来就退回「未解析」，只记说明、绝不影响其他来源。
 * 本机实测：两种解析方式都拿不到该包（'@deepseek-ai/dsh-agent-preset' 不在插件进程的
 * 解析路径上），所以最终结果是「未解析」。
 */
const AGENT_PRESET_SKILLS_EXPR_MARKER = "dsh-agent-preset/package.json";

/** 推导尝试的逐步记录（诊断用，boot.json 里可见）。 */
export interface AgentPresetResolveAttempt {
  via: string;
  value?: string;
  error?: string;
  skillsDir?: string;
  exists?: boolean;
}

let agentPresetAttempts: AgentPresetResolveAttempt[] = [];

/** 上次推导的逐步记录（诊断用）。 */
export function lastAgentPresetAttempts(): AgentPresetResolveAttempt[] {
  return [...agentPresetAttempts];
}

/** 把 file: URL 或路径统一成文件系统路径。 */
function toFilePath(value: string): string {
  try {
    return fileURLToPath(new URL(value));
  } catch {
    return value;
  }
}

/** 等价的「官方 agent 预设内置技能目录」；推不出来返回 undefined。 */
function resolveAgentPresetSkillsDir(): string | undefined {
  const attempts: AgentPresetResolveAttempt[] = [];
  agentPresetAttempts = attempts;
  const finish = (dir: string | undefined): string | undefined => {
    attempts.push({ via: "结果", ...(dir === undefined ? {} : { skillsDir: dir }), exists: dir !== undefined && existsSync(dir) });
    return dir;
  };

  // 1) import.meta.resolve（DSH 的模块解析拦截层在本进程内对 ESM 说明符有效）
  try {
    const resolveFn = (import.meta as { resolve?: (specifier: string) => string }).resolve;
    if (typeof resolveFn !== "function") {
      attempts.push({ via: "import.meta.resolve", error: "不可用（没有该函数）" });
    } else {
      const resolved = resolveFn("@deepseek-ai/dsh-agent-preset/package.json");
      attempts.push({ via: "import.meta.resolve", value: resolved });
      const dir = join(dirname(toFilePath(resolved)), "skills");
      if (existsSync(dir)) return finish(dir);
      attempts.push({ via: "import.meta.resolve", skillsDir: dir, exists: false });
    }
  } catch (error) {
    attempts.push({ via: "import.meta.resolve", error: error instanceof Error ? error.message : String(error) });
  }

  // 2) createRequire（profile 侧的 require 解析）
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("@deepseek-ai/dsh-agent-preset/package.json");
    attempts.push({ via: "createRequire", value: resolved });
    const dir = join(dirname(resolved), "skills");
    if (existsSync(dir)) return finish(dir);
    attempts.push({ via: "createRequire", skillsDir: dir, exists: false });
  } catch (error) {
    attempts.push({ via: "createRequire", error: error instanceof Error ? error.message : String(error) });
  }
  return finish(undefined);
}

/** 未解析的 !!js 表达式（cordis 组合期保留的形态）。 */
function jsExprOf(value: unknown): string | undefined {
  const expr = (value as { __jsExpr?: unknown } | undefined)?.__jsExpr;
  return typeof expr === "string" && expr !== "" ? expr : undefined;
}

/** 一个 skill-filesystem 来源对最终 skill 根的贡献（诊断与去重都用它）。 */
export interface SkillProviderContribution {
  /** 来源种类：entry = 组合树里真实挂载的条目；preset-spec = agent 预设/分组里的插件声明。 */
  kind: "entry" | "preset-spec";
  /** 条目 / 插件声明的 id。 */
  id: string;
  /** 包名。 */
  name: string;
  /** preset-spec 时承载它的条目 id。 */
  parent?: string;
  /** 是否停用（停用的**不参与**取值）。 */
  disabled: boolean;
  /** 配置的取值来源：fiber = 运行期已解析；options = 条目原始配置；preset = 预设里的插件声明。 */
  source: "fiber" | "options" | "preset";
  /** 该来源贡献的 customSkillDirs（已去重）。 */
  customSkillDirs: string[];
  bundledSkillDir?: string;
  /** 该来源里未能解析的 !!js 表达式（原文，供排查用；不参与取值）。 */
  unresolvedDirs?: string[];
  /** 是否有目录由 !!js 表达式等价推导得到。 */
  viaExpr?: boolean;
  /** 说明（中文，健康检查里可见）。 */
  note?: string;
}

/** 组合树里所有 skill-filesystem 来源的扫描结果。 */
export interface SkillProviderScan {
  /** loader.entries() 返回的顶层条目数。 */
  rootEntries: number;
  /** 遍历过的条目总数（含嵌套）。 */
  scannedEntries: number;
  /** 命中的 skill-filesystem 来源数（含停用的，含预设里的插件声明）。 */
  matched: number;
  /** 参与取值的来源数（未停用的）。 */
  active: number;
  /** 去重后的 customSkillDirs 并集（Windows 下按不区分大小写的规范化路径去重）。 */
  customSkillDirs: string[];
  bundledSkillDir?: string;
  /** bundledSkillDir 的来源。 */
  bundledSource?: "config" | "env";
  /** 逐来源的贡献（诊断用）。 */
  contributions: SkillProviderContribution[];
}

/** Windows 下路径比较要不区分大小写：这是去重用的规范化键。 */
export function pathKey(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 一个「插件声明」的形状（agent 预设 config.plugins / cordis:group config 数组里的元素）。 */
interface PluginSpecLike {
  id?: unknown;
  name?: unknown;
  disabled?: unknown;
  config?: unknown;
  plugins?: unknown;
}

/** 从任意容器里取出插件声明列表（数组 / { plugins: [...] } / 单个声明）。 */
function pluginSpecsOf(container: unknown): PluginSpecLike[] {
  if (container === undefined || container === null) return [];
  if (Array.isArray(container)) {
    return container.filter((item): item is PluginSpecLike => typeof item === "object" && item !== null) as PluginSpecLike[];
  }
  if (typeof container === "object") {
    const record = container as PluginSpecLike;
    if (Array.isArray(record.plugins)) {
      return record.plugins.filter((item): item is PluginSpecLike => typeof item === "object" && item !== null) as PluginSpecLike[];
    }
    if (typeof record.name === "string") return [record];
  }
  return [];
}

/**
 * 遍历组合树，取所有**未停用**的 skill-filesystem 来源的已解析配置，求并集。
 *
 * 为什么有两种来源（这是踩过的坑，必须写下来）：
 *   1. **条目**（kind: entry）：组合树里真实挂载的 cordis 条目，含嵌套在分组里
 *      （subgroup / subtree）的那些。读的是 entry.fiber.config（运行期已解析，
 *      !!js 表达式已求值）> entry.options.config（原始配置）。
 *   2. **预设里的插件声明**（kind: preset-spec）：desktop 的合成配置把带
 *      customSkillDirs 的 skill-filesystem 写在 **agent 预设的 config.plugins 列表**里
 *      （desktop cordis.yml 第 651/833/1247 行附近，第 1247 条带
 *      customSkillDirs: [!!js …@deepseek-ai/dsh-agent-preset/skills]），
 *      而预设的插件是**按会话**挂载的，在基础作用域的 loader.entries() 里根本看不到
 *      （实测：dev profile 遍历 187 个条目只命中 1 个 skill-filesystem，还是 disabled 的那个；
 *      4 个 agent 预设里 3 个带 skill-filesystem 声明）。只看条目会让 desktop 得到空数组。
 *
 * 停用的来源一律跳过（官方语义：disabled 的条目不提供技能根）。
 */
export function readSkillProviderConfig(ctx: unknown): SkillProviderScan {
  const scan: SkillProviderScan = {
    rootEntries: 0,
    scannedEntries: 0,
    matched: 0,
    active: 0,
    customSkillDirs: [],
    contributions: [],
  };
  const dirs = new Map<string, string>();
  const loader = safeGet(ctx, "loader") as { entries?(): Iterable<unknown> } | undefined;
  if (loader === undefined || typeof loader.entries !== "function") return scan;

  let roots: unknown[] = [];
  try {
    roots = [...loader.entries()];
  } catch {
    return scan;
  }

  /** 把一个来源的配置并进结果。 */
  const absorb = (
    kind: SkillProviderContribution["kind"],
    id: string,
    name: string,
    disabled: boolean,
    config: { customSkillDirs?: unknown; bundledSkillDir?: unknown } | undefined,
    source: SkillProviderContribution["source"],
    parent?: string,
  ): void => {
    scan.matched += 1;
    if (disabled) {
      scan.contributions.push({
        kind,
        id,
        name,
        ...(parent === undefined ? {} : { parent }),
        disabled: true,
        source,
        customSkillDirs: [],
        note: "已停用，按官方语义不提供技能根",
      });
      return;
    }
    scan.active += 1;
    const added: string[] = [];
    const unresolved: string[] = [];
    let viaExpr = false;
    const rawDirs = config?.customSkillDirs;
    if (Array.isArray(rawDirs)) {
      for (const value of rawDirs) {
        let candidate: string | undefined;
        if (typeof value === "string" && value.trim() !== "") {
          candidate = value;
        } else {
          const expr = jsExprOf(value);
          if (expr !== undefined) {
            unresolved.push(expr);
            if (expr.includes(AGENT_PRESET_SKILLS_EXPR_MARKER)) {
              const derived = resolveAgentPresetSkillsDir();
              if (derived !== undefined) {
                candidate = derived;
                viaExpr = true;
                unresolved.pop();
              }
            }
          }
        }
        if (candidate === undefined) continue;
        const absolute = resolve(candidate);
        const key = pathKey(absolute);
        if (dirs.has(key)) continue;
        dirs.set(key, absolute);
        added.push(absolute);
      }
    }
    let bundled: string | undefined;
    if (typeof config?.bundledSkillDir === "string" && config.bundledSkillDir.trim() !== "") {
      bundled = resolve(config.bundledSkillDir);
    }
    if (bundled !== undefined && scan.bundledSkillDir === undefined) {
      scan.bundledSkillDir = bundled;
      scan.bundledSource = "config";
    }
    scan.contributions.push({
      kind,
      id,
      name,
      ...(parent === undefined ? {} : { parent }),
      disabled: false,
      source,
      customSkillDirs: added,
      ...(bundled === undefined ? {} : { bundledSkillDir: bundled }),
      ...(unresolved.length === 0 ? {} : { unresolvedDirs: unresolved }),
      ...(viaExpr ? { viaExpr: true } : {}),
      ...(added.length === 0 && bundled === undefined
        ? { note: unresolved.length > 0 ? "customSkillDirs 是未解析的 !!js 表达式，且本进程推不出等价路径" : "该来源没有配置 customSkillDirs" }
        : {}),
    });
  };

  /** 递归展开一个插件声明容器（agent 预设的 plugins、cordis:group 的 config 数组）。 */
  const walkSpecs = (specs: PluginSpecLike[], parentId: string, depth: number): void => {
    if (depth > 3) return;
    for (const spec of specs) {
      const name = typeof spec?.name === "string" ? spec.name : "";
      const id = typeof spec?.id === "string" ? spec.id : name;
      if (name !== "") {
        const disabled = spec.disabled === true;
        if (name.endsWith("dsh-skill-filesystem")) {
          absorb(
            "preset-spec",
            id,
            name,
            disabled,
            spec.config as { customSkillDirs?: unknown; bundledSkillDir?: unknown } | undefined,
            "preset",
            parentId,
          );
        }
      }
      // 声明里还可以再嵌分组（cordis:group 的 config 是数组、预设里也可能嵌 plugins）
      walkSpecs(pluginSpecsOf(spec?.config), parentId + "/" + id, depth + 1);
      if (spec?.plugins !== undefined) walkSpecs(pluginSpecsOf(spec.plugins), parentId + "/" + id, depth + 1);
    }
  };

  const queue: LoaderEntryLike[] = roots.filter(isEntryLike);
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (seen.has(entry)) continue;
    seen.add(entry);
    scan.scannedEntries += 1;
    for (const child of entryChildren(entry)) if (!seen.has(child)) queue.push(child);

    const name = typeof entry.options?.name === "string" ? entry.options.name : "";
    const id = typeof entry.options?.id === "string" ? entry.options.id : name;
    const disabled = entry.options?.disabled === true || entry.disabled === true;

    if (name.endsWith("dsh-skill-filesystem")) {
      const fiberConfig = entry.fiber?.config;
      const rawConfig = entry.options?.config;
      const source: SkillProviderContribution["source"] = fiberConfig !== undefined ? "fiber" : "options";
      const config = (source === "fiber" ? fiberConfig : rawConfig) as { customSkillDirs?: unknown; bundledSkillDir?: unknown } | undefined;
      absorb("entry", id, name, disabled, config, source);
    }

    // 预设 / 分组里的插件声明（desktop 的 customSkillDirs 就在这里）。
    if (!disabled) {
      const container = entry.options?.config;
      const specs = pluginSpecsOf(container);
      if (specs.length > 0) walkSpecs(specs, id, 0);
    }
  }

  // loader.entries() 的顶层计数：注意其中有 cordis:include 会把同一批条目再列一遍，
  // 去重后（scannedEntries）才是真实条目数。
  scan.rootEntries = roots.filter(isEntryLike).length;
  scan.customSkillDirs = [...dirs.values()];
  // 官方优先级：config.bundledSkillDir ?? $DSH_BUNDLED_SKILL_DIR（后者只在本进程环境里可见时才用）。
  if (scan.bundledSkillDir === undefined) {
    const fromEnv = process.env.DSH_BUNDLED_SKILL_DIR;
    if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
      scan.bundledSkillDir = resolve(fromEnv);
      scan.bundledSource = "env";
    }
  }
  return scan;
}

/** 诊断用：把任意值压成一小段可读文本（!!js 的残留形态就此现形）。 */
function previewOf(value: unknown): string {
  if (value === undefined) return "(undefined)";
  try {
    const json = JSON.stringify(value, (_key, item) => {
      if (typeof item === "function") return "[function " + ((item as () => void).name || "anonymous") + "]";
      return item as unknown;
    });
    return (json ?? "(undefined)").slice(0, 400);
  } catch {
    return "(无法序列化)";
  }
}

/** 组合树的一个节点（诊断用，只保留名字与子节点）。 */
export interface EntryTreeNode {
  id: string;
  name: string;
  disabled: boolean;
  /** 该节点的子节点（受 maxDepth 限制）。 */
  children: EntryTreeNode[];
  /** 被截断的子节点数。 */
  truncated: number;
}

/**
 * 把 loader 的组合树 dump 成有限深度的结构（诊断用；任何异常都吞掉）。
 * 为什么需要它：customSkillDirs 只可能来自组合树里的 skill-filesystem 来源，
 * 而 desktop 的合成配置把这类条目**嵌套在 agent 预设分组里**，
 * 必须能在真实进程里看到「树长什么样、嵌套到第几层」才能确认遍历方式对不对。
 */
export function dumpEntryTree(ctx: unknown, maxDepth = 3, maxChildren = 40): EntryTreeNode | undefined {
  try {
    const loader = safeGet(ctx, "loader") as { entries?(): Iterable<unknown> } | undefined;
    if (loader === undefined || typeof loader.entries !== "function") return undefined;
    const roots = [...loader.entries()].filter(isEntryLike);
    const build = (entry: LoaderEntryLike, depth: number): EntryTreeNode => {
      const name = typeof entry.options?.name === "string" ? entry.options.name : "";
      const id = typeof entry.options?.id === "string" ? entry.options.id : name;
      const children = depth >= maxDepth ? [] : entryChildren(entry);
      const shown = children.slice(0, maxChildren).map((child) => build(child, depth + 1));
      return {
        id,
        name,
        disabled: entry.options?.disabled === true || entry.disabled === true,
        children: shown,
        truncated: Math.max(0, children.length - shown.length),
      };
    };
    return {
      id: "(root)",
      name: `${roots.length} 个顶层条目`,
      disabled: false,
      children: roots.slice(0, maxChildren).map((entry) => build(entry, 1)),
      truncated: Math.max(0, roots.length - maxChildren),
    };
  } catch {
    return undefined;
  }
}

/**
 * 诊断用：列出 loader 里的条目名与 skills 服务自身的键。
 *
 * 为什么需要它：customSkillDirs / bundledSkillDir 拿不到时只能记空，但「为什么拿不到」
 * 看不出来。启动报告里带上这些名单与结构，就能判断是 provider 名字不匹配还是服务形状不同。
 * 纯只读探测，任何异常都吞掉。
 */
export function probeSkillSources(ctx: unknown): {
  providerNames: string[];
  skillsKeys: string[];
  skillEntries: Array<{ name: string; configKeys: string[]; config: string }>;
  /** 组合树遍历统计（阶段 B 新增：验证嵌套条目确实被走到）。 */
  treeSize: number;
  nestedEntries: number;
  /** 所有 skill-filesystem 来源的扫描结果（阶段 B 的 customSkillDirs 就是从这里来的）。 */
  skillProviders: SkillProviderScan;
  /** 组合树的结构快照（有限深度，诊断「嵌套条目到底在不在树里」）。 */
  tree: EntryTreeNode | undefined;
  /**
   * agent 预设里声明的插件清单（截断）。用途：证明 `!!js` 表达式在**插件声明里**
   * 的保留形态（{\__jsExpr: "..."}）—— desktop 的 customSkillDirs 就是一条 !!js 表达式。
   */
  presetSpecs: Array<{ entry: string; specs: Array<{ id: string; name: string; disabled: boolean; configKeys: string[]; configPreview: string }> }>;
  /** `!!js` 等价路径推导的逐步记录。 */
  agentPresetResolve: AgentPresetResolveAttempt[];
  /** skills 服务自身的形状探测（找运行期已解析的技能根）。 */
  skillsProbe: Record<string, unknown>;
  /** 解构后的 plugins 配置（fiber.config.plugins，若存在）—— 用来判断 !!js 有没有被求值。 */
  presetFiberSpecs: Array<{ entry: string; count: number; preview: string }>;
  /** 环境变量 DSH_BUNDLED_SKILL_DIR 的取值（null = 未设置）。 */
  bundledEnv: string | null;
} {
  const providerNames: string[] = [];
  const skillsKeys: string[] = [];
  const skillEntries: Array<{ name: string; configKeys: string[]; config: string }> = [];
  let treeSize = 0;
  let nestedEntries = 0;
  try {
    const loader = safeGet(ctx, "loader") as { entries?(): Iterable<unknown> } | undefined;
    if (loader !== undefined && typeof loader.entries === "function") {
      // 阶段 B：遍历**整棵组合树**（子条目挂在 subgroup/subtree 上），
      // 而不是只看 loader.entries() 返回的顶层条目 —— agent 预设分组里的
      // skill-filesystem 条目就是嵌套的（desktop cordis.yml 第 651/833/1247 行）。
      const queue: LoaderEntryLike[] = [...loader.entries()].filter(isEntryLike);
      const seenEntries = new Set<unknown>();
      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (seenEntries.has(entry)) continue;
        seenEntries.add(entry);
        treeSize += 1;
        for (const child of entryChildren(entry)) {
          if (!seenEntries.has(child)) {
            nestedEntries += 1;
            queue.push(child);
          }
        }
        const options = entry.options;
        const name = options?.name;
        if (typeof name === "string" && name !== "") {
          providerNames.push(name);
          if (name.includes("skill")) {
            const config = options?.config;
            let serialized = "";
            try {
              serialized = JSON.stringify(config ?? null);
            } catch {
              serialized = "(无法序列化)";
            }
            let entryShape = "";
            try {
              const own = Object.keys(entry).join("|");
              const optionKeys = Object.keys(options as object).join("|");
              const direct = Object.keys(entry)
                .map((key) => key + "=" + (() => { try { return JSON.stringify(entry[key])?.slice(0, 120); } catch { return "?"; } })())
                .join(" ; ");
              entryShape = "own[" + own + "] options[" + optionKeys + "] " + direct;
            } catch {
              entryShape = "(读取失败)";
            }
            let fiberShape = "";
            try {
              const fiber = entry.fiber;
              const fiberConfig = fiber?.config;
              fiberShape = "fiber?=" + (fiber !== undefined) + " fiberCfg=" + JSON.stringify(fiberConfig ?? null).slice(0, 400);
            } catch {
              fiberShape = "fiber=(循环)";
            }
            skillEntries.push({
              name,
              configKeys: config !== null && typeof config === "object" ? Object.keys(config) : [],
              config: serialized.slice(0, 600) + " ||| " + entryShape.slice(0, 300) + " ||| " + fiberShape,
            });
          }
        }
      }
    }
  } catch {
    /* 探测失败忽略 */
  }
  let skillsProbe: Record<string, unknown> = {};
  try {
    const skills = safeGet(ctx, "skills") as object | undefined;
    if (skills !== undefined && (typeof skills === "object" || typeof skills === "function")) {
      for (const key of Object.keys(skills)) {
        skillsKeys.push(key);
        let value: unknown;
        try {
          value = (skills as Record<string, unknown>)[key];
        } catch {
          skillsProbe[key] = "(读取抛错)";
          continue;
        }
        if (value instanceof Map) {
          const items: string[] = [];
          let index = 0;
          for (const [mapKey, mapValue] of value) {
            if (index >= 12) break;
            items.push(previewOf(mapKey) + " => " + previewOf(mapValue).slice(0, 300));
            index += 1;
          }
          skillsProbe[key] = { kind: "Map", size: value.size, items };
        } else if (Array.isArray(value)) {
          skillsProbe[key] = { kind: "Array", size: value.length, items: value.slice(0, 8).map((item) => previewOf(item).slice(0, 300)) };
        } else if (value !== null && typeof value === "object") {
          // layers.global / layers.scoped 里可能藏着「运行期已解析」的技能根，深挖一层。
          const deep: Record<string, unknown> = {};
          for (const sub of Object.keys(value as object).slice(0, 20)) {
            try {
              const inner = (value as Record<string, unknown>)[sub];
              if (inner instanceof Map) {
                const items: string[] = [];
                let index = 0;
                for (const [mapKey, mapValue] of inner) {
                  if (index >= 20) break;
                  items.push(previewOf(mapKey) + " => " + previewOf(mapValue).slice(0, 400));
                  index += 1;
                }
                deep[sub] = { kind: "Map", size: inner.size, items };
              } else if (Array.isArray(inner)) {
                deep[sub] = { kind: "Array", size: inner.length, items: inner.slice(0, 10).map((item) => previewOf(item).slice(0, 400)) };
              } else {
                deep[sub] = { kind: typeof inner, value: previewOf(inner).slice(0, 300) };
              }
            } catch {
              deep[sub] = "(读取抛错)";
            }
          }
          skillsProbe[key] = { kind: "object", keys: Object.keys(value as object).slice(0, 30), deep };
        } else {
          skillsProbe[key] = { kind: typeof value, value: previewOf(value).slice(0, 200) };
        }
      }
    }
  } catch {
    /* 探测失败忽略 */
  }
  return {
    providerNames,
    skillsKeys,
    skillEntries,
    treeSize,
    nestedEntries,
    skillProviders: readSkillProviderConfig(ctx),
    tree: dumpEntryTree(ctx),
    presetSpecs: (() => {
      const out: Array<{ entry: string; specs: Array<{ id: string; name: string; disabled: boolean; configKeys: string[]; configPreview: string }> }> = [];
      try {
        const loader2 = safeGet(ctx, "loader") as { entries?(): Iterable<unknown> } | undefined;
        for (const raw of loader2?.entries?.() ?? []) {
          if (!isEntryLike(raw)) continue;
          const entryName = typeof raw.options?.name === "string" ? raw.options.name : "";
          if (!entryName.endsWith("dsh-agent-preset")) continue;
          const specs = pluginSpecsOf(raw.options?.config).slice(0, 40).map((spec) => ({
            id: typeof spec.id === "string" ? spec.id : "",
            name: typeof spec.name === "string" ? spec.name : "",
            disabled: spec.disabled === true,
            configKeys: spec.config !== null && typeof spec.config === "object" ? Object.keys(spec.config as object) : [],
            configPreview: previewOf(spec.config),
          }));
          out.push({ entry: typeof raw.options?.id === "string" ? raw.options.id : entryName, specs });
        }
      } catch {
        /* 诊断失败忽略 */
      }
      return out;
    })(),
    agentPresetResolve: lastAgentPresetAttempts(),
    skillsProbe,
    presetFiberSpecs: (() => {
      const out: Array<{ entry: string; count: number; preview: string }> = [];
      try {
        const loader3 = safeGet(ctx, "loader") as { entries?(): Iterable<unknown> } | undefined;
        for (const raw of loader3?.entries?.() ?? []) {
          if (!isEntryLike(raw)) continue;
          const entryName = typeof raw.options?.name === "string" ? raw.options.name : "";
          if (!entryName.endsWith("dsh-agent-preset")) continue;
          const fiberConfig = raw.fiber?.config as { plugins?: unknown } | undefined;
          const specs = pluginSpecsOf(fiberConfig?.plugins);
          const skill = specs.find((spec) => typeof spec.name === "string" && spec.name.endsWith("dsh-skill-filesystem"));
          out.push({
            entry: typeof raw.options?.id === "string" ? raw.options.id : entryName,
            count: specs.length,
            preview: previewOf(skill?.config),
          });
        }
      } catch {
        /* 诊断失败忽略 */
      }
      return out;
    })(),
    bundledEnv: typeof process.env.DSH_BUNDLED_SKILL_DIR === "string" && process.env.DSH_BUNDLED_SKILL_DIR !== ""
      ? process.env.DSH_BUNDLED_SKILL_DIR
      : null,
  };
}

/** 解析 dshHome：显式配置 > 环境变量 > <homeDir>/.dsh。 */
export function resolveDshHome(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv);
  return join(homeDir, ".dsh");
}

/** 解析 profile 名与目录。 */
function readProfileContext(ctx: unknown): { name: string; dir: string } {
  const profile = safeGet(ctx, "profileContext") as { name?: unknown; dir?: unknown } | undefined;
  return {
    name: typeof profile?.name === "string" && profile.name !== "" ? profile.name : "unknown",
    dir: typeof profile?.dir === "string" ? profile.dir : "",
  };
}

/**
 * 构造 HubContext。
 * @param ctx DSH 插件上下文（根 ctx）
 * @param config 插件原始配置
 * @param packageRoot 本包宿主半目录（import.meta.dirname）
 * @param logger 已包好的日志面（可不传）
 */
export function resolveHubContext(
  ctx: unknown,
  config: PlatformConfig,
  packageRoot: string,
  logger?: HubLogger,
): PlatformContext {
  const log = logger ?? makeLogger(ctx);
  const overrides = config?.devOverrides;
  const overrideHome = overrides?.enabled === true && typeof overrides.homeDir === "string" && overrides.homeDir.trim() !== ""
    ? resolve(overrides.homeDir)
    : undefined;
  const homeDir = overrideHome ?? homedir();
  const dshHome = resolveDshHome(homeDir);
  const hubHome = join(dshHome, "storages", "dsh-capability-hub");
  const profile = readProfileContext(ctx);
  const skills = readSkillProviderConfig(ctx);
  /**
   * customSkillDirs 是**活值**（getter，每次读都重新遍历组合树）。
   *
   * 为什么不能只算一次：agent 预设里的 skill-filesystem 条目是**按会话挂载**的，
   * 插件刚启动（还没有任何会话）时组合树里根本看不到它们的已解析配置。
   * 静态快照会让 desktop 永远得到空数组；每次读都重扫（187 个条目、无 I/O 重活）
   * 才能在预设挂载后立刻看见新的只读技能根。
   */
  const liveCustomSkillDirs = (): string[] => {
    try {
      return readSkillProviderConfig(ctx).customSkillDirs;
    } catch {
      return [...skills.customSkillDirs];
    }
  };
  log.info(
    `技能根来源：遍历 ${skills.scannedEntries} 个条目，命中 skill-filesystem ${skills.matched} 个（未停用 ${skills.active} 个）` +
    `，customSkillDirs ${skills.customSkillDirs.length} 个` +
    (skills.bundledSkillDir === undefined ? "，bundledSkillDir 未取到" : `，bundledSkillDir（${skills.bundledSource}）=${skills.bundledSkillDir}`),
  );
  for (const note of skills.contributions.filter((c) => c.disabled || c.note !== undefined)) {
    log.debug(`skill-filesystem 来源 ${note.kind}/${note.id}：${note.disabled ? "已停用" : (note.note ?? "已采用")}`);
  }
  const context: PlatformContext = {
    homeDir,
    dshHome,
    hubHome,
    profileName: profile.name,
    profileDir: profile.dir,
    packageRoot,
    logger: log,
    get customSkillDirs(): string[] {
      return liveCustomSkillDirs();
    },
    ...(skills.bundledSkillDir === undefined ? {} : { bundledSkillDir: skills.bundledSkillDir }),
  };
  return context;
}
