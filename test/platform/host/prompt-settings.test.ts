/**
 * prompt-settings.ts：从 DSH 的组合配置里读提示词设置。
 *
 * 夹具照使用者 Desktop 的真实形状搭：**根层一条 agent-instructions 是 disabled**，
 * standard / ptc / cordis 三个 agent 预设的 plugins 列表里各自又启用了它（config 只有 maxBytes），
 * minimal 预设里没有它。这条形状决定了 loaderDisabled 的判断 —— 只看预设，不看根层。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readPromptSettings } from "../../../src/platform/host/prompt-settings.ts";
import { defaultPromptSettings } from "../../../src/prompts/files/settings.ts";

const FS = "@deepseek-ai/dsh-agent-instructions";
const PRESET = "@deepseek-ai/dsh-agent-preset";

interface EntryInit {
  id?: string;
  disabled?: boolean;
  config?: unknown;
  fiber?: unknown;
  subgroup?: unknown;
}
function entry(name: string, init: EntryInit = {}): Record<string, unknown> {
  return {
    options: { id: init.id ?? name, name, ...(init.disabled ? { disabled: true } : {}), config: init.config },
    ...(init.fiber === undefined ? {} : { fiber: { config: init.fiber } }),
    ...(init.subgroup === undefined ? {} : { subgroup: init.subgroup }),
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
/** 一个带 agent-instructions 声明的预设（config 省略 = 声明里不写 config）。 */
const preset = (id: string, config?: unknown, disabled = false): Record<string, unknown> =>
  entry(PRESET, {
    id,
    disabled,
    config: { plugins: [{ id: "agent-instructions", name: FS, ...(config === undefined ? {} : { config }) }] },
  });
