/**
 * 「技能·远程」路由（PLAN §3.7）。全部相对路径不带前缀，键形如 "GET skills/sources"。
 *
 * 返回值的错误码与中文文案遵循 §3.1：BAD_REQUEST(400) / VALIDATION(422) /
 * NOT_FOUND(404) / CONFLICT(409) / UPSTREAM(502) / RATE_LIMITED(429) / INTERNAL(500)。
 *
 * skills.sh 搜索缓存（0.10.0，D-B19）：搜索**成功**时把结果写进共享搜索缓存
 * <hubHome>/search-cache.json（shared/node/search-cache.ts，键 = "skills.sh" + \u0000 + 归一化关键词），
 * 响应带 provenance: { route: "direct", at }——skills.sh 不走镜像，路线固定直连。
 * 搜索**失败**（网络异常 / 超时 / 429 / 5xx）且同一关键词有缓存时，返回缓存的 results 与
 * provenance: { route: "cache", at: 缓存写入时刻 }，不报错；没有缓存才抛原来的中文错误。
 * 缓存读写失败只降级（记 warning），绝不影响搜索结果。
 */

import { parseRepoRef } from "./sourceurl.ts";
import { badRequest, validation } from "../../shared/errors.ts";
import { errorText } from "../../shared/error-text.ts";
import {
  lookup,
  readSearchCache,
  searchCacheFilePath,
  store,
  writeSearchCache,
  type SearchCacheEntry,
} from "../../shared/node/search-cache.ts";
import { optionalInput, optionalInputList, patchInput, recordOrEmpty, requireInput } from "../../shared/request.ts";
import { assertMirrorInput, normalizeMirror, readSettings, writeSettings } from "./settings.ts";
import { assertRepoShape } from "./repos.ts";
import { browseRepo } from "./browse.ts";
import type { RepoCatalog } from "./repo-catalog.ts";
import type { SkillMetaReader } from "./skill-meta.ts";
import { installSkills, registerSource, unregisterSource, assertInstallTarget } from "./install.ts";
import { applyUpdates, checkUpdates } from "./updates.ts";
import { normalizeSkillsShResponse } from "./github.ts";
import type { GitHubClient } from "./github.ts";
import type { Redactor } from "./redact.ts";
import type { RepoStore } from "./repos.ts";
import type { SourceStore } from "./lockstore.ts";
import type { FingerprintStore } from "./fingerprints.ts";
import type { RemoteOptions, SkillsLocalPort } from "./types.ts";
import type { HubContext, RouteHandler } from "../../platform/contract/host.ts";
import type {
  InstallTarget,
  MirrorTestResult,
  SearchResponse,
  SearchResultItem,
  SkillsRemoteSettings,
} from "../contract/remote.ts";

