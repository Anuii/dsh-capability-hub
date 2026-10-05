/**
 * 技能标签页「远程部分」的接口封装（PLAN §3.7 的 skills 远程组）。
 *
 * 只做三件事：拼参数、调 api.get/api.post、把 data 里的字段取出来。
 * 错误一律原样抛出（shell/api.ts 的 ApiError，message 是服务端给的中文），由调用方转成界面状态。
 * workspace 参数复用本地部分的 workspaceQuery()：空值不下发。
 */

import { api } from "../../../platform/client/api.ts";
import { workspaceQuery } from "../data.ts";
import type {
  BrowseResult,
  DiscoverCandidate,
  DiscoveryView,
  DiscoveryRepoView,
  GithubAuth,
  InstallItemResult,
  InstallTarget,
  RepoRecord,
  SearchResultItem,
  SourceEntry,
  UpdateApplyResult,
  UpdateCheckResult,
} from "../../contract/remote.ts";

function withWorkspace(body: Record<string, unknown>, workspace: string | undefined): Record<string, unknown> {
  return { ...body, ...(workspaceQuery(workspace) ?? {}) };
}

/* ---------------- 来源 ---------------- */

/** GET skills/sources ?workspace= → { entries } */
export async function listSources(workspace: string | undefined): Promise<SourceEntry[]> {
  const data = await api.get<{ entries?: SourceEntry[] }>("skills/sources", workspaceQuery(workspace));
  return Array.isArray(data?.entries) ? data.entries : [];
}

