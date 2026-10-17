/**
 * 发现：DSH 会加载哪些提示词文件。
 *
 * 层（顺序即加载顺序，越往后越具体）：
 *   - 全局：<dshHome> 一层。**只有 AGENTS.md 会被 DSH 加载**（DSH 写死，不读配置）；
 *     为了「停用/启用」这条路一致，<dshHome>/AGENTS.md.disabled 也照列（列为停用态）。
 *   - 项目：自 workspace 往上找第一个命中 projectRootMarkers（默认 .git，文件或目录都算）的目录为项目根；
 *     一个都没命中就是 workspace 本身。然后从项目根到 workspace 的每一层（含两端）。
 *
 * 项目层每层按 instructionFileCandidates 接 localInstructionFileCandidates 的顺序找「原名」或「原名.disabled」。
 * 两个都在时：只列原名那个为启用文件，另把冲突写进 warnings（绝不擅自改用户的文件）。
 * 只认普通文件；符号链接照 DSH 的做法跟随读取。
 *
 * 同层重复：启用的、未过大的文件里，去首尾空白后内容相同的，后出现的标 duplicateOf。
 * 预算：只算会加载的文件（启用、非重复、非过大），超出时从最前开始 omitted，只剩最后一个仍超出就 truncated。
 */

import path from "node:path";
import { CREATE_FILE_NAME, DISABLED_SUFFIX, disabledNameOf, GLOBAL_FILE_NAME } from "../rules/names.ts";
import { duplicatesOf } from "../rules/duplicate.ts";
import { estimateBudget, type BudgetCandidate, type BudgetMark } from "../rules/budget.ts";
import { isDirectory, isRegularFile, readRaw, sha256Hex, statFollow, streamedVersion } from "./fsx.ts";
import type { HubContext } from "../../platform/contract/host.ts";
import type { PromptFile, PromptLayer } from "../contract/prompts.ts";
import type { PromptSettings } from "./settings.ts";

export interface PromptDiscovery {
  layers: PromptLayer[];
  projectRoot?: string;
  /** 项目根由 projectRootMarkers 命中（默认 .git） */
  inGit: boolean;
  /** 本次发现用的工作区（规范化后的绝对路径；工作区不存在时 undefined） */
  workspace?: string;
  warnings: string[];
}

export interface DiscoveryContext {
  discovery: PromptDiscovery;
  /** id → 文件（安全校验用：所有接受 id 的路由都要求 id 在这里） */
  fileById: Map<string, PromptFile>;
  /** 预算估算：会加载的文件合计字节（含每个文件的头部近似） */
  usedBytes: number;
}

/** Windows 下路径比较不区分大小写。 */
export function pathKey(value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 自 workspace 往上找第一个含任一 projectRootMarker 的目录；都没有就返回 workspace 本身。 */
export async function findProjectRoot(
  workspace: string,
  markers: readonly string[],
): Promise<{ root: string; inGit: boolean }> {
  const start = path.resolve(workspace);
  const list = markers.length > 0 ? markers : [".git"];
  let current = start;
  for (;;) {
    for (const marker of list) {
      if ((await statFollow(path.join(current, marker))) !== undefined) return { root: current, inGit: true };
    }
    const parent = path.dirname(current);
    if (parent === current) return { root: start, inGit: false };
    current = parent;
  }
}

/** 从项目根到 workspace 的每一层（含两端）；workspace 不在项目根下时只返回 workspace 一层。 */
export function layerDirs(projectRoot: string, workspace: string): string[] {
  const rel = path.relative(projectRoot, workspace);
  if (rel === "") return [projectRoot];
  if (rel.startsWith("..") || path.isAbsolute(rel)) return [workspace];
  const out = [projectRoot];
  let current = projectRoot;
  for (const segment of rel.split(path.sep)) {
    if (segment === "") continue;
    current = path.join(current, segment);
    out.push(current);
  }
  return out;
}

/** 层内某一层的某个文件名的候选。 */
interface Candidate {
  name: string;
  /** 原名绝对路径（= 契约里的 id，停用时也不变） */
  id: string;
  /** 当前磁盘上的绝对路径（停用时是 <原名>.disabled） */
  path: string;
  disabled: boolean;
}

/**
 * 在某一层里按给定顺序找候选。
 * @param names 要查的文件名（全局层固定只有 AGENTS.md）
 */
async function candidatesIn(
  dir: string,
  names: readonly string[],
  warnings: string[],
  layerLabel: string,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const name of names) {
    const enabled = path.join(dir, name);
    const disabledName = disabledNameOf(name);
    const disabled = path.join(dir, disabledName);
    const hasEnabled = await isRegularFile(enabled);
    const hasDisabled = await isRegularFile(disabled);
    if (hasEnabled && hasDisabled) {
      warnings.push(
        layerLabel +
          "：「" +
          name +
          "」与「" +
          disabledName +
          "」同时存在，只把「" +
          name +
          "」当作启用文件；本插件不会改动其中一个，请自行处理。",
      );
    }
    if (hasEnabled) out.push({ name, id: enabled, path: enabled, disabled: false });
    else if (hasDisabled) out.push({ name, id: enabled, path: disabled, disabled: true });
  }
  return out;
}

