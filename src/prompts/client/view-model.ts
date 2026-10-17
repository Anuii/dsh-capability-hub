/**
 * 提示词页的**列表与展示**逻辑：分组、一行怎么显示（大小与各种状态）、底部合计、新建位置可用性。
 * 纯函数，不碰 DOM / React / 网络（见 test/prompts/client/view-model.test.ts）。文案走 strings.ts 的 t()。
 *
 * 数据形状以 src/prompts/contract/prompts.ts 为准（本文件不改它的形状）。
 */

import { t } from "./strings.ts";
import type { PromptCreateLocation, PromptFile, PromptLayer, PromptsListResult } from "../contract/prompts.ts";

/* ---------------- 格式化 ---------------- */

/** 字节数 → 「12 B / 3.4 KB / 1.2 MB」；非有限数或负数按 0 B。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const rounded = index === 0 ? String(Math.round(value)) : value.toFixed(1);
  return rounded + " " + units[index];
}

/**
 * 预算口径的字节数：整 KB 不写小数（65536 → 「64 KB」，1280 → 「1.3 KB」）。
 * 底部合计与行上的「超出预算」都用它，免得出现「64.0 KB」这种不像预算的写法。
 */
export function formatBudgetBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 KB";
  const kb = size / 1024;
  if (kb >= 1024) return formatBytes(size);
  return (Number.isInteger(kb) ? String(kb) : kb.toFixed(1)) + " KB";
}

/** ISO 时间 → 本地「YYYY-MM-DD HH:mm」（解析不了就原样返回）。 */
export function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (input: number): string => String(input).padStart(2, "0");
  return (
    date.getFullYear() +
    "-" +
    pad(date.getMonth() + 1) +
    "-" +
    pad(date.getDate()) +
    " " +
    pad(date.getHours()) +
    ":" +
    pad(date.getMinutes())
  );
}

/* ---------------- 分组 ---------------- */

export type PromptGroupId = "global" | "workspace";

export interface PromptGroupView {
  id: PromptGroupId;
  title: string;
  /** 标题行右侧的「N 个」 */
  count: string;
  /** 组内的一行说明（没有工作区时用） */
  note?: string;
  /** 组内的文件（按加载顺序） */
  rows: PromptRowView[];
}

export interface PromptRowView {
  file: PromptFile;
  title: string;
  subtitle: string;
  subtitleTitle: string;
  /** 行尾开关（停用 = 关） */
  toggle: { checked: boolean; disabled: boolean; label: string };
}

/**
 * 一层的显示名：工作区标「当前工作区」、项目根标「项目根」，其余用契约给的相对路径。
 * 项目根同时也是工作区时（工作区就在仓库根）优先说「当前工作区」——那是用户眼里的位置。
 */
export function layerLabel(layer: PromptLayer): string {
  if (layer.isWorkspace) return t("prompts.layer.workspace");
  if (layer.isProjectRoot) return t("prompts.layer.projectRoot");
  return layer.displayDir;
}

/**
 * 这个文件在哪一层（启停是原地改名，确认框里那句 git 提示按**文件所在层**给：
 * 全局层恒不在仓库里，只有项目层可能命中）。找不到层时返回 undefined。
 */
export function layerOfFile(list: PromptsListResult | undefined, id: string): PromptLayer | undefined {
  if (list === undefined) return undefined;
  return list.layers.find((layer) => layer.files.some((file) => file.id === id));
}

/** 一行副标题的各个片段（顺序即显示顺序）。 */
function subtitleParts(file: PromptFile, layer: PromptLayer | undefined): string[] {
  const parts: string[] = [];
  if (layer !== undefined && layer.scope === "project") parts.push(layerLabel(layer));
  parts.push(formatBytes(file.size));
  if (file.disabled) parts.push(t("prompts.row.disabled"));
  if (file.duplicateOf !== undefined) parts.push(t("prompts.row.duplicate", { name: file.duplicateOf }));
  if (file.tooLarge === true) parts.push(t("prompts.row.tooLarge"));
  if (file.budget === "omitted") parts.push(t("prompts.row.budgetOmitted", { size: formatBudgetBytes(file.size) }));
  else if (file.budget === "truncated")
    parts.push(t("prompts.row.budgetTruncated", { size: formatBudgetBytes(file.size) }));
  return parts;
}

/** 一行的显示（标题 = 文件名，副标题 = 层 · 大小 · 各种状态）。 */
export function promptRowView(file: PromptFile, layer?: PromptLayer): PromptRowView {
  const parts = subtitleParts(file, layer);
  return {
    file,
    title: file.name,
    subtitle: parts.join(" · "),
    subtitleTitle: [file.name, ...parts, file.path].join("\n"),
    toggle: {
      checked: !file.disabled,
      disabled: false,
      label: t("prompts.row.toggleLabel", { name: file.name }),
    },
  };
}

