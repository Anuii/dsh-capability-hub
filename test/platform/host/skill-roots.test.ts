/**
 * skill-roots.ts：DSH 会从哪些目录加载技能。夹具照 boot.json 里记录的真实组合树形状搭
 * （扁平顶层 + cordis:include 重复列出 + 分组里的嵌套条目 + agent 预设里的插件声明）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { compositionTree, readComposition } from "../../../src/platform/host/composition.ts";
import { resolveDshHome, resolveHubContext } from "../../../src/platform/host/hub-context.ts";
import { scanSkillRoots, type PresetSkillsDir } from "../../../src/platform/host/skill-roots.ts";

const FS = "@deepseek-ai/dsh-skill-filesystem";
const PRESET_EXPR =
  "process.getBuiltinModule('node:path').join(dirname(createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills')";
const dir = (...parts: string[]): string => path.join(os.tmpdir(), "chub-roots", ...parts);

interface EntryInit {
  id?: string;
  disabled?: boolean;
  config?: unknown;
  fiber?: unknown;
  subgroup?: unknown;
  subtree?: unknown;
}
function entry(name: string, init: EntryInit = {}): Record<string, unknown> {
  return {
    options: { id: init.id ?? name, name, ...(init.disabled ? { disabled: true } : {}), config: init.config },
    ...(init.fiber === undefined ? {} : { fiber: { config: init.fiber } }),
    ...(init.subgroup === undefined ? {} : { subgroup: init.subgroup }),
    ...(init.subtree === undefined ? {} : { subtree: init.subtree }),
  };
}
function ctxOf(roots: unknown[]): unknown {
  return {
    get(name: string): unknown {
      if (name === "loader") return { entries: () => roots };
      throw new Error("Proxy：未知服务 " + name);
    },
  };
}
const noPreset = (): PresetSkillsDir => {
  throw new Error("不该推导预设目录");
};

test("没有 loader、loader 抛错、ctx 本身抛错：都给空结果，不抛", () => {
  for (const ctx of [
    undefined,
    {},
    ctxOf([]),
    {
      get: () => ({
        entries: () => {
          throw new Error("x");
        },
      }),
    },
  ]) {
    const scan = scanSkillRoots(ctx, { env: {}, resolvePresetSkillsDir: noPreset });
    assert.deepEqual(scan.customSkillDirs, []);
    assert.equal(scan.matched, 0);
    assert.equal(scan.bundledSkillDir, undefined);
  }
});

test("desktop 的真实形状：停用条目跳过，预设声明里的 !!js 表达式等价推导成目录", () => {
  const presetSkills = dir("dsh-agent-preset", "skills");
  const standard = entry("@deepseek-ai/dsh-agent-preset", {
    id: "preset-standard",
    config: { plugins: [{ id: "skill-filesystem", name: FS, config: {} }] },
  });
  const cordis = entry("@deepseek-ai/dsh-agent-preset", {
    id: "preset-cordis",
    config: {
      plugins: [{ id: "skill-filesystem", name: FS, config: { customSkillDirs: [{ __jsExpr: PRESET_EXPR }] } }],
    },
  });
  const group = entry("cordis:include", {
    id: "presets",
    subgroup: new Map([
      ["a", standard],
      ["b", cordis],
    ]),
  });
  const disabledFs = entry(FS, { id: "skill-filesystem", disabled: true, config: { customSkillDirs: [dir("never")] } });
  // cordis:include 会把分组成员在顶层再列一遍
  const roots = [disabledFs, group, standard, cordis, entry("@deepseek-ai/dsh-tools")];
  let calls = 0;
  const scan = scanSkillRoots(ctxOf(roots), {
    env: {},
    resolvePresetSkillsDir: () => {
      calls += 1;
      return { dir: presetSkills, attempts: [{ via: "测试", value: "x" }] };
    },
  });
  assert.equal(scan.rootEntries, 5);
  assert.equal(scan.scannedEntries, 5, "按对象去重：重复列出的条目只算一次");
  assert.equal(scan.matched, 3);
  assert.equal(scan.active, 2);
  assert.deepEqual(scan.customSkillDirs, [presetSkills]);
  assert.equal(calls, 1);
  assert.deepEqual(scan.presetResolve, [{ via: "测试", value: "x" }]);
  const byParent = Object.fromEntries(scan.contributions.map((c) => [c.kind + ":" + (c.parent ?? c.id), c]));
  assert.equal(byParent["entry:skill-filesystem"]!.note, "已停用，按官方语义不提供技能根");
  assert.equal(byParent["preset-spec:preset-standard"]!.note, "该来源没有配置 customSkillDirs");
  assert.equal(byParent["preset-spec:preset-cordis"]!.viaExpr, true);
});

test("推不出的表达式记为未解析；与预设无关的表达式不触发推导", () => {
  let calls = 0;
  const roots = [
    entry(FS, { config: { customSkillDirs: [{ __jsExpr: PRESET_EXPR }, { __jsExpr: "somethingElse()" }] } }),
  ];
  const scan = scanSkillRoots(ctxOf(roots), {
    env: {},
    resolvePresetSkillsDir: () => {
      calls += 1;
      return { attempts: [{ via: "结果", exists: false }] };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(scan.customSkillDirs, []);
  assert.deepEqual(scan.contributions[0]!.unresolvedDirs, [PRESET_EXPR, "somethingElse()"]);
  assert.equal(scan.contributions[0]!.note, "customSkillDirs 是未解析的 !!js 表达式，且本进程推不出等价路径");
});

test("条目优先用运行期已解析的配置；相对路径转绝对；目录去重先到先得", () => {
  const a = dir("A");
  const roots = [
    entry(FS, { id: "one", config: { customSkillDirs: [dir("raw")] }, fiber: { customSkillDirs: [a, a + path.sep] } }),
    entry(FS, { id: "two", config: { customSkillDirs: ["relative/skills", "  ", 42] } }),
  ];
  const scan = scanSkillRoots(ctxOf(roots), { env: {}, resolvePresetSkillsDir: noPreset });
  assert.deepEqual(scan.customSkillDirs, [a, path.resolve("relative/skills")]);
  assert.equal(scan.contributions[0]!.source, "fiber");
  assert.equal(scan.contributions[1]!.source, "options");
  if (process.platform === "win32") {
    const upper = scanSkillRoots(ctxOf([entry(FS, { config: { customSkillDirs: [a, a.toUpperCase()] } })]), {
      env: {},
      resolvePresetSkillsDir: noPreset,
    });
    assert.deepEqual(upper.customSkillDirs, [a], "Windows 下不区分大小写");
  }
});

test("停用的预设声明跳过；停用条目里的声明不展开；分组里的嵌套声明能找到", () => {
  const roots = [
    entry("@deepseek-ai/dsh-agent-preset", {
      id: "p1",
      config: {
        plugins: [
          { id: "off", name: FS, disabled: true, config: { customSkillDirs: [dir("off")] } },
          {
            id: "grp",
            name: "cordis:group",
            config: [{ id: "inner", name: FS, config: { customSkillDirs: [dir("inner")] } }],
          },
        ],
      },
    }),
    entry("@deepseek-ai/dsh-agent-preset", {
      id: "p2",
      disabled: true,
      config: { plugins: [{ id: "x", name: FS, config: { customSkillDirs: [dir("hidden")] } }] },
    }),
  ];
  const scan = scanSkillRoots(ctxOf(roots), { env: {}, resolvePresetSkillsDir: noPreset });
  assert.deepEqual(scan.customSkillDirs, [dir("inner")]);
  assert.equal(scan.matched, 2, "停用条目里的声明根本不展开");
  assert.equal(scan.contributions.find((c) => c.id === "inner")!.parent, "p1/grp");
});

test("嵌套容器的各种形状都能走到：数组、Map、entries() 函数、可迭代对象", () => {
  const leaf = (n: string) => entry(FS, { id: n, config: { customSkillDirs: [dir(n)] } });
  const roots = [
    entry("g1", { subgroup: [leaf("arr")] }),
    entry("g2", { subtree: { entries: () => [leaf("fn")][Symbol.iterator]() } }),
    entry("g3", { subgroup: { children: [leaf("children")] } }),
    entry("g4", { subtree: new Set([leaf("set")]) }),
    entry("g5", { subgroup: new Map([["k", leaf("map")]]) }),
  ];
  const scan = scanSkillRoots(ctxOf(roots), { env: {}, resolvePresetSkillsDir: noPreset });
  assert.deepEqual(scan.customSkillDirs.sort(), ["arr", "fn", "children", "set", "map"].map((n) => dir(n)).sort());
  assert.equal(readComposition(ctxOf(roots)).entries.length, 10);
});

test("bundledSkillDir：来源配置优先，其次环境变量 DSH_BUNDLED_SKILL_DIR", () => {
  const fromConfig = scanSkillRoots(ctxOf([entry(FS, { config: { bundledSkillDir: dir("b1") } })]), {
    env: { DSH_BUNDLED_SKILL_DIR: dir("env") },
    resolvePresetSkillsDir: noPreset,
  });
  assert.equal(fromConfig.bundledSkillDir, dir("b1"));
  assert.equal(fromConfig.bundledSource, "config");
  const fromEnv = scanSkillRoots(ctxOf([]), {
    env: { DSH_BUNDLED_SKILL_DIR: dir("env") },
    resolvePresetSkillsDir: noPreset,
  });
  assert.equal(fromEnv.bundledSkillDir, dir("env"));
  assert.equal(fromEnv.bundledSource, "env");
});

test("组合树快照：限制深度与每层数量，记下截断数", () => {
  const many = Array.from({ length: 5 }, (_, i) => entry("leaf-" + i));
  const tree = compositionTree(ctxOf([entry("root", { subgroup: many })]), 2, 3)!;
  assert.equal(tree.children[0]!.children.length, 3);
  assert.equal(tree.children[0]!.truncated, 2);
  assert.equal(compositionTree(undefined), undefined);
});

test("HubContext：devOverrides 改 homeDir；DSH_HOME 改 dshHome；技能目录是活值", () => {
  assert.equal(resolveDshHome(dir("home"), { DSH_HOME: dir("custom-dsh") }), dir("custom-dsh"));
  assert.equal(resolveDshHome(dir("home"), {}), path.join(dir("home"), ".dsh"));
  const roots: unknown[] = [];
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const ctx = resolveHubContext(
    ctxOf(roots),
    { devOverrides: { enabled: true, homeDir: dir("home") } },
    "pkg",
    silent,
    {
      env: {},
      resolvePresetSkillsDir: noPreset,
    },
  );
  assert.equal(ctx.homeDir, dir("home"));
  assert.equal(ctx.profileName, "unknown");
  assert.deepEqual(ctx.customSkillDirs, []);
  // 预设按会话挂载：之后才出现在组合树里，也要能读到
  roots.push(entry(FS, { config: { customSkillDirs: [dir("late")] } }));
  assert.deepEqual(ctx.customSkillDirs, [dir("late")]);
});