/** 一个候选 + 它的显示路径 → PromptFile（读文件、算大小/版本/摘要）。 */
async function toPromptFile(
  candidate: Candidate,
  displayPath: string,
  maxSourceBytes: number,
): Promise<{ file: PromptFile; digest?: string }> {
  const stat = await statFollow(candidate.path);
  const size = stat === undefined ? 0 : Number(stat.size);
  const mtimeMs = stat === undefined ? 0 : Number(stat.mtimeMs);
  const tooLarge = size > maxSourceBytes;
  let version = "";
  let digest: string | undefined;
  if (tooLarge) {
    // 超过上限：不把全文读进内存，流式算版本；DSH 也不加载它，不参与重复判定
    try {
      version = await streamedVersion(candidate.path);
    } catch {
      version = "";
    }
  } else {
    const raw = await readRaw(candidate.path);
    if (raw !== undefined) {
      version = sha256Hex(raw.buffer).slice(0, 16);
      // DSH 用「去掉首尾空白后的内容」比较同层重复；这里只留摘要，不留正文
      digest = sha256Hex(raw.text.trim());
    }
  }
  const file: PromptFile = {
    id: candidate.id,
    name: candidate.name,
    path: candidate.path,
    displayPath,
    disabled: candidate.disabled,
    size,
    mtimeMs,
    version,
  };
  if (tooLarge) file.tooLarge = true;
  return digest === undefined ? { file } : { file, digest };
}

/** 同层重复：启用的、未过大的文件里，去首尾空白后内容相同的，后出现的标 duplicateOf。 */
function applyDuplicates(files: PromptFile[], digests: (string | undefined)[]): void {
  const participants: { file: PromptFile; digest: string }[] = [];
  files.forEach((file, index) => {
    const digest = digests[index];
    if (file.disabled || file.tooLarge === true || digest === undefined) return;
    participants.push({ file, digest });
  });
  const marks = duplicatesOf(participants.map((item) => ({ name: item.file.name, digest: item.digest })));
  participants.forEach((item, index) => {
    const earlier = marks[index];
    if (earlier !== undefined) item.file.duplicateOf = earlier;
  });
}

/**
 * 某一层能否新建 AGENTS.md：
 *   目录存在；AGENTS.md 在当前候选文件名里（配置改过就不让建）；AGENTS.md 与 AGENTS.md.disabled 都不存在。
 */
async function canCreateIn(dir: string, fileNames: readonly string[]): Promise<boolean> {
  if (!fileNames.includes(CREATE_FILE_NAME)) return false;
  if (!(await isDirectory(dir))) return false;
  if (await isRegularFile(path.join(dir, CREATE_FILE_NAME))) return false;
  if (await isRegularFile(path.join(dir, CREATE_FILE_NAME + DISABLED_SUFFIX))) return false;
  return true;
}

export interface DiscoverOptions {
  workspace?: string;
  settings: PromptSettings;
}

