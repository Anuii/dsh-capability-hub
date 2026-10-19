/**
 * 共享搜索缓存（0.10.0，D-B19）：宿主专用的叶子工具。
 *
 * 目的：使用者要求「网络问题应当无感」——skills.sh 与 Official MCP Registry 的搜索结果在网络失败
 * （超时 / 网络异常 / 429 / 5xx）时退回上一次成功的结果并标注「缓存于 X」，而不是把网络错误直接摆到界面上。
 * 两个功能模块共用同一个文件，所以放在 shared/node/：
 *   - 文件：<hubHome>/search-cache.json（跨模块一份）；
 *   - 形状：{ version: 1, order: string[], entries: Record<string, SearchCacheEntry> }；
 *   - 键：source + "\u0000" + query.trim().toLowerCase()（带来源前缀，两个功能的关键词不会撞键）；
 *   - LRU：order 是「最久未用 → 最近使用」的顺序；store 把这次写入的键移到末尾，超过 20 条淘汰队首。
 *     不设硬过期、不自动后台刷新（D-B19；界面标「上次成功于 X · 点刷新重试」）。
 *
 * 读：文件不存在 / 坏 JSON / 形状不对 → 空缓存，**绝不抛错**（缓存坏了只是不回落，不能拖垮搜索）。
 * 写：复用 shared/node/fsx.ts 的 atomicWriteFile（同卷 rename，读方看不到写了一半的文件）。
 * 规则 8：本文件只给宿主用，界面 / kit / 规则 / 契约都不能引用它。
 */

import path from "node:path";

import { atomicWriteFile, readTextFile } from "./fsx.ts";
import type { NetworkRoute } from "../network.ts";

/** 缓存文件的版本；形状变了就升这个数，旧文件读到即按空缓存处理。 */
export const SEARCH_CACHE_VERSION = 1;

/** 最多留几个关键词（D-B19：每关键词留最近 1 条、最多 20 个关键词 LRU）。 */
export const SEARCH_CACHE_MAX_ENTRIES = 20;

/** 缓存文件在 <hubHome> 下的文件名（skills.sh 与 registry 共用）。 */
export const SEARCH_CACHE_FILE_NAME = "search-cache.json";

/** 哪一份搜索结果：skills.sh 搜索，或 Official MCP Registry 搜索。 */
export type SearchCacheSource = "skills.sh" | "registry";

/** 一个关键词最近一次成功的结果。 */
export interface SearchCacheEntry {
  source: SearchCacheSource;
  /** 用户输入的关键词（原样保留；进键的是 trim + 小写后的版本）。 */
  query: string;
  /** 这次成功取回结果的时刻（ISO）；回落时界面上要显示的就是它。 */
  at: string;
  /** 这次结果实际走的路线（registry 不走镜像，固定 direct）。 */
  route: NetworkRoute;
  /** 经镜像时的镜像主机名（界面展示用，例如 ghfast.top）。 */
  mirrorHost?: string;
  /** 结果本身：各功能自己定义形状，只经这个文件传递。 */
  payload: unknown;
}

/** 整个缓存文件。 */
export interface SearchCache {
  version: 1;
  /** 键的使用顺序：最久未用的在前，最近用过的在末尾。 */
  order: string[];
  entries: Record<string, SearchCacheEntry>;
}

/** 键：来源 + 归一化关键词（trim + 小写）。 */
export function searchCacheKey(source: SearchCacheSource, query: string): string {
  return source + "\u0000" + query.trim().toLowerCase();
}

/** 空缓存（每次返回新对象，调用方可以随便改）。 */
export function emptySearchCache(): SearchCache {
  return { version: SEARCH_CACHE_VERSION, order: [], entries: {} };
}

