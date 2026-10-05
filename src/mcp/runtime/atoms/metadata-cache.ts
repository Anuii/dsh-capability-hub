/**
 * 元数据缓存：hubHome/mcp/cache.json（D-C1、F3-Q3）。
 *
 * 两个必须复刻的要点：
 *
 * 1. **所有 profile 共用一份**（路径里没有 profile 段）。一台机器上可能有多个 DSH 进程
 *    （GUI + CLI）同时读写，所以写回**绝不是整文件覆盖**，而是按服务器条目做「读-合并-原子写」：
 *    先重新读盘、丢掉超龄条目，再用本次写入的条目覆盖同名条目，最后原子 rename。
 *    代价（F3 明说且被接受）：无锁，两个进程同时写仍可能互丢，但绝不会因为 A 进程写自己那台服务器
 *    而删掉 B 进程写的其它服务器条目。
 *
 * 2. **configHash 只覆盖「怎么到达」**：transport / command / args / env / cwd / url / headers / envFrom。
 *    展示与生命周期字段（idleTimeout、includeTools、excludeTools、searchKeywords、disabled、
 *    lifecycle、debug、toolCallTimeoutMs、meta）刻意不进哈希 —— 改「怎么展示」不该丢掉好不容易拉到的目录，
 *    改「怎么到达」必须丢掉。envFrom **只在非空时**才进哈希：否则一个空对象默认值会给所有既有条目换 digest。
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CACHE_FILE_NAME, CACHE_MAX_AGE_MS, CACHE_VERSION, MCP_DIR_NAME } from '../constants.ts';
import { atomicWriteFile, readTextFile } from './fsx.ts';
import type { EffectiveServer } from '../../contract/config.ts';
import type { Clock } from './clock.ts';

export interface CachedTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface CacheEntry {
  configHash: string;
  tools: CachedTool[];
  instructions?: string;
  updatedAt: number;
}

export interface MetadataCacheFile {
  version: number;
  servers: Record<string, CacheEntry>;
}

/** 稳定的字符串化（键排序），保证同样的配置永远得到同样的哈希。 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((item) => canonical(item)).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
}

/** configHash 只覆盖传输相关字段（F3-Q3 computeConfigHash）。 */
export function computeConfigHash(server: EffectiveServer): string {
  const envFrom = server.envFrom ?? {};
  const payload: Record<string, unknown> = {
    transport: server.transport,
    command: server.command ?? null,
    args: server.args ?? [],
    env: server.env ?? {},
    cwd: server.cwd ?? null,
    url: server.url ?? null,
    headers: server.headers ?? {},
  };
  if (Object.keys(envFrom).length > 0) payload.envFrom = envFrom;
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

export function isEntryValid(entry: CacheEntry | undefined, server: EffectiveServer, now: number): boolean {
  if (!entry) return false;
  if (entry.configHash !== computeConfigHash(server)) return false;
  return now - entry.updatedAt <= CACHE_MAX_AGE_MS;
}

export function isEntryStale(entry: CacheEntry | undefined, now: number): boolean {
  if (!entry) return false;
  return now - entry.updatedAt > CACHE_MAX_AGE_MS;
}

function sanitizeTool(value: unknown): CachedTool | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const tool = value as Record<string, unknown>;
  if (typeof tool.name !== 'string' || tool.name.length === 0) return undefined;
  return {
    name: tool.name,
    description: typeof tool.description === 'string' ? tool.description : '',
    inputSchema: tool.inputSchema ?? { type: 'object' },
  };
}

function sanitizeEntry(value: unknown): CacheEntry | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.configHash !== 'string') return undefined;
  if (!Array.isArray(entry.tools)) return undefined;
  const tools: CachedTool[] = [];
  for (const item of entry.tools) {
    const tool = sanitizeTool(item);
    if (tool) tools.push(tool);
  }
  const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : typeof entry.cachedAt === 'number' ? entry.cachedAt : 0;
  const result: CacheEntry = { configHash: entry.configHash, tools, updatedAt };
  if (typeof entry.instructions === 'string') result.instructions = entry.instructions;
  return result;
}

/**
 * 逐条目校验后再接受：一个 null 条目或缺失 tools 数组**不能**拖垮整个运行时
 * （F3 CHANGELOG 0.3.0：畸形缓存不再阻止加载）。
 */
export function sanitizeCacheFile(value: unknown): Record<string, CacheEntry> {
  if (value === null || typeof value !== 'object') return {};
  const file = value as Record<string, unknown>;
  if (file.version !== CACHE_VERSION) return {};
  const servers = file.servers;
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return {};
  const out: Record<string, CacheEntry> = {};
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const entry = sanitizeEntry(raw);
    if (entry) out[name] = entry;
  }
  return out;
}

