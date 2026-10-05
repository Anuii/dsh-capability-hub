/**
 * 来源存储（D-B7 / F6-Q3 兼容规则）。
 *
 * 两种 store：
 *   - user-agents 根的技能 → <homeDir>/.agents/.skill-lock.json（npx skills v3 的 lock）
 *   - 其他根 → <hubHome>/skills/sources.json（插件自己的文件）
 *
 * 兼容规则（逐条对应 F6-Q3.6）：
 *   1. version 保持原值（本机为 3）；缺失时才写 3。绝不写 <3（CLI 会清空整个 lock）。
 *   2. 读-改-写：保留所有其他条目与未知顶层字段（dismissed / lastSelectedAgents / 未来字段）。
 *   3. 未知条目字段原样保留（pluginName / sourceBaseUrl / wellKnownDigest / 未来字段）。
 *   4. installedAt 在更新时保持不变，updatedAt 用新的 ISO 字符串。
 *   5. 原子写（同目录 tmp + rename）。
 *
 * LockStash 的 take/put 也在这里实现（skills-local 删除/恢复技能时挂接）。
 */

import path from "node:path";
import { pathExists, readJsonFile, writeJsonFile } from "./fsx.ts";
import { hashLocalDirectory, recordedHash } from "./hash.ts";
import { internal } from "../../shared/errors.ts";
import { repoRelativeSkillPath, skillMdPathOf } from "./sourceurl.ts";
import { sanitizeName } from "./rootskill.ts";
import {
  LOCK_BACKED_ROOT,
  type HubStoreEntry,
  type HubStoreFile,
  type SkillLockEntry,
  type SkillLockFile,
} from "./types.ts";
import type { HubContext } from "../../platform/contract/host.ts";
import type { LockStash } from "../contract/local.ts";
import type { SourceEntry } from "../contract/remote.ts";

const LOCK_VERSION = 3;
const SOURCES_VERSION = 1;

export interface SkillLocation {
  rootId: string;
  dirName: string;
  /** 技能目录绝对路径 */
  path: string;
}

export function lockFilePath(ctx: HubContext): string {
  return path.join(ctx.homeDir, ".agents", ".skill-lock.json");
}

export function sourcesFilePath(ctx: HubContext): string {
  return path.join(ctx.hubHome, "skills", "sources.json");
}

export function useSkillLock(rootId: string): boolean {
  return rootId === LOCK_BACKED_ROOT;
}

function emptyLock(): SkillLockFile {
  return { version: LOCK_VERSION, skills: {}, dismissed: {} };
}

function readLockShape(raw: SkillLockFile | undefined): SkillLockFile {
  if (!raw || typeof raw !== "object") return emptyLock();
  const lock = raw as SkillLockFile;
  if (typeof lock.version !== "number" || !lock.skills || typeof lock.skills !== "object") return emptyLock();
  // 与 npx skills 一致：version < 3 视为旧格式。但我们不主动清空用户的锁 ——
  // 只在写回时保持原 version，读到的旧数据照常展示。
  return lock;
}

/** 读取原始 lock（保留全部未知字段，供写回时原样使用）。 */
export async function readSkillLockRaw(ctx: HubContext): Promise<SkillLockFile> {
  return readLockShape(await readJsonFile<SkillLockFile>(lockFilePath(ctx)));
}

export async function writeSkillLockRaw(ctx: HubContext, lock: SkillLockFile): Promise<void> {
  const next: SkillLockFile = { ...lock };
  if (typeof next.version !== "number") next.version = LOCK_VERSION;
  if (!next.skills || typeof next.skills !== "object") next.skills = {};
  await writeJsonFile(lockFilePath(ctx), next);
}

export type HubSourcesFile = HubStoreFile;

export async function readSourcesRaw(ctx: HubContext): Promise<HubSourcesFile> {
  const raw = await readJsonFile<HubSourcesFile>(sourcesFilePath(ctx));
  if (!raw || typeof raw !== "object") return { version: SOURCES_VERSION, entries: {} };
  return {
    ...raw,
    version: typeof raw.version === "number" ? raw.version : SOURCES_VERSION,
    entries: raw.entries && typeof raw.entries === "object" ? raw.entries : {},
  };
}

export async function writeSourcesRaw(ctx: HubContext, file: HubSourcesFile): Promise<void> {
  const next: HubSourcesFile = { ...file };
  if (typeof next.version !== "number") next.version = SOURCES_VERSION;
  if (!next.entries || typeof next.entries !== "object") next.entries = {};
  await writeJsonFile(sourcesFilePath(ctx), next);
}

/** hubHome/skills/sources.json 的键：<rootId>/<dirName> */
export function sourcesKey(location: SkillLocation): string {
  return `${location.rootId}/${location.dirName}`;
}

