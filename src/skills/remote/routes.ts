/**
 * 「技能·远程」路由（PLAN §3.7）。全部相对路径不带前缀，键形如 "GET skills/sources"。
 *
 * 返回值的错误码与中文文案遵循 §3.1：BAD_REQUEST(400) / VALIDATION(422) /
 * NOT_FOUND(404) / CONFLICT(409) / UPSTREAM(502) / RATE_LIMITED(429) / INTERNAL(500)。
 */

import { parseRepoRef } from "./sourceurl.ts";
import { badRequest, validation } from "../../shared/errors.ts";
import { assertRepoShape } from "./repos.ts";
import { browseRepo } from "./browse.ts";
import { discoverSources } from "./discover.ts";
import type { RepoCatalog } from "./repo-catalog.ts";
import { installSkills, registerSource, unregisterSource, assertInstallTarget } from "./install.ts";
import { applyUpdates, checkUpdates } from "./updates.ts";
import { normalizeSkillsShResponse } from "./github.ts";
import type { GitHubClient } from "./github.ts";
import type { Redactor } from "./redact.ts";
import type { RepoStore } from "./repos.ts";
import type { SourceStore } from "./lockstore.ts";
import type { RemoteOptions, SkillsLocalPort } from "./types.ts";
import type { HubContext, RouteHandler } from "../../platform/contract/host.ts";
import type { InstallTarget } from "../contract/remote.ts";

export interface RoutesDeps {
  ctx: HubContext;
  skills: SkillsLocalPort;
  github: GitHubClient;
  sources: SourceStore;
  repos: RepoStore;
  /** 仓库列表 + 发现（增改删的补扫规则都在里面） */
  catalog: RepoCatalog;
  redactor: Redactor;
  now?: RemoteOptions["now"];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string, label: string): string {
  const raw = body[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw validation(`参数 ${key}（${label}）不能为空。`, [{ path: key, message: "必须是非空字符串" }]);
  }
  return raw.trim();
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw validation(`参数 ${key} 必须是字符串。`, [{ path: key, message: "必须是字符串" }]);
  }
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw validation(`参数 ${key} 必须是字符串数组。`, [{ path: key, message: "必须是数组" }]);
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw validation(`参数 ${key} 里只能放字符串。`, [{ path: key, message: "元素必须是字符串" }]);
    }
    const trimmed = item.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

/** 解析 repo 字段：owner/name 或 GitHub URL（含 /tree/<ref>/<path>） */
function optionalPatchString(body: Record<string, unknown>, key: string): string | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw validation(`参数 ${key} 必须是字符串。`, [{ path: key, message: "必须是字符串" }]);
  }
  // 与 optionalString 不同：空串有意义（= 清除该字段）
  return raw.trim();
}

function resolveRepoInput(raw: string, explicitRef?: string): { repo: string; ref?: string; subPath?: string } {
  const parsed = parseRepoRef(raw);
  const repo = assertRepoShape(parsed.repo);
  const out: { repo: string; ref?: string; subPath?: string } = { repo };
  const ref = explicitRef !== undefined && explicitRef.trim() !== "" ? explicitRef.trim() : parsed.ref;
  if (ref !== undefined && ref !== "") out.ref = ref;
  if (parsed.subPath !== undefined && parsed.subPath !== "") out.subPath = parsed.subPath;
  return out;
}