/** 列表 → 两组：「全局」与「当前工作区」（没有工作区时后者只有一句说明）。 */
export function groupPrompts(list: PromptsListResult): PromptGroupView[] {
  const layers = Array.isArray(list.layers) ? list.layers : [];
  const globalLayers = layers.filter((layer) => layer.scope === "global");
  const projectLayers = layers.filter((layer) => layer.scope === "project");
  const rowsOf = (source: readonly PromptLayer[]): PromptRowView[] =>
    source.flatMap((layer) => layer.files.map((file) => promptRowView(file, layer)));
  const globalRows = rowsOf(globalLayers);
  const workspaceRows = rowsOf(projectLayers);
  return [
    {
      id: "global",
      title: t("prompts.group.global"),
      count: t("prompts.group.count", { count: globalRows.length }),
      rows: globalRows,
    },
    {
      id: "workspace",
      title: t("prompts.group.workspace"),
      count: t("prompts.group.count", { count: workspaceRows.length }),
      ...(projectLayers.length === 0 ? { note: t("prompts.group.noWorkspace") } : {}),
      rows: workspaceRows,
    },
  ];
}

/* ---------------- 底部合计 ---------------- */

/** 底部那一行合计：「约 12.3 KB / 64 KB」；加载被关掉时改说一句说明。 */
export function budgetText(list: PromptsListResult): string {
  if (list.loaderDisabled === true) return t("prompts.foot.loaderDisabled");
  return t("prompts.foot.budget", {
    used: formatBudgetBytes(list.budget.usedBytes),
    max: formatBudgetBytes(list.budget.maxBytes),
  });
}

/** 合计的悬停提示：预算从哪来。 */
export function budgetTitle(list: PromptsListResult): string {
  return list.budget.source === "dsh-config" ? t("prompts.foot.sourceConfig") : t("prompts.foot.sourceDefault");
}

/* ---------------- 新建位置 ---------------- */

export interface CreateOption {
  location: PromptCreateLocation;
  label: string;
  /** 位置的完整路径（悬停与副标题用） */
  hint: string;
  disabled: boolean;
  /** 置灰的原因（禁用时才有） */
  reason?: string;
  testId: string;
}

const CREATE_LABELS: Record<PromptCreateLocation, string> = {
  global: "全局",
  "project-root": "项目根",
  workspace: "当前工作区",
};

/** 新建位置的界面名（全局 / 项目根 / 当前工作区）。 */
function createLocationLabel(location: PromptCreateLocation): string {
  return CREATE_LABELS[location];
}

/**
 * 新建可选的位置：三个位置都列出来，不可用的置灰并说明原因。
 * 可用性由宿主给的 canCreate 推出（契约：目录存在，且 AGENTS.md 与 AGENTS.md.disabled 都不存在）。
 */
export function createOptions(list: PromptsListResult): CreateOption[] {
  const layers = list.layers ?? [];
  const globalLayer = layers.find((layer) => layer.scope === "global");
  const rootLayer = layers.find((layer) => layer.scope === "project" && layer.isProjectRoot);
  const workspaceLayer = layers.find((layer) => layer.scope === "project" && layer.isWorkspace);
  const hasWorkspace = layers.some((layer) => layer.scope === "project");
  const option = (location: PromptCreateLocation, layer: PromptLayer | undefined, hint: string): CreateOption => {
    const exists = layer !== undefined;
    const allowed = exists && layer.canCreate;
    let reason: string | undefined;
    if (!allowed) {
      if (exists) reason = t("prompts.createDialog.unavailableExists");
      else if (location === "global") reason = t("prompts.createDialog.unavailableMissing");
      else
        reason = hasWorkspace
          ? t("prompts.createDialog.unavailableMissing")
          : t("prompts.createDialog.unavailableNoWorkspace");
    }
    return {
      location,
      label: createLocationLabel(location),
      hint,
      disabled: !allowed,
      ...(reason === undefined ? {} : { reason }),
      testId: "prompts-create-location-" + location,
    };
  };
  return [
    option("global", globalLayer, globalLayer?.dir ?? ""),
    option("project-root", rootLayer, hasWorkspace ? (rootLayer?.dir ?? list.projectRoot ?? "") : ""),
    option("workspace", workspaceLayer, hasWorkspace ? (workspaceLayer?.dir ?? "") : ""),
  ];
}

/** 默认选中的位置：第一个可用的。 */
export function defaultCreateLocation(options: readonly CreateOption[]): PromptCreateLocation | undefined {
  return options.find((item) => !item.disabled)?.location;
}