/* ---------- 统一读视图 ---------- */

export interface SourceRecord {
  entry: SourceEntry;
  /** skill-lock store 下：lock 条目的键（= 技能名） */
  lockName?: string;
  /** 记录在 lock 中是否存在 */
  present: boolean;
}

/**
 * 读侧归一：来源记录里的 skillPath 必须是「仓库内相对路径」。
 *
 * FIX-6（D-2）：历史缺陷会把**本机绝对路径**写进 lock（discover 把本地技能目录
 * 传给了 skillMdPathOf）。这里统一过一遍上面的判据，修不好（缺失 / 绝对路径 /
 * 盘符 / 反斜杠）就退回 `<目录名>/SKILL.md` —— updates 会按目录名在上游唯一匹配，
 * 因此这个退回值比原来的「本机路径」可用得多。
 */
function storedSkillPath(raw: string | undefined, dirName: string): string {
  return repoRelativeSkillPath(raw) ?? skillMdPathOf(dirName);
}

/**
 * lock 条目 → 对外来源条目。
 *
 * **目录名 = lock 键**（FIX-6 / D-1 实测结论，npx skills 包 1.7.0 dist/cli.mjs）：
 *   - 写侧：`addSkillToLock(skill.name, { …, skillPath })` —— 键是技能名（frontmatter name）；
 *   - 装侧：`getInstallPath()` 装到 `<skills 根>/sanitizeName(skillName)` —— 目录名就是技能名；
 *   - skillPath：`skillFiles[skill.name] = "SKILL.md"`（技能就在仓库根）或
 *     `<仓库内相对目录>/SKILL.md` —— 它只表示**技能在仓库里的位置**，与本地目录名无关。
 *   本机实测：31 个技能目录名 == frontmatter name == lock 键（6/6 条 lock 条目同名）。
 *
 * 对外契约（PLAN §3.2/§3.4）里所有模块与 UI 都用 "<rootId>:<dirName>" 关联，所以
 * skillId 一律由 lock 键派生。旧实现从 skillPath 的倒数第二段取目录名，根级技能
 * （skillPath === "SKILL.md"）于是派生出 "user-agents:SKILL.md" —— 本条即修这个。
 *
 * **FIX-7 修订（调度者裁定）**：CLI 的 lock 键是**原始技能名**，而安装目录名是
 * `sanitizeName(键)` —— 名字需要清洗时两者不同。因此派生规则细化为
 * `dirName = sanitizeName(lock 键)`（而不是「dirName 直接等于键」）：
 * 名字本来就干净时（本机 31/31）结果与 FIX-6 完全一致；需要清洗时派生值等于真实目录名，
 * `GET skills/sources` 的 orphan 判定与 UI 关联仍然正确。反查（findLockKey）用同一条规则。
 */
export function lockEntryToSourceEntry(lockName: string, entry: SkillLockEntry): SourceEntry {
  const dirName = sanitizeName(lockName);
  const result: SourceEntry = {
    skillId: `user-agents:${dirName}`,
    repo: entry.source,
    skillPath: storedSkillPath(entry.skillPath, dirName),
    store: "skill-lock",
  };
  if (entry.ref !== undefined) result.ref = entry.ref;
  if (entry.installedAt !== undefined) result.installedAt = entry.installedAt;
  if (entry.updatedAt !== undefined) result.updatedAt = entry.updatedAt;
  if (entry.skillFolderHash !== undefined) result.skillFolderHash = entry.skillFolderHash;
  return result;
}

export function hubEntryToSourceEntry(entry: HubStoreEntry): SourceEntry {
  const dirName =
    typeof entry.dirName === "string" && entry.dirName !== ""
      ? entry.dirName
      : entry.skillId.split(":").slice(1).join(":");
  const result: SourceEntry = {
    skillId: entry.skillId,
    repo: entry.repo,
    skillPath: storedSkillPath(entry.skillPath, dirName),
    store: "hub",
  };
  if (entry.ref !== undefined) result.ref = entry.ref;
  if (entry.installedAt !== undefined) result.installedAt = entry.installedAt;
  if (entry.updatedAt !== undefined) result.updatedAt = entry.updatedAt;
  if (entry.skillFolderHash !== undefined) result.skillFolderHash = entry.skillFolderHash;
  return result;
}

export interface SourceStore {
  ctx: HubContext;
  /** 列出全部来源条目（lock + hub） */
  list(): Promise<SourceEntry[]>;
  /** 按技能位置读一条 */
  get(location: SkillLocation, skillName?: string): Promise<SourceRecord | undefined>;
  /** 写入/覆盖一条来源（lock 或 hub，取决于 rootId） */
  upsert(location: SkillLocation, entry: SourceEntry, skillName?: string): Promise<SourceEntry>;
  /** 删除一条来源；返回是否真的删掉了 */
  remove(location: SkillLocation, skillName?: string): Promise<boolean>;
  /** src/skills/remote/lockstore.ts 的 LockStash 视图 */
  stash: LockStash;
}

