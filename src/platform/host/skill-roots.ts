/**
 * DSH 会从哪些目录加载技能：遍历组合树里所有**未停用**的 skill-filesystem 来源，
 * 取 customSkillDirs 的并集与 bundledSkillDir（本地技能模块据此列出「只读技能目录」）。
 *
 * 两种来源（踩过的坑，必须写下来）：
 *   1. **条目**（entry）：组合树里真实挂载的 skill-filesystem 条目（含嵌套在分组里的）。
 *      配置取运行期已解析的 fiber.config，没有再退回原始的 options.config。
 *   2. **预设里的插件声明**（preset-spec）：desktop 把带 customSkillDirs 的 skill-filesystem 写在
 *      agent 预设的 config.plugins 列表里。预设的插件是**按会话**挂载的，基础作用域的组合树里只看得到
 *      这份声明（实测 dev profile：187 个条目只有 1 个 skill-filesystem 条目，还是停用的；
 *      3 个 agent 预设各带一份声明）。只看条目会让 desktop 得到空数组。
 *
 * 停用的来源一律跳过（官方语义：停用的条目不提供技能根）；停用的条目里的插件声明也不展开。
 *
 * desktop 预设里那条 customSkillDirs 是 `!!js` 表达式（「@deepseek-ai/dsh-agent-preset 包旁边的 skills 目录」）。
 * cordis 组合期不求值它，留给我们的是 { __jsExpr: "<表达式文本>" }。我们绝不 eval 别人的表达式，
 * 但这一条的语义是确定的，所以用模块解析等价地推一下；推不出来就记为「未解析」，不影响其他来源。
 * bundledSkillDir：第一个提供它的来源 > 环境变量 DSH_BUNDLED_SKILL_DIR（与官方优先级一致）。
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readComposition } from "./composition.ts";

/** 一个 skill-filesystem 来源对最终技能目录的贡献（诊断与去重都用它）。 */
export interface SkillProviderContribution {
  /** entry = 组合树里真实挂载的条目；preset-spec = agent 预设 / 分组里的插件声明 */
  kind: "entry" | "preset-spec";
  id: string;
  /** 包名 */
  name: string;
  /** preset-spec 时承载它的条目 id（嵌套时用 / 连接） */
  parent?: string;
  disabled: boolean;
  /** fiber = 运行期已解析；options = 条目原始配置；preset = 预设里的插件声明 */
  source: "fiber" | "options" | "preset";
  /** 该来源贡献的目录（已去重，先到先得） */
  customSkillDirs: string[];
  bundledSkillDir?: string;
  /** 未能解析的 !!js 表达式原文（不参与取值） */
  unresolvedDirs?: string[];
  /** 有目录是由 !!js 表达式等价推导得到的 */
  viaExpr?: boolean;
  /** 中文说明（健康检查与启动报告里可见） */
  note?: string;
}

/** 「@deepseek-ai/dsh-agent-preset 旁边的 skills 目录」的推导过程（诊断用）。 */
export interface PresetResolveAttempt {
  via: string;
  value?: string;
  error?: string;
  skillsDir?: string;
  exists?: boolean;
}

export interface PresetSkillsDir {
  dir?: string;
  attempts: PresetResolveAttempt[];
}

/** 组合树里所有 skill-filesystem 来源的扫描结果。 */
export interface SkillProviderScan {
  /** loader.entries() 的顶层条目数（含 cordis:include 重复列出的） */
  rootEntries: number;
  /** 去重后遍历过的条目数（含嵌套） */
  scannedEntries: number;
  /** 命中的 skill-filesystem 来源数（含停用的、含预设里的声明） */
  matched: number;
  /** 参与取值的来源数 */
  active: number;
  /** 去重后的目录并集（Windows 下不区分大小写） */
  customSkillDirs: string[];
  bundledSkillDir?: string;
  bundledSource?: "config" | "env";
  contributions: SkillProviderContribution[];
  /** 遇到预设的 !!js 表达式时，等价推导的过程 */
  presetResolve?: PresetResolveAttempt[];
}