export class MetadataCache {
  readonly filePath: string;
  readonly spillDir: string;
  #entries: Record<string, CacheEntry> = {};
  #loaded = false;
  /** 本进程最后看到的磁盘文本，用于「内容变了没」的判断（见 reloadIfChanged）。 */
  #text: string | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  #clock: Clock;
  #warn: (message: string) => void;

  constructor(hubHome: string, clock: Clock, warn: (message: string) => void = () => undefined) {
    this.filePath = join(hubHome, MCP_DIR_NAME, CACHE_FILE_NAME);
    this.spillDir = join(hubHome, MCP_DIR_NAME, 'spill');
    this.#clock = clock;
    this.#warn = warn;
  }

  /** 串行化本进程内的读-合并-写，避免自己和自己抢。 */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** 接受一份磁盘文本（load 与 reloadIfChanged 共用）。 */
  #applyText(text: string | undefined): void {
    this.#text = text;
    if (text === undefined) {
      this.#entries = {};
      this.#loaded = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#warn('MCP 元数据缓存文件无法解析，已忽略：' + this.filePath);
      this.#entries = {};
      this.#loaded = true;
      return;
    }
    this.#entries = sanitizeCacheFile(parsed);
    this.#loaded = true;
  }

  async load(): Promise<void> {
    await this.#serial(async () => {
      this.#applyText(await readTextFile(this.filePath));
    });
  }

  /**
   * 磁盘内容与本进程看到的不一致时重新加载；返回是否真的重载了。
   *
   * 为什么不能只看 mtime：Windows/NTFS 的时间戳粒度**实测约 4ms**（本机连续 30 次原子写里
   * 有 24 次的 mtimeMs 完全相同，证据见 .review/t3b/mtime-probe.mjs），
   * 而「GUI 进程刚刷新缓存、CLI 进程随后读」的间隔通常恰好落在这一瞬间。
   * 只看 mtime 就会把刚被另一个进程写过的缓存当成旧的，search/describe/status 会读到过期清单。
   * 因此这里按**内容**比较：cache.json 只有 KB 级，一次读盘的代价远小于任何一次 MCP 交互。
   */
  async reloadIfChanged(): Promise<boolean> {
    return this.#serial(async () => {
      const text = await readTextFile(this.filePath);
      if (this.#loaded && text === this.#text) return false;
      this.#applyText(text);
      return true;
    });
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  get(serverName: string): CacheEntry | undefined {
    return this.#entries[serverName];
  }

  snapshot(): Record<string, CacheEntry> {
    return { ...this.#entries };
  }

  /** 读-合并-原子写。只覆盖本次传入的条目，同文件里的其它服务器条目原样保留。 */
  async write(entries: Record<string, CacheEntry>): Promise<void> {
    await this.#serial(async () => {
      let onDisk: Record<string, CacheEntry> = {};
      const text = await readTextFile(this.filePath);
      if (text !== undefined) {
        try {
          onDisk = sanitizeCacheFile(JSON.parse(text));
        } catch {
          onDisk = {};
        }
      }
      const now = this.#clock.now();
      const merged: Record<string, CacheEntry> = {};
      for (const [name, entry] of Object.entries(onDisk)) {
        if (now - entry.updatedAt <= CACHE_MAX_AGE_MS) merged[name] = entry;
      }
      for (const [name, entry] of Object.entries(entries)) merged[name] = entry;
      const serialized = JSON.stringify({ version: CACHE_VERSION, servers: merged }, null, 2);
      await atomicWriteFile(this.filePath, serialized);
      this.#text = serialized;
      this.#entries = merged;
      this.#loaded = true;
    });
  }

  async remove(serverName: string): Promise<void> {
    await this.#serial(async () => {
      const text = await readTextFile(this.filePath);
      let onDisk: Record<string, CacheEntry> = {};
      if (text !== undefined) {
        try {
          onDisk = sanitizeCacheFile(JSON.parse(text));
        } catch {
          onDisk = {};
        }
      }
      delete onDisk[serverName];
      const now = this.#clock.now();
      const merged: Record<string, CacheEntry> = {};
      for (const [name, entry] of Object.entries(onDisk)) {
        if (now - entry.updatedAt <= CACHE_MAX_AGE_MS) merged[name] = entry;
      }
      const serialized = JSON.stringify({ version: CACHE_VERSION, servers: merged }, null, 2);
      await atomicWriteFile(this.filePath, serialized);
      this.#text = serialized;
      this.#entries = merged;
    });
  }
}