/**
 * lock 条目的键：npx skills 用「技能名」（= frontmatter name）。
 * 我们按 F4 实测事实（31/31 name == 目录名）优先用技能名，回退目录名，
 * 保证「删除 → 收起条目 → 恢复 → 放回同键」的往返一致。
 */
function resolveLockName(skillName: string | undefined, dirName: string): string {
  const trimmed = skillName?.trim();
  return trimmed && trimmed !== "" ? trimmed : dirName;
}

/** skillPath 的父目录名（小写）；根级 "SKILL.md" 没有父目录 → undefined */
function parentDirOfSkillPath(skillPath: unknown): string | undefined {
  if (typeof skillPath !== "string") return undefined;
  const normalized = repoRelativeSkillPath(skillPath);
  if (normalized === undefined) return undefined;
  const segments = normalized.split("/").filter((s) => s !== "");
  return segments.length >= 2 ? segments[segments.length - 2]!.toLowerCase() : undefined;
}

/**
 * 反查：本地技能目录 ↔ lock 键（FIX-6 / D-1：注册与反查必须用同一套规则）。
 *   ① 技能名同键（npx skills 的键就是技能名，写侧就是按它落的）；
 *   ② **sanitizeName(键) 与目录名忽略大小写相同**（FIX-7 修订：CLI 的键是原始技能名，
 *      目录名是 sanitizeName(键)，所以不能直接拿键与目录名比；名字干净时与旧的「键 == 目录名」等价）；
 *   ③ 历史数据兜底：skillPath 的父目录名相同 —— 唯一命中才算，避免误伤。
 * 找不到返回 undefined（调用方按「没有来源记录」处理）。
 * 两个键清洗后同名时取第一个命中（真实 lock 里不会出现，且总比找不到好）。
 */
function findLockKey(lock: SkillLockFile, names: (string | undefined)[], dirName: string): string | undefined {
  for (const raw of names) {
    const name = raw?.trim();
    if (name !== undefined && name !== "" && Object.prototype.hasOwnProperty.call(lock.skills, name)) return name;
  }
  const keys = Object.keys(lock.skills);
  const lower = (dirName ?? "").trim().toLowerCase();
  if (lower !== "") {
    const byKey = keys.find((k) => sanitizeName(k).toLowerCase() === lower);
    if (byKey !== undefined) return byKey;
  }
  const viaPath = keys.filter((k) => parentDirOfSkillPath(lock.skills[k]?.skillPath) === lower);
  return viaPath.length === 1 ? viaPath[0] : undefined;
}