export function createSkillsRemoteRoutes(deps: RoutesDeps): Record<string, RouteHandler> {
  const { ctx, skills, github, sources, repos, catalog } = deps;
  const now = deps.now;

  const routes: Record<string, RouteHandler> = {};

  routes["GET skills/sources"] = async (req) => {
    const workspace = req.query["workspace"];
    const entries = await sources.list();
    const listed = await skills.list(workspace !== undefined ? { workspace } : {});
    // 把 lock 条目里没有对应技能目录的悬空条目也标出来（UI 需要提示）
    const ids = new Set(listed.skills.map((s) => s.id));
    return {
      entries: entries.map((entry) => ({
        ...entry,
        // 悬空条目：lock 里有记录、但本机已经找不到对应技能目录（F4-Q3 提到的风险）
        orphan: !ids.has(entry.skillId),
      })),
    };
  };

  routes["POST skills/sources/discover"] = async (req) => {
    const body = asRecord(req.body);
    const ids = optionalStringArray(body, "ids");
    const workspace = optionalString(body, "workspace");
    const candidates = await discoverSources({ skills, sources, repos }, { ids, workspace });
    return { candidates };
  };

  routes["POST skills/sources/register"] = async (req) => {
    const body = asRecord(req.body);
    const skillId = requireString(body, "skillId", "技能 ID");
    const repoRaw = requireString(body, "repo", "仓库");
    const ref = optionalString(body, "ref");
    const skillPath = optionalString(body, "skillPath");
    const workspace = optionalString(body, "workspace");
    const resolved = resolveRepoInput(repoRaw, ref);
    const entry = await registerSource(
      { ctx, skills, sources, now },
      {
        skillId,
        repo: resolved.repo,
        ref: resolved.ref,
        skillPath,
        workspace,
      },
    );
    return { entry };
  };

  routes["POST skills/sources/unregister"] = async (req) => {
    const body = asRecord(req.body);
    const skillId = requireString(body, "skillId", "技能 ID");
    const workspace = optionalString(body, "workspace");
    await unregisterSource({ skills, sources }, { skillId, workspace });
    return {};
  };

  routes["POST skills/updates/check"] = async (req) => {
    const body = asRecord(req.body);
    const ids = optionalStringArray(body, "ids");
    const workspace = optionalString(body, "workspace");
    return await checkUpdates({ github, skills, sources, now }, { ids, workspace });
  };

  routes["POST skills/updates/apply"] = async (req) => {
    const body = asRecord(req.body);
    const ids = optionalStringArray(body, "ids");
    if (ids === undefined || ids.length === 0) throw badRequest("请至少选择一个要更新的技能。");
    const workspace = optionalString(body, "workspace");
    return await applyUpdates({ github, skills, sources, now }, { ids, workspace });
  };

  routes["GET skills/repos"] = async () => ({ repos: await catalog.list() });

  routes["POST skills/repos/add"] = async (req) => {
    const body = asRecord(req.body);
    const repoRaw = requireString(body, "repo", "仓库");
    const ref = optionalString(body, "ref");
    const subPath = optionalString(body, "subPath");
    const workspace = optionalString(body, "workspace");
    const resolved = resolveRepoInput(repoRaw, ref);
    return await catalog.add(
      { repo: resolved.repo, ref: resolved.ref, subPath: subPath ?? resolved.subPath },
      { workspace, signal: req.signal },
    );
  };

  routes["POST skills/repos/update"] = async (req) => {
    const body = asRecord(req.body);
    const repoRaw = requireString(body, "repo", "仓库");
    const ref = optionalPatchString(body, "ref");
    const subPath = optionalPatchString(body, "subPath");
    const workspace = optionalString(body, "workspace");
    if (ref === undefined && subPath === undefined) throw badRequest("请至少修改分支或子目录中的一项。");
    const resolved = resolveRepoInput(repoRaw);
    const patch: { ref?: string; subPath?: string } = {};
    if (ref !== undefined) patch.ref = ref;
    if (subPath !== undefined) patch.subPath = subPath;
    return await catalog.update(resolved.repo, patch, { workspace, signal: req.signal });
  };

  routes["POST skills/repos/remove"] = async (req) => {
    const body = asRecord(req.body);
    const repoRaw = requireString(body, "repo", "仓库");
    const workspace = optionalString(body, "workspace");
    const resolved = resolveRepoInput(repoRaw);
    return await catalog.remove(resolved.repo, { workspace });
  };

  routes["GET skills/discovery"] = async (req) => {
    const workspace = req.query["workspace"];
    return await catalog.view(workspace);
  };

  routes["POST skills/discovery/refresh"] = async (req) => {
    const body = asRecord(req.body);
    const only = optionalStringArray(body, "repos");
    const workspace = optionalString(body, "workspace");
    return await catalog.refresh({ repos: only, workspace, signal: req.signal });
  };

  routes["POST skills/repo/browse"] = async (req) => {
    const body = asRecord(req.body);
    const repoRaw = requireString(body, "repo", "仓库");
    const ref = optionalString(body, "ref");
    const workspace = optionalString(body, "workspace");
    const resolved = resolveRepoInput(repoRaw, ref);
    return await browseRepo(
      { github, skills },
      { repo: resolved.repo, ref: resolved.ref, subPath: resolved.subPath, workspace, signal: req.signal },
    );
  };

  routes["GET skills/search"] = async (req) => {
    const q = (req.query["q"] ?? "").trim();
    if (q.length < 2) throw badRequest("搜索关键词至少需要 2 个字符。");
    const limitText = req.query["limit"];
    let limit = 20;
    if (limitText !== undefined && limitText !== "") {
      const parsed = Number.parseInt(limitText, 10);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
        throw validation("limit 必须是 1-100 之间的整数。", [{ path: "limit", message: "超出范围" }]);
      }
      limit = parsed;
    }
    const payload = await github.searchSkillsSh(q, limit, 0);
    // 已知来源里能找到同名技能时，顺手补上 skillPath（便于 UI 直接跳安装）
    const known = new Map(
      (await sources.list()).map((entry) => [
        `${entry.repo.toLowerCase()}|${entry.skillId.toLowerCase()}`,
        entry.skillPath,
      ]),
    );
    const results = normalizeSkillsShResponse(payload, {
      skillPathLookup: (repo, skillId) => known.get(`${repo.toLowerCase()}|${skillId.toLowerCase()}`),
    });
    return { results };
  };

  routes["POST skills/install"] = async (req) => {
    const body = asRecord(req.body);
    const repoRaw = requireString(body, "repo", "仓库");
    const ref = optionalString(body, "ref");
    const targetRaw = requireString(body, "target", "安装目标");
    const workspace = optionalString(body, "workspace");
    const skillPaths = optionalStringArray(body, "skillPaths");
    if (skillPaths === undefined || skillPaths.length === 0) throw badRequest("请至少选择一个要安装的技能。");
    const resolved = resolveRepoInput(repoRaw, ref);
    const target: InstallTarget = assertInstallTarget(targetRaw);
    const results = await installSkills(
      { ctx, github, skills, sources, now },
      { repo: resolved.repo, ref: resolved.ref, skillPaths, target, workspace },
    );
    return { results };
  };

  routes["GET skills/github-auth"] = async () => {
    const auth = await github.auth();
    const payload: { mode: string; rateLimitRemaining?: number } = { mode: auth.mode };
    // FIX-6（D-3）：主动查一次剩余额度（GET /rate_limit 不消耗配额）。
    // 查不到（网络失败 / HTTP 错误 / 响应不合法）就省略这个字段，不报错。
    const probed = await github.rateLimit();
    if (probed?.remaining !== undefined) payload.rateLimitRemaining = probed.remaining;
    return payload;
  };

  return routes;
}