/** POST skills/sources/discover { ids?, workspace? } → { candidates } */
export async function discoverSources(
  ids: readonly string[] | undefined,
  workspace: string | undefined,
): Promise<DiscoverCandidate[]> {
  const body: Record<string, unknown> = {};
  if (ids !== undefined && ids.length > 0) body.ids = [...ids];
  const data = await api.post<{ candidates?: DiscoverCandidate[] }>(
    "skills/sources/discover",
    withWorkspace(body, workspace),
  );
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

export interface RegisterInput {
  skillId: string;
  repo: string;
  ref?: string;
  skillPath?: string;
}

/** POST skills/sources/register → { entry } */
export async function registerSource(input: RegisterInput, workspace: string | undefined): Promise<SourceEntry> {
  const body: Record<string, unknown> = { skillId: input.skillId, repo: input.repo };
  if (input.ref !== undefined && input.ref.trim() !== "") body.ref = input.ref.trim();
  if (input.skillPath !== undefined && input.skillPath.trim() !== "") body.skillPath = input.skillPath.trim();
  const data = await api.post<{ entry: SourceEntry }>("skills/sources/register", withWorkspace(body, workspace));
  return data.entry;
}

/** POST skills/sources/unregister { skillId, workspace? } → {} */
export async function unregisterSource(skillId: string, workspace: string | undefined): Promise<void> {
  await api.post("skills/sources/unregister", withWorkspace({ skillId }, workspace));
}

/* ---------------- 更新 ---------------- */

/** POST skills/updates/check { ids?, workspace? } → { results, auth, rateLimitRemaining? } */
export async function checkUpdates(
  ids: readonly string[] | undefined,
  workspace: string | undefined,
): Promise<UpdateCheckResult> {
  const body: Record<string, unknown> = {};
  if (ids !== undefined && ids.length > 0) body.ids = [...ids];
  const data = await api.post<Partial<UpdateCheckResult>>("skills/updates/check", withWorkspace(body, workspace));
  return {
    results: Array.isArray(data?.results) ? data.results : [],
    auth: (data?.auth ?? "anonymous") as UpdateCheckResult["auth"],
    ...(typeof data?.rateLimitRemaining === "number" ? { rateLimitRemaining: data.rateLimitRemaining } : {}),
  };
}

/** POST skills/updates/apply { ids, workspace? } → { results } */
export async function applyUpdates(ids: readonly string[], workspace: string | undefined): Promise<UpdateApplyResult> {
  const data = await api.post<Partial<UpdateApplyResult>>(
    "skills/updates/apply",
    withWorkspace({ ids: [...ids] }, workspace),
  );
  return { results: Array.isArray(data?.results) ? data.results : [] };
}

/* ---------------- 仓库列表 ---------------- */

/** GET skills/repos → { repos } */
export async function listRepos(): Promise<RepoRecord[]> {
  const data = await api.get<{ repos?: RepoRecord[] }>("skills/repos");
  return Array.isArray(data?.repos) ? data.repos : [];
}

/** 把接口返回的发现视图补成安全形状。 */
export function normalizeDiscovery(data: Partial<DiscoveryView> | undefined): DiscoveryView {
  return {
    cached: data?.cached === true,
    ...(typeof data?.lastScannedAt === "string" ? { lastScannedAt: data.lastScannedAt } : {}),
    repos: Array.isArray(data?.repos)
      ? data.repos.filter(
          (r): r is DiscoveryRepoView => r !== null && typeof r === "object" && typeof r.repo === "string",
        )
      : [],
    skills: Array.isArray(data?.skills)
      ? data.skills.filter(
          (s) => s !== null && typeof s === "object" && typeof s.skillPath === "string" && typeof s.repo === "string",
        )
      : [],
  };
}

export interface RepoChange {
  repos: RepoRecord[];
  discovery: DiscoveryView;
}

/** POST skills/repos/add { repo, ref?, subPath?, workspace? } → { repo, repos, discovery }（宿主已补扫这个仓库） */
export async function addRepo(
  repo: string,
  ref: string | undefined,
  workspace?: string,
  subPath?: string,
): Promise<RepoChange> {
  const body: Record<string, unknown> = { repo };
  if (ref !== undefined && ref.trim() !== "") body.ref = ref.trim();
  if (subPath !== undefined && subPath.trim() !== "") body.subPath = subPath.trim();
  const data = await api.post<{ repos?: RepoRecord[]; discovery?: Partial<DiscoveryView> }>(
    "skills/repos/add",
    withWorkspace(body, workspace),
  );
  return { repos: Array.isArray(data?.repos) ? data.repos : [], discovery: normalizeDiscovery(data?.discovery) };
}

/** POST skills/repos/update { repo, ref?, subPath?, workspace? }（空串 = 清除）→ { repo, changed, repos, discovery } */
export async function updateRepo(
  repo: string,
  patch: { ref?: string; subPath?: string },
  workspace?: string,
): Promise<RepoChange> {
  const body: Record<string, unknown> = { repo };
  if (patch.ref !== undefined) body.ref = patch.ref.trim();
  if (patch.subPath !== undefined) body.subPath = patch.subPath.trim();
  const data = await api.post<{ repos?: RepoRecord[]; discovery?: Partial<DiscoveryView> }>(
    "skills/repos/update",
    withWorkspace(body, workspace),
  );
  return { repos: Array.isArray(data?.repos) ? data.repos : [], discovery: normalizeDiscovery(data?.discovery) };
}

/** POST skills/repos/remove { repo, workspace? } → { repos, discovery } */
export async function removeRepo(repo: string, workspace?: string): Promise<RepoChange> {
  const data = await api.post<{ repos?: RepoRecord[]; discovery?: Partial<DiscoveryView> }>(
    "skills/repos/remove",
    withWorkspace({ repo }, workspace),
  );
  return { repos: Array.isArray(data?.repos) ? data.repos : [], discovery: normalizeDiscovery(data?.discovery) };
}

/* ---------------- 汇总发现 ---------------- */

/** GET skills/discovery ?workspace= → 只读缓存，不联网 */
export async function fetchDiscovery(workspace: string | undefined): Promise<DiscoveryView> {
  return normalizeDiscovery(await api.get<Partial<DiscoveryView>>("skills/discovery", workspaceQuery(workspace)));
}

/** POST skills/discovery/refresh { repos?, workspace? } → 联网扫描 */
export async function refreshDiscovery(
  workspace: string | undefined,
  repos?: readonly string[],
): Promise<DiscoveryView> {
  const body: Record<string, unknown> = {};
  if (repos !== undefined && repos.length > 0) body.repos = [...repos];
  return normalizeDiscovery(
    await api.post<Partial<DiscoveryView>>("skills/discovery/refresh", withWorkspace(body, workspace)),
  );
}

/* ---------------- 浏览 / 搜索 / 安装 ---------------- */

/** POST skills/repo/browse { repo, ref?, workspace? } → { repo, ref, skills } */
export async function browseRepo(
  repo: string,
  ref: string | undefined,
  workspace: string | undefined,
): Promise<BrowseResult> {
  const body: Record<string, unknown> = { repo };
  if (ref !== undefined && ref.trim() !== "") body.ref = ref.trim();
  const data = await api.post<BrowseResult>("skills/repo/browse", withWorkspace(body, workspace));
  return { repo: data.repo, ref: data.ref, skills: Array.isArray(data.skills) ? data.skills : [] };
}

/** GET skills/search ?q=&limit= → { results } */
export async function searchSkills(query: string, limit = 20): Promise<SearchResultItem[]> {
  const data = await api.get<{ results?: SearchResultItem[] }>("skills/search", { q: query, limit });
  return Array.isArray(data?.results) ? data.results : [];
}

export interface InstallInput {
  repo: string;
  ref?: string;
  skillPaths: readonly string[];
  target: InstallTarget;
}

/** POST skills/install { repo, ref?, skillPaths, target, workspace? } → { results } */
export async function installSkills(input: InstallInput, workspace: string | undefined): Promise<InstallItemResult[]> {
  const body: Record<string, unknown> = {
    repo: input.repo,
    skillPaths: [...input.skillPaths],
    target: input.target,
  };
  if (input.ref !== undefined && input.ref.trim() !== "") body.ref = input.ref.trim();
  const data = await api.post<{ results?: InstallItemResult[] }>("skills/install", withWorkspace(body, workspace));
  return Array.isArray(data?.results) ? data.results : [];
}

/** GET skills/github-auth → { mode, rateLimitRemaining? }（只返回模式，绝不含令牌） */
export async function fetchGithubAuth(): Promise<GithubAuth> {
  const data = await api.get<Partial<GithubAuth>>("skills/github-auth");
  return {
    mode: (data?.mode ?? "anonymous") as GithubAuth["mode"],
    ...(typeof data?.rateLimitRemaining === "number" ? { rateLimitRemaining: data.rateLimitRemaining } : {}),
  };
}