/** 发现 DSH 会加载的提示词文件（永不抛：读不了的层只是少几个文件 + 一条 warning）。 */
export async function discoverPrompts(ctx: HubContext, options: DiscoverOptions): Promise<DiscoveryContext> {
  const settings = options.settings;
  const warnings: string[] = [];
  const layers: PromptLayer[] = [];
  const budgetCandidates: BudgetCandidate[] = [];
  const budgetTargets: PromptFile[] = [];

  // ---- 全局层：DSH 写死只有 AGENTS.md ----
  const globalDir = ctx.dshHome;
  const globalCandidates = await candidatesIn(globalDir, [GLOBAL_FILE_NAME], warnings, "全局提示词目录");
  const globalFiles: PromptFile[] = [];
  const globalDigests: (string | undefined)[] = [];
  for (const candidate of globalCandidates) {
    const read = await toPromptFile(candidate, "~/.dsh/" + path.basename(candidate.path), settings.maxSourceBytes);
    globalFiles.push(read.file);
    globalDigests.push(read.digest);
  }
  applyDuplicates(globalFiles, globalDigests);
  layers.push({
    scope: "global",
    dir: globalDir,
    displayDir: "~/.dsh",
    isProjectRoot: false,
    isWorkspace: false,
    files: globalFiles,
    canCreate: await canCreateIn(globalDir, settings.fileNames),
    // 全局提示词在 DSH 主目录里，不属于任何项目：改名不会被任何仓库的 git 记下来。
    inGit: false,
  });

  // ---- 项目层 ----
  let projectRoot: string | undefined;
  let inGit = false;
  let workspace: string | undefined;
  let found: { root: string; inGit: boolean } | undefined;
  const rawWorkspace = typeof options.workspace === "string" ? options.workspace.trim() : "";
  if (rawWorkspace !== "") {
    const resolved = path.resolve(rawWorkspace);
    if (await isDirectory(resolved)) workspace = resolved;
    else warnings.push("工作区目录不存在或不是目录：" + resolved + "（只显示全局提示词）");
  }
  if (workspace !== undefined) {
    found = await findProjectRoot(workspace, settings.projectRootMarkers);
    projectRoot = found.root;
    inGit = found.inGit;
    for (const dir of layerDirs(projectRoot, workspace)) {
      const isRoot = pathKey(dir) === pathKey(projectRoot);
      const isWs = pathKey(dir) === pathKey(workspace);
      const rel = path.relative(projectRoot, dir);
      const displayDir = rel === "" ? "." : rel.split(path.sep).join("/");
      const label = isRoot ? "项目根" : isWs ? "工作区" : "目录 " + displayDir;
      const candidates = await candidatesIn(dir, settings.fileNames, warnings, label);
      const files: PromptFile[] = [];
      const digests: (string | undefined)[] = [];
      for (const candidate of candidates) {
        const base = path.basename(candidate.path);
        const displayPath = displayDir === "." ? base : displayDir + "/" + base;
        const read = await toPromptFile(candidate, displayPath, settings.maxSourceBytes);
        files.push(read.file);
        digests.push(read.digest);
      }
      applyDuplicates(files, digests);
      layers.push({
        scope: "project",
        dir,
        displayDir,
        isProjectRoot: isRoot,
        isWorkspace: isWs,
        files,
        canCreate: (isRoot || isWs) && (await canCreateIn(dir, settings.fileNames)),
        // 项目层都在项目根之下，项目根命中标记时整棵树都在同一个仓库里。
        inGit: found?.inGit === true,
      });
    }
  }

  // ---- 预算（只算会加载的文件；顺序 = 层顺序 + 层内文件顺序） ----
  for (const layer of layers) {
    for (const file of layer.files) {
      if (file.disabled || file.duplicateOf !== undefined || file.tooLarge === true) continue;
      budgetCandidates.push({ name: file.name, displayPath: file.displayPath, bytes: file.size });
      budgetTargets.push(file);
    }
  }
  const estimate = estimateBudget(budgetCandidates, settings.maxBytes);
  estimate.marks.forEach((mark: BudgetMark | undefined, index: number) => {
    const target = budgetTargets[index];
    if (target === undefined || mark === undefined) return;
    target.budget = mark;
  });

  const discovery: PromptDiscovery = { layers, inGit, warnings };
  if (projectRoot !== undefined) discovery.projectRoot = projectRoot;
  if (workspace !== undefined) discovery.workspace = workspace;
  const fileById = new Map<string, PromptFile>();
  for (const layer of layers) for (const file of layer.files) fileById.set(file.id, file);
  return { discovery, fileById, usedBytes: estimate.usedBytes };
}
