/**
 * 测试公共夹具：临时目录、假 HubContext、假 SkillsLocalApi、假 fetch。
 * 所有落盘都发生在 os.tmpdir() 下自建的临时目录里，绝不碰真实用户目录（PLAN §4.1 / C5）。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { hashLocalDirectory, hashTarDirectory, recordedHash } from '../../src/host/skills-remote/hash.ts';
import { readTarEntries } from '../../src/host/skills-remote/tar.ts';
import type { HubContext, HubLogger, SkillSummary, TrashItem, ListResult, RootId, RootInfo, SkillsLocalApi } from '../../src/host/skills-remote/types.ts';
import { repoArchive, type FixtureEntry } from './tarfixture.ts';

/* ---------- 临时目录 ---------- */

export function makeTempDir(prefix = 'cap-hub-t2-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function writeTree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

export async function readTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function visit(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), rel);
      else if (entry.isFile()) out[rel] = await fs.readFile(path.join(dir, entry.name), 'utf8');
    }
  }
  await visit(root, '');
  return out;
}

/* ---------- 日志 ---------- */

export interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  args: unknown[];
}

export function makeLogger(sink: LogRecord[] = []): { logger: HubLogger; sink: LogRecord[] } {
  const push =
    (level: LogRecord['level']) =>
    (...args: unknown[]) => {
      sink.push({ level, args });
    };
  return { logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }, sink };
}

/* ---------- 假 SkillsLocalApi ---------- */

export interface FakeSkillInit {
  rootId?: string;
  dirName: string;
  path: string;
  name?: string;
  description?: string;
  writable?: boolean;
  modelInvocationDisabled?: boolean;
  loadable?: boolean;
}

export interface FakeApiOptions {
  roots?: RootInfo[];
  skills?: FakeSkillInit[];
  /** 回收站根目录（会自动创建）；默认放在系统临时目录下 */
  trashRoot?: string;
  /** moveToTrash 抛错（用于回滚测试）；只抛一次 */
  failMoveToTrashOnce?: boolean;
  /** setEnabled 抛错（用于回滚测试）；只抛一次 */
  failSetEnabledOnce?: boolean;
  failRestore?: boolean;
}

export interface FakeApi extends SkillsLocalApi {
  /** 调用顺序记录：用于断言「更新五步」的次序 */
  calls: string[];
  /** 当前假技能表（可被测试改动） */
  skills: FakeSkillInit[];
  trash: Map<string, { located: FakeSkillInit; lockEntry?: unknown; reason: string }>;
  setEnabledCalls: { id: string; enabled: boolean }[];
  moveToTrashCalls: { id: string; reason: string; lockEntry?: unknown }[];
  restoreCalls: { trashId: string; replace?: boolean }[];
  /** 回收站条目的磁盘位置（测试断言用） */
  trashDirOf(trashId: string): string;
}

function summaryOf(skill: FakeSkillInit): SkillSummary {
  return {
    id: `${skill.rootId ?? 'user-agents'}:${skill.dirName}`,
    rootId: skill.rootId ?? 'user-agents',
    dirName: skill.dirName,
    path: skill.path,
    name: skill.name,
    description: skill.description,
    writable: skill.writable ?? true,
    modelInvocationDisabled: skill.modelInvocationDisabled ?? false,
    userInvocable: null,
    loadable: skill.loadable ?? true,
    modelVisible: !(skill.modelInvocationDisabled ?? false),
    diagnostics: [],
    format: { eol: 'lf', bom: false, safeToToggle: true },
    extraKeys: [],
    mtimeMs: 0,
  };
}

