/**
 * 汇总发现（D-B16）：把仓库列表里所有仓库的技能汇总成一张可安装清单，结果缓存在
 * <hubHome>/skills/discovery.json。
 *
 *   - 读（GET skills/discovery）只读缓存、不联网；「是否已安装」每次按本机技能列表现算，不进缓存；
 *   - 刷新（POST skills/discovery/refresh）才联网，逐仓库独立成败，失败原因（已打码）记在该仓库条目上；
 *   - 增删改仓库只动该仓库的条目（规则在 repo-catalog.ts，它是仓库列表与发现的唯一入口）。
 *
 * 缓存写入是「读 - 合并 - 写」，同一进程内用一条 Promise 链串行化，避免并发刷新互相覆盖。
 */

import path from "node:path";
import { readJsonFile, writeJsonFile } from "./fsx.ts";
import { notFound } from "../../shared/errors.ts";
import { installedIdOf, loadInstalledIndex, scanRepoSkills } from "./browse.ts";
import type { GitHubClient } from "./github.ts";
import type { Redactor } from "./redact.ts";
import type { RepoStore } from "./repos.ts";
import type { SkillMetaReader } from "./skill-meta.ts";
import type { DiscoveryCacheEntry, DiscoveryCacheFile, SkillsLocalPort } from "./types.ts";
import type { DiscoveredSkill, DiscoveryRepoView, DiscoveryView, RepoRecord } from "../contract/remote.ts";
import type { HubContext } from "../../platform/contract/host.ts";
import { errorText } from "../../shared/error-text.ts";

const DISCOVERY_VERSION = 1;
/** 同时扫描的仓库数上限（每个仓库要下载一次 tarball） */
export const DISCOVERY_CONCURRENCY = 2;

export function discoveryFilePath(ctx: HubContext): string {
  return path.join(ctx.hubHome, "skills", "discovery.json");
}

const keyOf = (repo: string): string => repo.toLowerCase();

export interface DiscoveryStore {
  read(): Promise<DiscoveryCacheFile>;
  /** 串行化的「读 - 改 - 写」 */
  mutate(change: (file: DiscoveryCacheFile) => void): Promise<DiscoveryCacheFile>;
}

export function createDiscoveryStore(ctx: HubContext): DiscoveryStore {
  let chain: Promise<unknown> = Promise.resolve();

  async function read(): Promise<DiscoveryCacheFile> {
    const raw = await readJsonFile<DiscoveryCacheFile>(discoveryFilePath(ctx));
    if (!raw || typeof raw.repos !== "object" || raw.repos === null || Array.isArray(raw.repos)) {
      return { version: DISCOVERY_VERSION, repos: {} };
    }
    const repos: Record<string, DiscoveryCacheEntry> = {};
    for (const [key, entry] of Object.entries(raw.repos)) {
      if (!entry || typeof entry.repo !== "string" || typeof entry.scannedAt !== "string") continue;
      repos[key] = {
        ...entry,
        skills: Array.isArray(entry.skills)
          ? entry.skills.filter((s) => s && typeof s.skillPath === "string" && typeof s.dirName === "string")
          : [],
      };
    }
    return { version: DISCOVERY_VERSION, repos };
  }

  return {
    read,
    mutate(change) {
      const next = chain.then(async () => {
        const file = await read();
        change(file);
        await writeJsonFile(discoveryFilePath(ctx), { ...file, version: DISCOVERY_VERSION });
        return file;
      });
      chain = next.catch(() => undefined);
      return next;
    },
  };
}

/** 缓存条目是否按仓库当前的分支 / 子目录扫的 */
export function isStale(entry: DiscoveryCacheEntry, record: RepoRecord): boolean {
  return (entry.ref ?? "") !== (record.ref ?? "") || (entry.subPath ?? "") !== (record.subPath ?? "");
}

/**
 * 把仓库列表 + 缓存 + 本机已安装索引合成视图（纯函数，便于测试）。
 * 仓库列表里没有的缓存条目不出现；从未扫描过的仓库只有配置、没有 scannedAt。
 */