/** <hubHome>/search-cache.json：两个功能模块都用它拼路径，别各写一份。 */
export function searchCacheFilePath(hubHome: string): string {
  return path.join(hubHome, SEARCH_CACHE_FILE_NAME);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 校验一条 entry：字段齐全、来源合法、且它自己的 source+query 归一化后正好等于它所在的键。
 * 键与内容对不上的一律丢掉（手改过 / 拼错的条目不该被当成命中）。
 */
function entryOf(raw: unknown, key: string): SearchCacheEntry | undefined {
  if (!isRecord(raw)) return undefined;
  const source = raw.source;
  if (source !== "skills.sh" && source !== "registry") return undefined;
  if (typeof raw.query !== "string") return undefined;
  if (searchCacheKey(source, raw.query) !== key) return undefined;
  if (typeof raw.at !== "string" || raw.at === "") return undefined;
  if (raw.route !== "direct" && raw.route !== "mirror") return undefined;
  if (!("payload" in raw)) return undefined;
  const entry: SearchCacheEntry = { source, query: raw.query, at: raw.at, route: raw.route, payload: raw.payload };
  if (typeof raw.mirrorHost === "string" && raw.mirrorHost !== "") entry.mirrorHost = raw.mirrorHost;
  return entry;
}

/**
 * 读缓存：不存在 / 坏 JSON / 顶层形状不对 → 空缓存；单条不合格只丢那一条。
 * 签名保证不抛错——缓存只是「有更好」，不是搜索的必要条件。
 */
export async function readSearchCache(file: string): Promise<SearchCache> {
  const text = await readTextFile(file);
  if (text === undefined || text.trim() === "") return emptySearchCache();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptySearchCache();
  }
  if (!isRecord(parsed)) return emptySearchCache();
  if (parsed.version !== SEARCH_CACHE_VERSION) return emptySearchCache();
  if (!Array.isArray(parsed.order)) return emptySearchCache();
  if (!isRecord(parsed.entries)) return emptySearchCache();

  const entries: Record<string, SearchCacheEntry> = {};
  for (const [key, raw] of Object.entries(parsed.entries)) {
    const entry = entryOf(raw, key);
    if (entry !== undefined) entries[key] = entry;
  }

  // order 只留仍然有效的键（去重）；entries 里有、order 里没有的补到末尾，手改过文件也不丢内容。
  const order: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed.order) {
    if (typeof item !== "string" || seen.has(item)) continue;
    if (entries[item] === undefined) continue;
    seen.add(item);
    order.push(item);
  }
  for (const key of Object.keys(entries)) {
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  return { version: SEARCH_CACHE_VERSION, order, entries };
}

/** 查一条：没命中返回 undefined（命中不改顺序——回落读缓存不该触发写盘）。 */
export function lookup(cache: SearchCache, source: SearchCacheSource, query: string): SearchCacheEntry | undefined {
  return cache.entries[searchCacheKey(source, query)];
}

/**
 * 写入一条并返回**新的**缓存（不改入参）：
 *   - 同一个键重复写入 = 覆盖（每关键词只留最近 1 条）；
 *   - 这个键移到 order 末尾；
 *   - 超过 20 条时淘汰 order 最前面（最久未用）的。
 */
export function store(cache: SearchCache, entry: SearchCacheEntry): SearchCache {
  const key = searchCacheKey(entry.source, entry.query);
  const entries: Record<string, SearchCacheEntry> = { ...cache.entries, [key]: entry };
  const order = cache.order.filter((item) => item !== key && entries[item] !== undefined);
  for (const existing of Object.keys(entries)) {
    if (existing !== key && !order.includes(existing)) order.push(existing);
  }
  order.push(key);
  while (order.length > SEARCH_CACHE_MAX_ENTRIES) {
    const evicted = order.shift();
    if (evicted !== undefined) delete entries[evicted];
  }
  return { version: SEARCH_CACHE_VERSION, order, entries };
}

/** 原子写整份缓存（父目录不存在时自动建）。 */
export async function writeSearchCache(file: string, cache: SearchCache): Promise<void> {
  await atomicWriteFile(file, JSON.stringify(cache, null, 2) + "\n");
}