export function makeFakeApi(options: FakeApiOptions = {}): FakeApi {
  const skills: FakeSkillInit[] = options.skills ?? [];
  const calls: string[] = [];
  // 真实 skills-local 是「扫描磁盘」的：目录被写回来就要重新出现。
  // 这里用 known + 磁盘存在性判断来模拟，保证更新流程（移入回收站 → 写入新目录 →
  // setEnabled）在假实现上也成立。
  const known = new Map<string, FakeSkillInit>();
  for (const skill of skills) known.set(`${skill.rootId ?? 'user-agents'}:${skill.dirName}`, skill);
  let setEnabledFailed = false;
  const trash = new Map<string, { located: FakeSkillInit; lockEntry?: unknown; reason: string }>();
  const setEnabledCalls: { id: string; enabled: boolean }[] = [];
  const moveToTrashCalls: { id: string; reason: string; lockEntry?: unknown }[] = [];
  const restoreCalls: { trashId: string; replace?: boolean }[] = [];
  let moveToTrashFailed = false;
  const trashRoot = options.trashRoot ?? path.join(path.dirname(skills[0]?.path ?? os.tmpdir()), '.fake-trash');
  /** 回收站里条目的磁盘位置（供测试断言） */
  const trashDirOf = (trashId: string): string => path.join(trashRoot, trashId);

  const roots: RootInfo[] = options.roots ?? [
    { rootId: 'user-agents', path: '', exists: true, writable: true, precedence: 500 },
    { rootId: 'user-dsh', path: '', exists: true, writable: true, precedence: 400 },
    { rootId: 'project-agents', path: '', exists: true, writable: true, precedence: 200 },
    { rootId: 'project-dsh', path: '', exists: true, writable: true, precedence: 100 },
  ];

  const idOf = (id: string): { rootId: string; dirName: string } => {
    const idx = id.indexOf(':');
    return idx === -1 ? { rootId: 'user-agents', dirName: id } : { rootId: id.slice(0, idx), dirName: id.slice(idx + 1) };
  };

  /** 磁盘上重新出现（例如更新流程写入新目录）→ 重新纳入清单 */
  const adoptFromDisk = async (): Promise<void> => {
    for (const [id, skill] of known) {
      if (skills.includes(skill)) continue;
      if (!existsSync(skill.path)) continue;
      if (!skills.some((s) => `${s.rootId ?? 'user-agents'}:${s.dirName}` === id)) skills.push(skill);
    }
  };

  const api: FakeApi = {
    calls,
    skills,
    trash,
    setEnabledCalls,
    moveToTrashCalls,
    restoreCalls,
    trashDirOf,
    async list(): Promise<ListResult> {
      calls.push('list');
      await adoptFromDisk();
      return { roots, skills: skills.map(summaryOf), warnings: [] };
    },
    async get(id: string): Promise<SkillSummary | undefined> {
      calls.push(`get(${id})`);
      await adoptFromDisk();
      const { rootId, dirName } = idOf(id);
      const found = skills.find((s) => (s.rootId ?? 'user-agents') === rootId && s.dirName === dirName);
      return found ? summaryOf(found) : undefined;
    },
    async setEnabled(id, enabled) {
      calls.push(`setEnabled(${id},${enabled})`);
      setEnabledCalls.push({ id, enabled });
      if (options.failSetEnabledOnce && !setEnabledFailed) {
        setEnabledFailed = true;
        throw new Error('假实现：改写 frontmatter 失败');
      }
      await adoptFromDisk();
      const { rootId, dirName } = idOf(id);
      const found = skills.find((s) => (s.rootId ?? 'user-agents') === rootId && s.dirName === dirName);
      if (!found) throw new Error(`假实现：找不到技能 ${id}`);
      found.modelInvocationDisabled = !enabled;
      return summaryOf(found);
    },
    async moveToTrash(id, opts) {
      calls.push(`moveToTrash(${id},${opts.reason})`);
      moveToTrashCalls.push({ id, reason: opts.reason, lockEntry: opts.lockEntry });
      if (options.failMoveToTrashOnce && !moveToTrashFailed) {
        moveToTrashFailed = true;
        throw new Error('假实现：回收站满');
      }
      const { rootId, dirName } = idOf(id);
      const index = skills.findIndex((s) => (s.rootId ?? 'user-agents') === rootId && s.dirName === dirName);
      if (index === -1) throw new Error(`假实现：找不到技能 ${id}`);
      const [located] = skills.splice(index, 1);
      known.set(id, located!);
      const trashId = `trash-${trash.size + 1}`;
      // 真实 skills-local 会把整个目录移进回收站 —— 假实现同样真的挪目录，
      // 这样「更新失败 → 从回收站拿回」的断言才有意义。
      const trashDir = path.join(trashRoot, trashId);
      await fs.mkdir(path.dirname(trashDir), { recursive: true });
      await fs.rename(located!.path, trashDir);
      trash.set(trashId, { located: located!, lockEntry: opts.lockEntry, reason: opts.reason });
      const item: TrashItem = {
        trashId,
        skillId: id,
        rootId,
        dirName,
        originalPath: located!.path,
        reason: opts.reason,
        deletedAt: new Date().toISOString(),
        hasLockEntry: opts.lockEntry !== undefined,
      };
      return item;
    },
    rootPath(rootId: string) {
      calls.push(`rootPath(${rootId})`);
      return roots.find((r) => r.rootId === rootId)?.path;
    },
    async restore(trashId, opts) {
      calls.push(`restore(${trashId})`);
      restoreCalls.push({ trashId, replace: opts?.replace });
      if (options.failRestore) throw new Error('假实现：恢复失败');
      const item = trash.get(trashId);
      if (!item) throw new Error(`假实现：回收站里没有 ${trashId}`);
      const trashDir = path.join(trashRoot, trashId);
      if (existsSync(item.located.path)) {
        if (!opts?.replace) throw new Error(`假实现：${item.located.path} 已存在`);
        await fs.rm(item.located.path, { recursive: true, force: true });
      }
      if (existsSync(trashDir)) {
        await fs.mkdir(path.dirname(item.located.path), { recursive: true });
        await fs.rename(trashDir, item.located.path);
      }
      trash.delete(trashId);
      skills.push(item.located);
      return summaryOf(item.located);
    },
  };
  return api;
}

