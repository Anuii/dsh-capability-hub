/**
 * 提示词标签页的接口封装：契约里的各条路由 + 状态仓库用的 HTTP adapter。
 *
 * 只做三件事：拼查询参数、调 api.get/api.post、把 data 补成安全形状。
 * 错误一律原样抛出（都是 platform/client/api.ts 的 ApiError，message 是服务端给的中文），
 * 由调用方转成界面状态（错误码与逐字段错误用 errorCodeOf / fieldErrorsOf 判断）。
 */

import { api } from "../../platform/client/api.ts";
import type {
  PromptCreateLocation,
  PromptFile,
  PromptLayer,
  PromptsListResult,
  PromptTrashItem,
  PromptView,
} from "../contract/prompts.ts";
import type { PromptsAdapter } from "./prompts-store.ts";

/**
 * 当前会话工作区参数；undefined 与空白串都不下发 —— 宿主在没有 workspace 时
 * 只发现全局层（契约：没有工作区时 layers 里只有全局层）。
 */
export function workspaceQuery(workspace: string | undefined): Record<string, unknown> | undefined {
  if (typeof workspace !== "string" || workspace.trim() === "") return undefined;
  return { workspace };
}

/** 补成安全形状：契约里的字段一个都不能少，缺的给缺省值。 */
function normalizeFile(raw: Partial<PromptFile> | undefined): PromptFile {
  return {
    id: typeof raw?.id === "string" ? raw.id : "",
    name: raw?.name ?? "AGENTS.md",
    path: typeof raw?.path === "string" ? raw.path : "",
    displayPath: typeof raw?.displayPath === "string" ? raw.displayPath : "",
    disabled: raw?.disabled === true,
    size: typeof raw?.size === "number" ? raw.size : 0,
    mtimeMs: typeof raw?.mtimeMs === "number" ? raw.mtimeMs : 0,
    version: typeof raw?.version === "string" ? raw.version : "",
    ...(raw?.duplicateOf === undefined ? {} : { duplicateOf: raw.duplicateOf }),
    ...(raw?.tooLarge === true ? { tooLarge: true } : {}),
    ...(raw?.budget === undefined ? {} : { budget: raw.budget }),
  };
}

function normalizeLayer(raw: Partial<PromptLayer>): PromptLayer {
  return {
    scope: raw.scope === "project" ? "project" : "global",
    dir: typeof raw.dir === "string" ? raw.dir : "",
    displayDir: typeof raw.displayDir === "string" ? raw.displayDir : "",
    isProjectRoot: raw.isProjectRoot === true,
    isWorkspace: raw.isWorkspace === true,
    files: Array.isArray(raw.files) ? raw.files.map((file) => normalizeFile(file)) : [],
    canCreate: raw.canCreate === true,
    inGit: raw.inGit === true,
  };
}

/** GET prompts/list ?workspace= → { layers, projectRoot?, budget, loaderDisabled?, warnings }；git 提示按层给（layer.inGit）。 */
export async function listPrompts(workspace: string | undefined): Promise<PromptsListResult> {
  const data = await api.get<Partial<PromptsListResult>>("prompts/list", workspaceQuery(workspace));
  const budget = data?.budget;
  return {
    layers: Array.isArray(data?.layers) ? data.layers.map((layer) => normalizeLayer(layer)) : [],
    ...(typeof data?.projectRoot === "string" ? { projectRoot: data.projectRoot } : {}),
    budget: {
      maxBytes: typeof budget?.maxBytes === "number" ? budget.maxBytes : 65536,
      usedBytes: typeof budget?.usedBytes === "number" ? budget.usedBytes : 0,
      source: budget?.source === "dsh-config" ? "dsh-config" : "default",
    },
    ...(data?.loaderDisabled === true ? { loaderDisabled: true } : {}),
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  };
}

/** GET prompts/view ?id=&workspace= → { file, content }。 */
export async function viewPrompt(id: string, workspace: string | undefined): Promise<PromptView> {
  const data = await api.get<Partial<PromptView>>("prompts/view", { id, ...(workspaceQuery(workspace) ?? {}) });
  return {
    file: normalizeFile(data?.file),
    content: typeof data?.content === "string" ? data.content : "",
  };
}

/** POST prompts/save { id, content, baseVersion, workspace? } → { file }。 */
export async function savePrompt(
  id: string,
  content: string,
  baseVersion: string,
  workspace: string | undefined,
): Promise<PromptFile> {
  const data = await api.post<{ file?: Partial<PromptFile> }>("prompts/save", {
    id,
    content,
    baseVersion,
    ...(workspaceQuery(workspace) ?? {}),
  });
  return normalizeFile(data?.file);
}

/** POST prompts/create { location, workspace? } → { file }。 */
export async function createPrompt(location: PromptCreateLocation, workspace: string | undefined): Promise<PromptFile> {
  const data = await api.post<{ file?: Partial<PromptFile> }>("prompts/create", {
    location,
    ...(workspaceQuery(workspace) ?? {}),
  });
  return normalizeFile(data?.file);
}

/** POST prompts/set-enabled { id, enabled, workspace? } → { file }。 */
export async function setPromptEnabled(
  id: string,
  enabled: boolean,
  workspace: string | undefined,
): Promise<PromptFile> {
  const data = await api.post<{ file?: Partial<PromptFile> }>("prompts/set-enabled", {
    id,
    enabled,
    ...(workspaceQuery(workspace) ?? {}),
  });
  return normalizeFile(data?.file);
}

/** GET prompts/trash → { items }。 */
export async function listPromptTrash(): Promise<PromptTrashItem[]> {
  const data = await api.get<{ items?: PromptTrashItem[] }>("prompts/trash");
  return Array.isArray(data?.items) ? data.items : [];
}

/** POST prompts/trash/restore { trashId, workspace? } → { file }。 */
export async function restorePromptTrash(trashId: string, workspace: string | undefined): Promise<PromptFile> {
  const data = await api.post<{ file?: Partial<PromptFile> }>("prompts/trash/restore", {
    trashId,
    ...(workspaceQuery(workspace) ?? {}),
  });
  return normalizeFile(data?.file);
}

/** POST prompts/trash/purge { trashId? } → { purged }（省略 trashId = 清空）。 */
export async function purgePromptTrash(trashId: string | undefined): Promise<number> {
  const body: Record<string, unknown> = {};
  if (trashId !== undefined) body.trashId = trashId;
  const data = await api.post<{ purged?: number }>("prompts/trash/purge", body);
  return typeof data?.purged === "number" ? data.purged : 0;
}

/** 提示词页数据仓库（prompts-store.ts）的 HTTP adapter。 */
export const promptsApi: PromptsAdapter = {
  list: listPrompts,
  view: viewPrompt,
  save: savePrompt,
  create: createPrompt,
  setEnabled: setPromptEnabled,
  trash: listPromptTrash,
  restore: restorePromptTrash,
  purge: purgePromptTrash,
};