export function createSourceStore(ctx: HubContext): SourceStore {
  const logger = ctx.logger;

  async function readLock(): Promise<SkillLockFile> {
    return readSkillLockRaw(ctx);
  }

  async function get(location: SkillLocation, skillName?: string): Promise<SourceRecord | undefined> {
    if (useSkillLock(location.rootId)) {
      const lock = await readLock();
      const key = findLockKey(lock, [skillName, location.dirName], location.dirName);
      if (key === undefined) return undefined;
      const entry = lock.skills[key];
      if (!entry) return undefined;
      return { entry: lockEntryToSourceEntry(key, entry), lockName: key, present: true };
    }
    const file = await readSourcesRaw(ctx);
    const stored = file.entries[sourcesKey(location)];
    if (!stored) return undefined;
    return { entry: hubEntryToSourceEntry(stored), present: true };
  }

  async function list(): Promise<SourceEntry[]> {
    const out: SourceEntry[] = [];
    const lock = await readLock();
    for (const [name, entry] of Object.entries(lock.skills)) {
      if (!entry || typeof entry !== "object") continue;
      out.push(lockEntryToSourceEntry(name, entry));
    }
    const hub = await readSourcesRaw(ctx);
    for (const entry of Object.values(hub.entries)) {
      if (!entry || typeof entry !== "object") continue;
      out.push(hubEntryToSourceEntry(entry));
    }
    out.sort((a, b) => a.skillId.localeCompare(b.skillId));
    return out;
  }

  async function upsert(location: SkillLocation, entry: SourceEntry, skillName?: string): Promise<SourceEntry> {
    const nowIso = new Date().toISOString();
    if (useSkillLock(location.rootId)) {
      const lock = await readLock();
      // 已有条目按同一套反查规则复用（否则「技能名与目录名不同」时会写出一条重复记录）
      const key = findLockKey(lock, [skillName], location.dirName) ?? resolveLockName(skillName, location.dirName);
      const existing = lock.skills[key];
      const writePath = entry.skillPath === "" ? "" : storedSkillPath(entry.skillPath, location.dirName);
      const next: SkillLockEntry = {
        ...(existing ?? {}),
        source: entry.repo,
        sourceType: typeof existing?.sourceType === "string" ? existing.sourceType : "github",
        sourceUrl: `https://github.com/${entry.repo}.git`,
        skillPath: writePath,
        skillFolderHash: entry.skillFolderHash ?? "",
        installedAt: existing?.installedAt ?? entry.installedAt ?? nowIso,
        updatedAt: entry.updatedAt ?? nowIso,
      };
      // sourceUrl 若已有则保留原样（用户可能是 fork 或用了别的协议）
      if (typeof existing?.sourceUrl === "string" && existing.sourceUrl !== "") next.sourceUrl = existing.sourceUrl;
      if (entry.ref !== undefined) next.ref = entry.ref;
      if (entry.skillFolderHash === undefined) delete next.skillFolderHash;
      if (writePath === "") delete next.skillPath;
      lock.skills[key] = next;
      await writeSkillLockRaw(ctx, lock);
      logger.info(`已写入技能来源（skill-lock）：${key} ← ${entry.repo}`);
      return lockEntryToSourceEntry(key, next);
    }

    const file = await readSourcesRaw(ctx);
    const key = sourcesKey(location);
    const existing = file.entries[key];
    const stored: HubStoreEntry = {
      ...(existing ?? {}),
      skillId: entry.skillId,
      rootId: location.rootId,
      dirName: location.dirName,
      repo: entry.repo,
      skillPath: entry.skillPath === "" ? "" : storedSkillPath(entry.skillPath, location.dirName),
      installedAt: existing?.installedAt ?? entry.installedAt ?? nowIso,
      updatedAt: entry.updatedAt ?? nowIso,
    };
    if (entry.ref !== undefined) stored.ref = entry.ref;
    else delete stored.ref;
    if (entry.skillFolderHash !== undefined) stored.skillFolderHash = entry.skillFolderHash;
    else delete stored.skillFolderHash;
    file.entries[key] = stored;
    await writeSourcesRaw(ctx, file);
    logger.info(`已写入技能来源（sources.json）：${key} ← ${entry.repo}`);
    return hubEntryToSourceEntry(stored);
  }

  async function remove(location: SkillLocation, skillName?: string): Promise<boolean> {
    if (useSkillLock(location.rootId)) {
      const lock = await readLock();
      const key = findLockKey(lock, [skillName, location.dirName], location.dirName);
      if (key === undefined) return false;
      delete lock.skills[key];
      await writeSkillLockRaw(ctx, lock);
      return true;
    }
    const file = await readSourcesRaw(ctx);
    const key = sourcesKey(location);
    if (!Object.prototype.hasOwnProperty.call(file.entries, key)) return false;
    delete file.entries[key];
    await writeSourcesRaw(ctx, file);
    return true;
  }

  const stash: LockStash = {
    async take(skill: { rootId: string; dirName: string; path: string }): Promise<unknown | undefined> {
      // take 只针对 lock-backed 根（npx skills 的 lock 是全局的，其他根本来就在我们自己的文件里）
      if (!useSkillLock(skill.rootId)) return undefined;
      const lockPath = lockFilePath(ctx);
      if (!(await pathExists(lockPath))) return undefined;
      const lock = await readLock();
      // 与 get / upsert 共用同一套反查规则（D-1：注册与反查必须一致）
      const key = findLockKey(lock, [skill.dirName], skill.dirName);
      if (key === undefined) return undefined;
      const entry = lock.skills[key];
      delete lock.skills[key];
      await writeSkillLockRaw(ctx, lock);
      return entry;
    },
    async put(skill: { rootId: string; dirName: string; path: string }, entry: unknown): Promise<void> {
      if (!useSkillLock(skill.rootId)) return;
      if (!entry || typeof entry !== "object") return;
      const lock = await readLock();
      // 键用目录名（= sanitizeName(原键)）：派生出的 skillId 与 take 之前完全一致，
      // 因此「删除 → 收起 → 恢复 → 放回」在 sanitizeName 前后往返仍然自洽。
      const key = resolveLockName(undefined, skill.dirName);
      lock.skills[key] = entry as SkillLockEntry;
      await writeSkillLockRaw(ctx, lock);
    },
  };

  return { ctx, list, get, upsert, remove, stash };
}

/** 计算「本地目录当前哈希」（登记来源时用，与 npx skills 语义一致）。 */
export async function localFolderHash(dir: string): Promise<string> {
  if (!(await pathExists(dir))) throw internal(`技能目录不存在：${dir}`);
  return recordedHash(await hashLocalDirectory(dir));
}
