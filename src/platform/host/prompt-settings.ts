/**
 * 读 DSH 的提示词设置（agent-instructions 条目），与 DSH 的 dsh-agent-instructions 用同一份。
 *
 * 读什么（都不写死）：
 *   - instructionFileCandidates（默认 ["AGENTS.md","CLAUDE.md"]）
 *   - localInstructionFileCandidates（默认 ["AGENTS.local.md","CLAUDE.local.md"]）
 *   - projectRootMarkers（默认 [".git"]）
 *   - maxBytes（默认 65536）、maxSourceBytes（默认 1048576）
 *
 * 从哪读（**关键**，使用者 Desktop 的组合配置实测）：
 *   根层可能有一条 `- id: agent-instructions … disabled: true`，但 standard / ptc / cordis 三个
 *   agent 预设（name 为 @deepseek-ai/dsh-agent-preset 的条目，它们 config.plugins 列表里）各自又启用了
 *   agent-instructions；minimal 预设里没有它。因此：
 *     1. 只要**任一 agent 预设**里有启用的 agent-instructions 条目，就不是 loaderDisabled；
 *     2. 配置从那个条目读；多个预设不一致时取 **standard 预设**的那份，并记一条说明；
 *     3. 所有预设都没有启用的，才 loaderDisabled = true（此时用默认值）；
 *     4. 根层那条 disabled 不作数（既不算 loaderDisabled，也不作为配置来源）。
 *   预设里没有、但根层有启用的条目时，用根层那条（本机没这个形状，留着以防配置变化）。
 *
 * 拿不到 loader 时全部回退默认值，绝不抛。
 */

import { readComposition, type CompositionEntry } from "./composition.ts";
import {
  defaultPromptSettings,
  type PromptSettings,
  type PromptSettingsContribution,
} from "../../prompts/files/settings.ts";

const INSTRUCTIONS_SUFFIX = "dsh-agent-instructions";
const PRESET_SUFFIX = "dsh-agent-preset";

/** 配置里的五项（缺的留 undefined，由调用方补默认值）。 */
interface PromptConfigShape {
  instructionFileCandidates?: string[];
  localInstructionFileCandidates?: string[];
  projectRootMarkers?: string[];
  maxBytes?: number;
  maxSourceBytes?: number;
}

/** 一个被采纳的来源。 */
interface Source {
  kind: "preset-spec" | "entry";
  id: string;
  /** 承载它的预设条目 id（根层来源为空串） */
  presetId: string;
  parent?: string;
  shape: PromptConfigShape;
}

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

/** 名字命中（预设里可能写短名，也可能写全名）。 */
function nameMatches(value: unknown, suffix: string): boolean {
  return typeof value === "string" && value.endsWith(suffix);
}

/** 从配置里取一个非空字符串数组；不是数组或全不合法时返回 undefined。 */
function stringArrayOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim());
  return out.length > 0 ? out : undefined;
}