export interface RoutesDeps {
  ctx: HubContext;
  skills: SkillsLocalPort;
  github: GitHubClient;
  sources: SourceStore;
  repos: RepoStore;
  /** 仓库列表 + 发现（增改删的补扫规则都在里面） */
  catalog: RepoCatalog;
  /** 读 SKILL.md 的 name / description（DSH 同一个 yaml 库） */
  meta: SkillMetaReader;
  redactor: Redactor;
  /** 目录指纹存档（D-B18） */
  fingerprints?: FingerprintStore;
  now?: RemoteOptions["now"];
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

/** 记录形状的兜底判断（缓存里的 payload 是 unknown）。 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 这些失败才用缓存顶（D-B19：网络异常 / 超时 / 429 / 5xx）。
 * 其余错误（例如路由层自己的 400 / 422）照旧原样抛——参数错误不该被一份旧结果掩盖。
 */
function isCacheableSearchFailure(error: unknown): boolean {
  const code = isRecord(error) ? error.code : undefined;
  return code === "UPSTREAM" || code === "RATE_LIMITED";
}

export function createSkillsRemoteRoutes(deps: RoutesDeps): Record<string, RouteHandler> {
  const { ctx, skills, github, sources, repos, catalog, meta, fingerprints } = deps;
  const now = deps.now;

  const routes: Record<string, RouteHandler> = {};

  /* ---------- skills.sh 搜索缓存（0.10.0，D-B19） ---------- */

  /** 缓存文件：<hubHome>/search-cache.json（与 mcp-registry 共用一份，键带来源前缀）。 */
  const searchCacheFile = searchCacheFilePath(ctx.hubHome);

  /**
   * 把一次成功的搜索结果写进缓存（同一个关键词只留最近 1 条）。
   * 缓存只是「有更好」：读写失败只记 warning，本次响应照常返回，绝不因此报错。
   */
  async function rememberSearch(query: string, results: SearchResultItem[], at: string): Promise<void> {
    try {
      const cache = await readSearchCache(searchCacheFile);
      const entry: SearchCacheEntry = {
        source: "skills.sh",
        query,
        at,
        // skills.sh 永不走 GitHub 镜像（D-B19）：实际路线固定是直连
        route: "direct",
        payload: { results },
      };
      await writeSearchCache(searchCacheFile, store(cache, entry));
      ctx.logger.debug("skills-remote: 搜索「" + query + "」的结果已写入搜索缓存");
    } catch (error) {
      ctx.logger.warn("skills-remote: 写搜索缓存失败（本次搜索结果照常返回）：" + errorText(error));
    }
  }

  /**
   * 失败回落：同一关键词（trim + 小写后）有缓存就返回缓存的 results，
   * provenance 标的是**缓存写入时刻**（界面上显示「缓存于 X」）。
   */
  async function cachedSearch(query: string): Promise<SearchResponse | undefined> {
    const cache = await readSearchCache(searchCacheFile);
    const entry = lookup(cache, "skills.sh", query);
    if (entry === undefined) return undefined;
    // payload 是我们自己写进去的（形状见 rememberSearch）；这里只兜「文件被手改坏」的情况
    const payload = isRecord(entry.payload) ? entry.payload : undefined;
    const results = payload !== undefined && Array.isArray(payload.results) ? payload.results : undefined;
    if (results === undefined) return undefined;
    return { results: results as SearchResultItem[], provenance: { route: "cache", at: entry.at } };
  }

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

  routes["POST skills/sources/register"] = async (req) => {
    const body = recordOrEmpty(req.body);
    const skillId = requireInput(body, "skillId", "技能 ID");
    const repoRaw = requireInput(body, "repo", "仓库");
    const ref = optionalInput(body, "ref");
    const skillPath = optionalInput(body, "skillPath");
    const workspace = optionalInput(body, "workspace");
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
    const body = recordOrEmpty(req.body);
    const skillId = requireInput(body, "skillId", "技能 ID");
    const workspace = optionalInput(body, "workspace");
    await unregisterSource({ skills, sources }, { skillId, workspace });
    return {};
  };

  routes["POST skills/updates/check"] = async (req) => {
    const body = recordOrEmpty(req.body);
    const ids = optionalInputList(body, "ids");
    const workspace = optionalInput(body, "workspace");
    return await checkUpdates({ github, skills, sources, fingerprints, logger: ctx.logger, now }, { ids, workspace });
  };

  routes["POST skills/updates/apply"] = async (req) => {
    const body = recordOrEmpty(req.body);
    const ids = optionalInputList(body, "ids");
    if (ids === undefined || ids.length === 0) throw badRequest("请至少选择一个要更新的技能。");
    const workspace = optionalInput(body, "workspace");
    return await applyUpdates({ github, skills, sources, fingerprints, logger: ctx.logger, now }, { ids, workspace });
  };

  /* ---------- GitHub 镜像设置（D-B18） ---------- */

  routes["GET skills/settings"] = async (): Promise<SkillsRemoteSettings> => await readSettings(ctx);

  routes["POST skills/settings"] = async (req): Promise<SkillsRemoteSettings> => {
    const body = recordOrEmpty(req.body);
    // 空串 = 清除镜像；非空必须是 https:// 开头且能被 URL 解析（非法 → VALIDATION 中文报错）
    const raw = body["githubMirror"];
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      throw validation("参数 githubMirror 必须是字符串。", [{ path: "githubMirror", message: "必须是字符串" }]);
    }
    const mirror = assertMirrorInput(typeof raw === "string" ? raw : "");
    // 即时生效：不必重建客户端
    github.setMirror(mirror);
    // **先保存**：探测只是「顺带」，任何探测失败都不影响保存成功（D-B19）
    const saved = await writeSettings(ctx, mirror === undefined ? {} : { mirror });
    if (mirror === undefined) return saved;
    try {
      const [direct, mirrorCapabilities] = await Promise.all([
        github.probeDirectStatus(),
        github.probeMirrorCapabilities(mirror),
      ]);
      // 探测结果写回设置（设置页下次打开就能看到「上次探测于 X」）
      return await writeSettings(ctx, { mirror, mirrorCapabilities, directStatus: direct });
    } catch (error) {
      ctx.logger.warn("保存镜像后探测失败（设置已保存）", (error as Error).message);
      return saved;
    }
  };

  routes["POST skills/settings/test-mirror"] = async (req): Promise<MirrorTestResult> => {
    const body = recordOrEmpty(req.body);
    const raw = body["githubMirror"];
    if (raw !== undefined && raw !== null && typeof raw !== "string") {
      throw validation("参数 githubMirror 必须是字符串。", [{ path: "githubMirror", message: "必须是字符串" }]);
    }
    // 不保存设置；地址不合法或为空时给 ok:false + 中文原因 —— **不抛错**（自检是「试一下」，
    // 不是「保存」，用户点一下就该看到红字而不是一个错误弹窗）。
    const normalized = normalizeMirror(typeof raw === "string" ? raw : "");
    if ("error" in normalized) return { ok: false, message: normalized.error };
    if (normalized.mirror === undefined) {
      return { ok: false, message: "镜像地址是空的，请先填写（例如 https://ghfast.top/）。" };
    }
    // 三件事互不依赖，并发做：
    //   test       —— 经镜像取小文件（ok / ms / message，ok 仍表示「下载可用」）
    //   direct     —— 直连 api.github.com 的状态（镜像坏不代表直连坏）
    //   mirror     —— 镜像能力：下载 / API 各一项
    const [test, direct, mirror] = await Promise.all([
      github.testMirror(normalized.mirror),
      github.probeDirectStatus(),
      github.probeMirrorCapabilities(normalized.mirror),
    ]);
    return { ...test, direct, mirror };
  };

