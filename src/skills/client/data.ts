/**
 * 技能标签页的接口封装（PLAN §3.7 的 skills/local 组）。
 *
 * 只做三件事：拼查询参数、调 api.get/api.post、把 data 里的字段取出来。
 * 错误一律原样抛出（都是 shell/api.ts 的 ApiError，message 是服务端给的中文），
 * 由调用方转成界面状态。
 */

import { api } from "../../platform/client/api.ts";
import type { ListResult, SkillSummary, SkillView, TrashItem } from "./types.ts";

/**
 * 当前会话工作区参数；undefined 与空白串都不下发 —— 宿主在没有 workspace 时
 * 不会解析项目级根（D-B2 / src/skills/local/scan.ts:49），界面上也就不会出现
 * project-dsh / project-agents 两组，并且会显示「没有当前会话工作区」的说明。
 */
export function workspaceQuery(workspace: string | undefined): Record<string, unknown> | undefined {
  if (typeof workspace !== "string" || workspace.trim() === "") return undefined;
  return { workspace };
}

/** GET skills/list ?workspace= → { roots, skills, warnings }。 */
export async function listSkills(workspace: string | undefined): Promise<ListResult> {
  const data = await api.get<Partial<ListResult>>("skills/list", workspaceQuery(workspace));
  return {
    roots: Array.isArray(data?.roots) ? data.roots : [],
    skills: Array.isArray(data?.skills) ? data.skills : [],
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  };
}

/** GET skills/view ?id=&workspace= → { skill, content, files }。 */
export async function viewSkill(id: string, workspace: string | undefined): Promise<SkillView> {
  const query: Record<string, unknown> = { id, ...(workspaceQuery(workspace) ?? {}) };
  const data = await api.get<SkillView>("skills/view", query);
  return { skill: data.skill, content: typeof data.content === "string" ? data.content : "", files: Array.isArray(data.files) ? data.files : [] };
}

/** POST skills/set-enabled { id, enabled, workspace? } → { skill }。 */
export async function setSkillEnabled(
  id: string,
  enabled: boolean,
  workspace: string | undefined,
): Promise<SkillSummary> {
  const body: Record<string, unknown> = { id, enabled, ...(workspaceQuery(workspace) ?? {}) };
  const data = await api.post<{ skill: SkillSummary }>("skills/set-enabled", body);
  return data.skill;
}

/** POST skills/delete { id, workspace? } → { item: TrashItem }。 */
export async function deleteSkill(id: string, workspace: string | undefined): Promise<TrashItem> {
  const body: Record<string, unknown> = { id, ...(workspaceQuery(workspace) ?? {}) };
  const data = await api.post<{ item: TrashItem }>("skills/delete", body);
  return data.item;
}

/** GET skills/trash → { items }。 */
export async function listTrash(): Promise<TrashItem[]> {
  const data = await api.get<{ items?: TrashItem[] }>("skills/trash");
  return Array.isArray(data?.items) ? data.items : [];
}

/** POST skills/trash/restore { trashId, replace?, workspace? } → { skill }。 */
export async function restoreTrash(
  trashId: string,
  replace: boolean,
  workspace: string | undefined,
): Promise<SkillSummary> {
  const body: Record<string, unknown> = { trashId, ...(workspaceQuery(workspace) ?? {}) };
  if (replace) body.replace = true;
  const data = await api.post<{ skill: SkillSummary }>("skills/trash/restore", body);
  return data.skill;
}

/** POST skills/trash/purge { trashId? } → { purged }（省略 trashId = 清空全部）。 */
export async function purgeTrash(trashId: string | undefined): Promise<number> {
  const body: Record<string, unknown> = {};
  if (trashId !== undefined) body.trashId = trashId;
  const data = await api.post<{ purged?: number }>("skills/trash/purge", body);
  return typeof data?.purged === "number" ? data.purged : 0;
}