export function composeDiscoveryView(
  records: readonly RepoRecord[],
  cache: DiscoveryCacheFile,
  installedOf: (skill: DiscoveredSkill) => string | undefined,
): DiscoveryView {
  const repos: DiscoveryRepoView[] = [];
  const skills: DiscoveredSkill[] = [];
  let lastScannedAt: string | undefined;
  let anyScanned = false;
  for (const record of records) {
    const view: DiscoveryRepoView = { repo: record.repo, preset: record.preset };
    if (record.ref !== undefined) view.ref = record.ref;
    if (record.subPath !== undefined) view.subPath = record.subPath;
    const entry = cache.repos[keyOf(record.repo)];
    if (entry !== undefined) {
      anyScanned = true;
      view.scannedAt = entry.scannedAt;
      if (entry.resolvedRef !== undefined) view.resolvedRef = entry.resolvedRef;
      if (entry.error !== undefined) view.error = entry.error;
      else view.skillCount = entry.skills.length;
      if (isStale(entry, record)) view.stale = true;
      if (lastScannedAt === undefined || entry.scannedAt > lastScannedAt) lastScannedAt = entry.scannedAt;
      for (const skill of entry.skills) {
        const item: DiscoveredSkill = { ...skill, repo: record.repo };
        const ref = entry.resolvedRef ?? entry.ref;
        if (ref !== undefined) item.ref = ref;
        const installed = installedOf(item);
        if (installed !== undefined) item.installedId = installed;
        skills.push(item);
      }
    }
    repos.push(view);
  }
  const out: DiscoveryView = { cached: anyScanned, repos, skills };
  if (lastScannedAt !== undefined) out.lastScannedAt = lastScannedAt;
  return out;
}

export interface DiscoveryDeps {
  github: GitHubClient;
  skills: SkillsLocalPort;
  repos: RepoStore;
  store: DiscoveryStore;
  redactor: Redactor;
  /** 读 SKILL.md 的 name / description（DSH 同一个 yaml 库） */
  meta: SkillMetaReader;
  now?: () => Date;
}

/** 只读视图（不联网） */
export async function readDiscovery(
  deps: Pick<DiscoveryDeps, "skills" | "repos" | "store">,
  options: { workspace?: string } = {},
): Promise<DiscoveryView> {
  const [records, cache, index] = await Promise.all([
    deps.repos.list(),
    deps.store.read(),
    loadInstalledIndex(deps.skills, options.workspace),
  ]);
  return composeDiscoveryView(records, cache, (skill) => installedIdOf(skill, index));
}

/** 扫一个仓库，成功失败都变成一条缓存条目（不抛错，取消除外） */
export async function scanOne(
  deps: Pick<DiscoveryDeps, "github" | "redactor" | "meta" | "now">,
  record: RepoRecord,
  signal?: AbortSignal,
): Promise<DiscoveryCacheEntry> {
  const scannedAt = (deps.now?.() ?? new Date()).toISOString();
  const base: DiscoveryCacheEntry = { repo: record.repo, scannedAt, skills: [] };
  if (record.ref !== undefined) base.ref = record.ref;
  if (record.subPath !== undefined) base.subPath = record.subPath;
  try {
    const scanned = await scanRepoSkills(deps.github, deps.meta, {
      repo: record.repo,
      ref: record.ref,
      subPath: record.subPath,
      signal,
    });
    return { ...base, resolvedRef: scanned.ref, skills: scanned.skills };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...base, error: deps.redactor.scrub(errorText(error)) };
  }
}

/** 并发上限内依次跑完 */
async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      out[index] = await run(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

/**
 * 联网刷新：不给 repos = 仓库列表里的全部；给了就只扫这些（必须在列表里，否则 NOT_FOUND）。
 * 逐仓库独立成败；写回缓存时顺带清掉已经不在仓库列表里的条目。
 */
export async function refreshDiscovery(
  deps: DiscoveryDeps,
  options: { repos?: string[]; workspace?: string; signal?: AbortSignal } = {},
): Promise<DiscoveryView> {
  const records = await deps.repos.list();
  let targets = records;
  if (options.repos !== undefined && options.repos.length > 0) {
    const byKey = new Map(records.map((r) => [keyOf(r.repo), r]));
    targets = options.repos.map((repo) => {
      const found = byKey.get(keyOf(repo.trim()));
      if (found === undefined) throw notFound(`仓库 ${repo.trim()} 不在仓库列表中。`);
      return found;
    });
  }
  const entries = await mapLimited(targets, DISCOVERY_CONCURRENCY, (record) => scanOne(deps, record, options.signal));
  const listed = new Set(records.map((r) => keyOf(r.repo)));
  await deps.store.mutate((file) => {
    for (const entry of entries) file.repos[keyOf(entry.repo)] = entry;
    for (const key of Object.keys(file.repos)) if (!listed.has(key)) delete file.repos[key];
  });
  return readDiscovery(deps, { workspace: options.workspace });
}

/** 仓库被移出列表：删掉它的缓存条目 */
export async function forgetDiscovery(store: DiscoveryStore, repo: string): Promise<void> {
  await store.mutate((file) => {
    delete file.repos[keyOf(repo)];
  });
}