  routes["GET skills/repos"] = async () => ({ repos: await catalog.list() });

  routes["POST skills/repos/add"] = async (req) => {
    const body = recordOrEmpty(req.body);
    const repoRaw = requireInput(body, "repo", "仓库");
    const ref = optionalInput(body, "ref");
    const subPath = optionalInput(body, "subPath");
    const workspace = optionalInput(body, "workspace");
    const resolved = resolveRepoInput(repoRaw, ref);
    return await catalog.add(
      { repo: resolved.repo, ref: resolved.ref, subPath: subPath ?? resolved.subPath },
      { workspace, signal: req.signal },
    );
  };

  routes["POST skills/repos/update"] = async (req) => {
    const body = recordOrEmpty(req.body);
    const repoRaw = requireInput(body, "repo", "仓库");
    const ref = patchInput(body, "ref");
    const subPath = patchInput(body, "subPath");
    const workspace = optionalInput(body, "workspace");
    if (ref === undefined && subPath === undefined) throw badRequest("请至少修改分支或子目录中的一项。");
    const resolved = resolveRepoInput(repoRaw);
    const patch: { ref?: string; subPath?: string } = {};
    if (ref !== undefined) patch.ref = ref;
    if (subPath !== undefined) patch.subPath = subPath;
    return await catalog.update(resolved.repo, patch, { workspace, signal: req.signal });
  };

  routes["POST skills/repos/remove"] = async (req) => {
    const body = recordOrEmpty(req.body);
    const repoRaw = requireInput(body, "repo", "仓库");
    const workspace = optionalInput(body, "workspace");
    const resolved = resolveRepoInput(repoRaw);
    return await catalog.remove(resolved.repo, { workspace });
  };

  routes["GET skills/discovery"] = async (req) => {
    const workspace = req.query["workspace"];
    return await catalog.view(workspace);
  };

  routes["POST skills/discovery/refresh"] = async (req) => {
    const body = recordOrEmpty(req.body);
    const only = optionalInputList(body, "repos");
    const workspace = optionalInput(body, "workspace");
    return await catalog.refresh({ repos: only, workspace, signal: req.signal });
  };

  routes["POST skills/repo/browse"] = async (req) => {
    const body = recordOrEmpty(req.body);
    const repoRaw = requireInput(body, "repo", "仓库");
    const ref = optionalInput(body, "ref");
    const workspace = optionalInput(body, "workspace");
    const resolved = resolveRepoInput(repoRaw, ref);
    return await browseRepo(
      { github, skills, meta },
      { repo: resolved.repo, ref: resolved.ref, subPath: resolved.subPath, workspace, signal: req.signal },
    );
  };

  routes["GET skills/search"] = async (req): Promise<SearchResponse> => {
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
    let payload: unknown;
    try {
      payload = await github.searchSkillsSh(q, limit, 0);
    } catch (error) {
      // D-B19：网络问题不该直接摆到界面上——同一关键词有缓存就先给缓存（标注缓存时刻）
      const fallback = isCacheableSearchFailure(error) ? await cachedSearch(q) : undefined;
      if (fallback === undefined) throw error;
      ctx.logger.warn(
        "skills-remote: 搜索「" +
          q +
          "」失败，改用 " +
          (fallback.provenance?.at ?? "上次") +
          " 的缓存结果（" +
          fallback.results.length +
          " 条）：" +
          errorText(error),
      );
      return fallback;
    }
    // 已知来源里能找到同名技能时，顺手补上 skillPath（便于 UI 直接跳安装）
    const known = new Map(
      (await sources.list()).map((entry) => [
        `${entry.repo.toLowerCase()}|${entry.skillId.toLowerCase()}`,
        entry.skillPath,
      ]),
    );
    const results: SearchResultItem[] = normalizeSkillsShResponse(payload, {
      skillPathLookup: (repo, skillId) => known.get(`${repo.toLowerCase()}|${skillId.toLowerCase()}`),
    });
    const at = (now?.() ?? new Date()).toISOString();
    await rememberSearch(q, results, at);
    return { results, provenance: { route: "direct", at } };
  };

  routes["POST skills/install"] = async (req) => {
    const body = recordOrEmpty(req.body);
    const repoRaw = requireInput(body, "repo", "仓库");
    const ref = optionalInput(body, "ref");
    const targetRaw = requireInput(body, "target", "安装目标");
    const workspace = optionalInput(body, "workspace");
    const skillPaths = optionalInputList(body, "skillPaths");
    if (skillPaths === undefined || skillPaths.length === 0) throw badRequest("请至少选择一个要安装的技能。");
    const resolved = resolveRepoInput(repoRaw, ref);
    const target: InstallTarget = assertInstallTarget(targetRaw);
    const results = await installSkills(
      { ctx, github, skills, sources, meta, fingerprints, now },
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