/** 从配置里取一个正整数；不是就返回 undefined。 */
function positiveIntOf(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

function shapeOf(config: unknown): PromptConfigShape {
  if (!isObject(config)) return {};
  const source = config as Record<string, unknown>;
  const out: PromptConfigShape = {};
  const instruction = stringArrayOf(source.instructionFileCandidates);
  if (instruction !== undefined) out.instructionFileCandidates = instruction;
  const local = stringArrayOf(source.localInstructionFileCandidates);
  if (local !== undefined) out.localInstructionFileCandidates = local;
  const markers = stringArrayOf(source.projectRootMarkers);
  if (markers !== undefined) out.projectRootMarkers = markers;
  const maxBytes = positiveIntOf(source.maxBytes);
  if (maxBytes !== undefined) out.maxBytes = maxBytes;
  const maxSourceBytes = positiveIntOf(source.maxSourceBytes);
  if (maxSourceBytes !== undefined) out.maxSourceBytes = maxSourceBytes;
  return out;
}

/** 两份配置是否一致（只看我们读的五项）。 */
function sameShape(a: PromptConfigShape, b: PromptConfigShape): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 在预设条目的插件声明里（含嵌套分组）找 agent-instructions。 */
function specsInPreset(preset: CompositionEntry): {
  enabled: Source[];
  disabled: PromptSettingsContribution[];
} {
  const enabled: Source[] = [];
  const disabled: PromptSettingsContribution[] = [];
  const walk = (specs: PluginSpec[], parent: string, depth: number): void => {
    if (depth > 3) return;
    for (const spec of specs) {
      const name = typeof spec.name === "string" ? spec.name : "";
      const id = typeof spec.id === "string" ? spec.id : name;
      if (nameMatches(name, INSTRUCTIONS_SUFFIX)) {
        if (spec.disabled === true) {
          disabled.push({ kind: "preset-spec", id, parent, disabled: true, used: false, note: "预设里这一条已停用" });
        } else {
          enabled.push({ kind: "preset-spec", id, presetId: preset.id, parent, shape: shapeOf(spec.config) });
        }
      }
      walk(pluginSpecsOf(spec.config), parent + "/" + id, depth + 1);
      if (spec.plugins !== undefined) walk(pluginSpecsOf(spec.plugins), parent + "/" + id, depth + 1);
    }
  };
  walk(pluginSpecsOf(preset.config), preset.id, 0);
  return { enabled, disabled };
}

/** 预设条目的优先序：standard 预设优先（多个预设不一致时以它为准）。 */
function presetRank(presetId: string): number {
  return /standard/i.test(presetId) ? 0 : 1;
}

/** 读提示词设置（永不抛）。 */
export function readPromptSettings(ctx: unknown): PromptSettings {
  const settings = defaultPromptSettings();
  const composition = readComposition(ctx);
  const notes: string[] = [];

  const presetSources: Source[] = [];
  for (const preset of composition.entries) {
    if (!nameMatches(preset.name, PRESET_SUFFIX)) continue;
    if (preset.disabled) {
      settings.contributions.push({
        kind: "entry",
        id: preset.id,
        disabled: true,
        used: false,
        note: "预设本身已停用，不展开它的插件声明",
      });
      continue;
    }
    const found = specsInPreset(preset);
    settings.contributions.push(...found.disabled);
    presetSources.push(...found.enabled);
  }

  const ranked = [...presetSources].sort(
    (a, b) => presetRank(a.presetId) - presetRank(b.presetId) || a.presetId.localeCompare(b.presetId),
  );

  let chosen: Source | undefined;
  if (ranked.length > 0) {
    chosen = ranked[0];
    settings.loaderDisabled = false;
    const inconsistent = ranked.filter((source) => !sameShape(source.shape, chosen!.shape));
    if (inconsistent.length > 0) {
      notes.push(
        "有多个 agent 预设启用了不同的提示词配置，本插件按 standard 预设那一份读（涉及：" +
          ranked.map((source) => source.presetId).join("、") +
          "）。",
      );
    }
  } else {
    // 预设里都没有启用：退一步看根层启用的条目（本机没这个形状，留着以防配置变化）
    const rootEntry = composition.entries.find(
      (entry) => nameMatches(entry.name, INSTRUCTIONS_SUFFIX) && !entry.disabled,
    );
    if (rootEntry !== undefined) {
      const resolved = rootEntry.resolvedConfig !== undefined ? rootEntry.resolvedConfig : rootEntry.config;
      chosen = { kind: "entry", id: rootEntry.id, presetId: "", shape: shapeOf(resolved) };
      settings.loaderDisabled = false;
      notes.push("agent 预设里没有启用提示词，本插件按根层的 agent-instructions 条目读配置。");
    } else {
      settings.loaderDisabled = true;
      notes.push(
        "当前 profile 的 agent 预设里都没有启用提示词（例如 minimal 预设不加载提示词），DSH 不会加载任何 AGENTS.md / CLAUDE.md。",
      );
    }
  }

  if (chosen !== undefined) {
    settings.contributions.push({
      kind: chosen.kind,
      id: chosen.id,
      parent: chosen.parent,
      disabled: false,
      used: true,
    });
    const shape = chosen.shape;
    if (shape.instructionFileCandidates !== undefined) {
      settings.instructionFileCandidates = shape.instructionFileCandidates;
    }
    if (shape.localInstructionFileCandidates !== undefined) {
      settings.localInstructionFileCandidates = shape.localInstructionFileCandidates;
    }
    if (shape.projectRootMarkers !== undefined) settings.projectRootMarkers = shape.projectRootMarkers;
    if (shape.maxBytes !== undefined) {
      settings.maxBytes = shape.maxBytes;
      settings.source = "dsh-config";
    }
    if (shape.maxSourceBytes !== undefined) settings.maxSourceBytes = shape.maxSourceBytes;
  }
  // 无论有没有启用的来源，候选名都要拼好（界面要能列出「DSH 会加载哪些」，只是加载可能被关掉）
  settings.fileNames = [...settings.instructionFileCandidates, ...settings.localInstructionFileCandidates];
  settings.notes = notes;
  return settings;
}