export interface SkillRootsOptions {
  /** 读 DSH_BUNDLED_SKILL_DIR 用；默认 process.env */
  env?: Record<string, string | undefined>;
  /** 推导预设旁边的 skills 目录；默认用模块解析（单测注入） */
  resolvePresetSkillsDir?: () => PresetSkillsDir;
}

const SKILL_PROVIDER_SUFFIX = "dsh-skill-filesystem";
const AGENT_PRESET_EXPR_MARKER = "dsh-agent-preset/package.json";
const AGENT_PRESET_PACKAGE_JSON = "@deepseek-ai/dsh-agent-preset/package.json";

/** Windows 下路径比较不区分大小写：去重用的规范化键。 */
export function pathKey(value: string): string {
  const normalized = resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function toFilePath(value: string): string {
  try {
    return fileURLToPath(new URL(value));
  } catch {
    return value;
  }
}

/** 默认的推导：import.meta.resolve（DSH 的模块解析）→ createRequire（profile 侧解析）。 */
export function resolveAgentPresetSkillsDir(): PresetSkillsDir {
  const attempts: PresetResolveAttempt[] = [];
  const finish = (dir: string | undefined): PresetSkillsDir => {
    attempts.push({ via: "结果", ...(dir === undefined ? {} : { skillsDir: dir }), exists: dir !== undefined });
    return dir === undefined ? { attempts } : { dir, attempts };
  };
  const tryResolved = (via: string, resolved: string): string | undefined => {
    attempts.push({ via, value: resolved });
    const dir = join(dirname(toFilePath(resolved)), "skills");
    if (existsSync(dir)) return dir;
    attempts.push({ via, skillsDir: dir, exists: false });
    return undefined;
  };
  try {
    const resolveFn = (import.meta as { resolve?: (specifier: string) => string }).resolve;
    if (typeof resolveFn !== "function") attempts.push({ via: "import.meta.resolve", error: "不可用（没有该函数）" });
    else {
      const dir = tryResolved("import.meta.resolve", resolveFn(AGENT_PRESET_PACKAGE_JSON));
      if (dir !== undefined) return finish(dir);
    }
  } catch (error) {
    attempts.push({ via: "import.meta.resolve", error: error instanceof Error ? error.message : String(error) });
  }
  try {
    const dir = tryResolved("createRequire", createRequire(import.meta.url).resolve(AGENT_PRESET_PACKAGE_JSON));
    if (dir !== undefined) return finish(dir);
  } catch (error) {
    attempts.push({ via: "createRequire", error: error instanceof Error ? error.message : String(error) });
  }
  return finish(undefined);
}

/** 插件声明（agent 预设 config.plugins / cordis:group 的 config 数组里的元素）。 */
interface PluginSpec {
  id?: unknown;
  name?: unknown;
  disabled?: unknown;
  config?: unknown;
  plugins?: unknown;
}

const isObject = (value: unknown): value is PluginSpec => typeof value === "object" && value !== null;

/** 从任意容器里取出插件声明（数组 / { plugins: [...] } / 单个声明）。 */
function pluginSpecsOf(container: unknown): PluginSpec[] {
  if (Array.isArray(container)) return container.filter(isObject);
  if (!isObject(container)) return [];
  if (Array.isArray(container.plugins)) return container.plugins.filter(isObject);
  return typeof container.name === "string" ? [container] : [];
}

function jsExprOf(value: unknown): string | undefined {
  const expr = (value as { __jsExpr?: unknown } | undefined)?.__jsExpr;
  return typeof expr === "string" && expr !== "" ? expr : undefined;
}

type ProviderConfig = { customSkillDirs?: unknown; bundledSkillDir?: unknown } | undefined;

/** 扫描组合树，得出 DSH 会加载的技能目录。永不抛错。 */
export function scanSkillRoots(ctx: unknown, options: SkillRootsOptions = {}): SkillProviderScan {
  const env = options.env ?? process.env;
  const composition = readComposition(ctx);
  const scan: SkillProviderScan = {
    rootEntries: composition.roots,
    scannedEntries: composition.entries.length,
    matched: 0,
    active: 0,
    customSkillDirs: [],
    contributions: [],
  };
  const dirs = new Map<string, string>();
  let preset: PresetSkillsDir | undefined;
  const presetDir = (): string | undefined => {
    preset ??= (options.resolvePresetSkillsDir ?? resolveAgentPresetSkillsDir)();
    scan.presetResolve = preset.attempts;
    return preset.dir;
  };

  const absorb = (
    base: Pick<SkillProviderContribution, "kind" | "id" | "name" | "source"> & { parent?: string },
    disabled: boolean,
    config: ProviderConfig,
  ): void => {
    scan.matched += 1;
    if (disabled) {
      scan.contributions.push({ ...base, disabled: true, customSkillDirs: [], note: "已停用，按官方语义不提供技能根" });
      return;
    }
    scan.active += 1;
    const added: string[] = [];
    const unresolved: string[] = [];
    let viaExpr = false;
    for (const value of Array.isArray(config?.customSkillDirs) ? config.customSkillDirs : []) {
      let candidate = typeof value === "string" && value.trim() !== "" ? value : undefined;
      const expr = candidate === undefined ? jsExprOf(value) : undefined;
      if (expr !== undefined) {
        const derived = expr.includes(AGENT_PRESET_EXPR_MARKER) ? presetDir() : undefined;
        if (derived === undefined) unresolved.push(expr);
        else {
          candidate = derived;
          viaExpr = true;
        }
      }
      if (candidate === undefined) continue;
      const absolute = resolve(candidate);
      const key = pathKey(absolute);
      if (dirs.has(key)) continue;
      dirs.set(key, absolute);
      added.push(absolute);
    }
    const bundled =
      typeof config?.bundledSkillDir === "string" && config.bundledSkillDir.trim() !== ""
        ? resolve(config.bundledSkillDir)
        : undefined;
    if (bundled !== undefined && scan.bundledSkillDir === undefined) {
      scan.bundledSkillDir = bundled;
      scan.bundledSource = "config";
    }
    const note =
      added.length > 0 || bundled !== undefined
        ? undefined
        : unresolved.length > 0
          ? "customSkillDirs 是未解析的 !!js 表达式，且本进程推不出等价路径"
          : "该来源没有配置 customSkillDirs";
    scan.contributions.push({
      ...base,
      disabled: false,
      customSkillDirs: added,
      ...(bundled === undefined ? {} : { bundledSkillDir: bundled }),
      ...(unresolved.length === 0 ? {} : { unresolvedDirs: unresolved }),
      ...(viaExpr ? { viaExpr: true } : {}),
      ...(note === undefined ? {} : { note }),
    });
  };

  const walkSpecs = (specs: PluginSpec[], parent: string, depth: number): void => {
    if (depth > 3) return;
    for (const spec of specs) {
      const name = typeof spec.name === "string" ? spec.name : "";
      const id = typeof spec.id === "string" ? spec.id : name;
      if (name.endsWith(SKILL_PROVIDER_SUFFIX)) {
        absorb(
          { kind: "preset-spec", id, name, source: "preset", parent },
          spec.disabled === true,
          spec.config as ProviderConfig,
        );
      }
      // 声明里还可以再嵌分组（cordis:group 的 config 是数组，预设里也可能嵌 plugins）
      walkSpecs(pluginSpecsOf(spec.config), parent + "/" + id, depth + 1);
      if (spec.plugins !== undefined) walkSpecs(pluginSpecsOf(spec.plugins), parent + "/" + id, depth + 1);
    }
  };

  for (const entry of composition.entries) {
    if (entry.name.endsWith(SKILL_PROVIDER_SUFFIX)) {
      const source = entry.resolvedConfig !== undefined ? "fiber" : "options";
      const config = (source === "fiber" ? entry.resolvedConfig : entry.config) as ProviderConfig;
      absorb({ kind: "entry", id: entry.id, name: entry.name, source }, entry.disabled, config);
    }
    if (!entry.disabled) walkSpecs(pluginSpecsOf(entry.config), entry.id, 0);
  }

  scan.customSkillDirs = [...dirs.values()];
  const fromEnv = env.DSH_BUNDLED_SKILL_DIR;
  if (scan.bundledSkillDir === undefined && typeof fromEnv === "string" && fromEnv.trim() !== "") {
    scan.bundledSkillDir = resolve(fromEnv);
    scan.bundledSource = "env";
  }
  return scan;
}