/** 一个**完全没有** agent-instructions 声明的预设（minimal 就是这个形状）。 */
const presetWithout = (id: string): Record<string, unknown> =>
  entry(PRESET, { id, config: { plugins: [{ id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem" }] } });

test("设置：拿不到 loader → 全部回退 DSH 的默认值，loaderDisabled = true", () => {
  for (const ctx of [undefined, {}, ctxOf([])]) {
    const settings = readPromptSettings(ctx);
    const defaults = defaultPromptSettings();
    assert.deepEqual(settings.fileNames, defaults.fileNames);
    assert.deepEqual(settings.projectRootMarkers, [".git"]);
    assert.equal(settings.maxBytes, 65536);
    assert.equal(settings.maxSourceBytes, 1048576);
    assert.equal(settings.source, "default");
    assert.equal(settings.loaderDisabled, true);
  }
});

test("设置：Desktop 的真实形状 —— 根层 disabled 不作数，standard 预设里启用的那份被采用", () => {
  const roots = [
    entry(FS, { id: "agent-instructions", disabled: true, config: { maxBytes: 4096 } }),
    preset("preset-standard", { maxBytes: 65536 }),
    preset("preset-ptc", { maxBytes: 65536 }),
    preset("preset-cordis", { maxBytes: 65536 }),
    presetWithout("preset-minimal"),
  ];
  const settings = readPromptSettings(ctxOf(roots));
  assert.equal(settings.loaderDisabled, false, "任一预设启用了就不是 loaderDisabled");
  assert.equal(settings.maxBytes, 65536, "读的是预设里那份，不是根层 disabled 那份的 4096");
  assert.equal(settings.source, "dsh-config");
  assert.equal(settings.notes.length, 0, "三个预设配置一致 → 没有不一致说明");
  const used = settings.contributions.filter((c) => c.used);
  assert.equal(used.length, 1);
  assert.equal(used[0]!.kind, "preset-spec");
  assert.equal(used[0]!.parent, "preset-standard");
});

test("设置：所有预设都没有启用的 → loaderDisabled = true（minimal 不加载提示词）", () => {
  const roots = [
    entry(FS, { id: "agent-instructions", disabled: true }),
    presetWithout("preset-minimal"),
    preset("preset-empty", { maxBytes: 1 }, true),
  ];
  const settings = readPromptSettings(ctxOf(roots));
  assert.equal(settings.loaderDisabled, true);
  assert.match(settings.notes.join("\n"), /minimal/);
  assert.equal(settings.maxBytes, 65536, "没有来源时用默认值");
  assert.equal(settings.source, "default");
});

test("设置：多个预设不一致时取 standard 那份并记一条说明", () => {
  const roots = [
    preset("preset-ptc", { maxBytes: 100 }),
    preset("preset-standard", { maxBytes: 65536 }),
    preset("preset-cordis", { maxBytes: 100 }),
  ];
  const settings = readPromptSettings(ctxOf(roots));
  assert.equal(settings.maxBytes, 65536, "standard 优先");
  assert.equal(settings.notes.length, 1);
  assert.match(settings.notes[0]!, /standard/);
});

test("设置：五项都从配置读（候选名、标记、两个上限），缺的补默认值", () => {
  const roots = [
    preset("preset-standard", {
      instructionFileCandidates: ["A.md", "B.md"],
      localInstructionFileCandidates: ["A.local.md"],
      projectRootMarkers: [".git", ".hg"],
      maxBytes: 1234,
      maxSourceBytes: 5678,
    }),
  ];
  const settings = readPromptSettings(ctxOf(roots));
  assert.deepEqual(settings.fileNames, ["A.md", "B.md", "A.local.md"]);
  assert.deepEqual(settings.instructionFileCandidates, ["A.md", "B.md"]);
  assert.deepEqual(settings.localInstructionFileCandidates, ["A.local.md"]);
  assert.deepEqual(settings.projectRootMarkers, [".git", ".hg"]);
  assert.equal(settings.maxBytes, 1234);
  assert.equal(settings.maxSourceBytes, 5678);
  assert.equal(settings.source, "dsh-config");

  // 只给一部分：其余保持默认
  const partial = readPromptSettings(ctxOf([preset("preset-standard", { maxBytes: 99 })]));
  assert.deepEqual(partial.fileNames, ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"]);
  assert.deepEqual(partial.projectRootMarkers, [".git"]);
  assert.equal(partial.maxBytes, 99);
  assert.equal(partial.maxSourceBytes, 1048576);
});

test("设置：非法值被忽略（空数组、非字符串、非正整数）", () => {
  const roots = [
    preset("preset-standard", {
      instructionFileCandidates: [],
      localInstructionFileCandidates: [1, "", "  "],
      projectRootMarkers: "not-an-array",
      maxBytes: 0,
      maxSourceBytes: -5,
    }),
  ];
  const settings = readPromptSettings(ctxOf(roots));
  assert.deepEqual(settings.fileNames, ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"]);
  assert.deepEqual(settings.projectRootMarkers, [".git"]);
  assert.equal(settings.maxBytes, 65536);
  assert.equal(settings.maxSourceBytes, 1048576);
  assert.equal(settings.source, "default");
});

test("设置：预设条目本身 disabled 时不展开它的声明", () => {
  const roots = [
    entry(PRESET, {
      id: "preset-standard",
      disabled: true,
      config: { plugins: [{ id: "x", name: FS, config: { maxBytes: 7 } }] },
    }),
    preset("preset-ptc", { maxBytes: 65536 }),
  ];
  const settings = readPromptSettings(ctxOf(roots));
  assert.equal(settings.maxBytes, 65536);
  const skipped = settings.contributions.find((c) => c.kind === "entry" && c.disabled);
  assert.ok(skipped !== undefined);
  assert.match(skipped!.note ?? "", /预设本身已停用/);
});

test("设置：预设里没有启用、根层有启用的条目时用根层那条", () => {
  const roots = [entry(FS, { id: "agent-instructions", config: { maxBytes: 2048 } })];
  const settings = readPromptSettings(ctxOf(roots));
  assert.equal(settings.loaderDisabled, false);
  assert.equal(settings.maxBytes, 2048);
  assert.equal(settings.source, "dsh-config");
  assert.match(settings.notes.join("\n"), /根层/);
});

test("设置：预设的插件声明嵌在分组里也能找到（含嵌套 plugins）", () => {
  const roots = [
    entry(PRESET, {
      id: "preset-standard",
      config: {
        plugins: [
          {
            id: "grp",
            name: "cordis:group",
            config: [{ id: "inner", name: FS, config: { maxBytes: 4096 } }],
          },
        ],
      },
    }),
  ];
  const settings = readPromptSettings(ctxOf(roots));
  assert.equal(settings.maxBytes, 4096);
  assert.equal(settings.loaderDisabled, false);
  assert.equal(settings.contributions.find((c) => c.used)?.id, "inner");
});

test("设置：预设里的 agent-instructions 自己 disabled → 不算启用", () => {
  const roots = [
    entry(PRESET, {
      id: "preset-standard",
      config: { plugins: [{ id: "agent-instructions", name: FS, disabled: true, config: { maxBytes: 1 } }] },
    }),
  ];
  const settings = readPromptSettings(ctxOf(roots));
  assert.equal(settings.loaderDisabled, true);
  const disabled = settings.contributions.find((c) => c.kind === "preset-spec" && c.disabled);
  assert.ok(disabled !== undefined);
  assert.match(disabled!.note ?? "", /预设里这一条已停用/);
});