/** 让 rootPath 返回真实的临时目录 */
export function withRootPaths(api: FakeApi, map: Record<string, string>): FakeApi {
  const original = api.rootPath.bind(api);
  api.rootPath = (rootId: RootId, opts: { workspace?: string }) => {
    const overridden = map[rootId];
    if (overridden !== undefined) return overridden;
    return original(rootId, opts);
  };
  return api;
}

/* ---------- 假 HubContext ---------- */

export function makeCtx(options: { homeDir: string; hubHome: string; logger?: HubLogger; profileName?: string }): HubContext {
  const logger = options.logger ?? makeLogger().logger;
  return {
    homeDir: options.homeDir,
    dshHome: path.join(options.homeDir, '.dsh'),
    hubHome: options.hubHome,
    profileName: options.profileName ?? 'capability-hub-dev',
    logger,
    customSkillDirs: [],
  };
}

/* ---------- 假 fetch ---------- */

export interface FakeFetchRoute {
  /** 命中判定 */
  match: (url: string, init?: RequestInit) => boolean;
  /** 响应构造 */
  response: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: { url: string; headers: Record<string, string> }[];
}

export function makeFakeFetch(routes: FakeFetchRoute[]): FakeFetch {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) headers[k.toLowerCase()] = String(v);
    }
    calls.push({ url, headers });
    for (const route of routes) {
      if (route.match(url, init)) return await route.response(url, init);
    }
    return new Response('not found', { status: 404 });
  };
  return { fetch: fake as unknown as typeof fetch, calls };
}

export function gzipResponse(body: Buffer, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(new Uint8Array(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/x-gzip', ...(init.headers ?? {}) },
  });
}

export function jsonResponse(value: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** 造一个 codeload 形态的 tar.gz 响应字节 */
export function tarGzOf(entries: FixtureEntry[], root = 'demo-main'): Buffer {
  return repoArchive(entries, { root });
}

/** 归档内某个技能目录的「安装时记录值」（= 模块写入 lock 的那个值） */
export function archiveInstalledHash(gz: Buffer, dir?: string): string {
  const entries = readTarEntries(gunzipSync(gz));
  const target = dir ?? entries.filter((e) => e.type === 'file' && /\/SKILL\.md$/i.test(e.path))[0]!.path.replace(/\/SKILL\.md$/i, '');
  return recordedHash(hashTarDirectory(entries, target));
}

/** 本地技能目录的「登记时记录值」 */
export async function localInstalledHash(dir: string): Promise<string> {
  return recordedHash(await hashLocalDirectory(dir));
}