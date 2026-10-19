/**
 * shared/node/search-cache.ts：共享搜索缓存（D-B19）的规则。
 *
 * 覆盖：LRU 淘汰、同关键词覆盖、损坏 / 形状不对的文件容错、大小写与空白归一化、原子写往返。
 * 不联网、不碰真实数据目录：每个用例只在自己的临时目录里读写。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  emptySearchCache,
  lookup,
  readSearchCache,
  searchCacheFilePath,
  searchCacheKey,
  SEARCH_CACHE_FILE_NAME,
  SEARCH_CACHE_MAX_ENTRIES,
  SEARCH_CACHE_VERSION,
  store,
  writeSearchCache,
  type SearchCache,
  type SearchCacheEntry,
} from "../../../src/shared/node/search-cache.ts";

const AT = "2026-10-18T02:00:00.000Z";

function makeTempDir(prefix = "cap-hub-search-cache-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function entry(
  query: string,
  options: {
    source?: SearchCacheEntry["source"];
    at?: string;
    route?: SearchCacheEntry["route"];
    payload?: unknown;
    mirrorHost?: string;
  } = {},
): SearchCacheEntry {
  const value: SearchCacheEntry = {
    source: options.source ?? "registry",
    query,
    at: options.at ?? AT,
    route: options.route ?? "direct",
    payload: options.payload ?? { items: [{ name: "io.example/" + query.trim().toLowerCase() }] },
  };
  if (options.mirrorHost !== undefined) value.mirrorHost = options.mirrorHost;
  return value;
}

async function writeRaw(file: string, raw: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, raw);
}

describe("search-cache: 键与归一化", () => {
  it("键 = 来源 + NUL + trim 小写后的关键词；来源不同不撞键", () => {
    assert.equal(searchCacheKey("registry", "  Jira  "), "registry\u0000jira");
    assert.equal(searchCacheKey("registry", "JIRA"), searchCacheKey("registry", " jira "));
    assert.notEqual(searchCacheKey("skills.sh", "jira"), searchCacheKey("registry", "jira"));
  });

  it("store 用归一化后的键：大小写 / 空白不同也覆盖同一条", () => {
    let cache = store(emptySearchCache(), entry("Jira"));
    cache = store(cache, entry("  jira "));
    assert.deepEqual(cache.order, ["registry\u0000jira"]);
    assert.equal(Object.keys(cache.entries).length, 1);
    assert.equal(lookup(cache, "registry", "  JiRa ")?.query, "  jira ", "后写的覆盖前一条");
    assert.equal(lookup(cache, "skills.sh", "jira"), undefined);
  });
});

describe("search-cache: store / lookup / LRU", () => {
  it("同关键词覆盖：order 长度不变、条目移到末尾、payload 用新的", () => {
    let cache = store(emptySearchCache(), entry("alpha", { payload: { items: ["old"] } }));
    cache = store(cache, entry("beta"));
    cache = store(cache, entry("alpha", { payload: { items: ["new"] }, at: "2026-10-19T00:00:00.000Z" }));

    assert.deepEqual(cache.order, ["registry\u0000beta", "registry\u0000alpha"]);
    assert.equal(cache.order.length, 2);
    assert.equal(Object.keys(cache.entries).length, 2);
    assert.deepEqual(lookup(cache, "registry", "alpha")?.payload, { items: ["new"] });
    assert.equal(lookup(cache, "registry", "alpha")?.at, "2026-10-19T00:00:00.000Z");
  });

  it("store 不改传入的缓存（返回新对象）", () => {
    const before = store(emptySearchCache(), entry("alpha"));
    const snapshot: SearchCache = JSON.parse(JSON.stringify(before)) as SearchCache;
    const after = store(before, entry("beta"));
    assert.notEqual(after, before);
    assert.deepEqual(before, snapshot);
    assert.deepEqual(after.order, ["registry\u0000alpha", "registry\u0000beta"]);
  });

  it("超过 20 条淘汰最久未用的；用过的键重新计入（LRU 移到末尾）", () => {
    let cache = emptySearchCache();
    for (let index = 1; index <= SEARCH_CACHE_MAX_ENTRIES + 1; index += 1) {
      cache = store(cache, entry("q" + String(index).padStart(2, "0")));
    }
    assert.equal(SEARCH_CACHE_MAX_ENTRIES, 20);
    assert.equal(cache.order.length, 20);
    assert.equal(Object.keys(cache.entries).length, 20);
    assert.equal(cache.order.at(-1), "registry\u0000q21", "最近写过的在末尾");
    assert.equal(lookup(cache, "registry", "q01"), undefined, "第 1 条最久未用，被淘汰");
    assert.ok(lookup(cache, "registry", "q02") !== undefined);

    // 重新写 q02（大小写不同也是同一个键）→ 移到末尾；再写一条时被淘汰的是 q03
    cache = store(cache, entry("Q02"));
    assert.equal(cache.order.at(-1), "registry\u0000q02");
    assert.equal(lookup(cache, "registry", "q02")?.query, "Q02");
    cache = store(cache, entry("q22"));
    assert.equal(cache.order.length, 20);
    assert.ok(lookup(cache, "registry", "q02") !== undefined, "刚用过的不该被淘汰");
    assert.equal(lookup(cache, "registry", "q03"), undefined);
    for (const key of cache.order) assert.ok(cache.entries[key] !== undefined, "order 与 entries 必须一致");
  });

  it("lookup 命中时不改顺序（回落读缓存不该触发写盘）", () => {
    let cache = store(emptySearchCache(), entry("alpha"));
    cache = store(cache, entry("beta"));
    const snapshot = [...cache.order];
    assert.ok(lookup(cache, "registry", "alpha") !== undefined);
    assert.deepEqual(cache.order, snapshot);
  });
});

describe("search-cache: 读容错（坏文件一律按空缓存，绝不抛）", () => {
  it("文件不存在 → 空缓存", async () => {
    const file = path.join(makeTempDir(), SEARCH_CACHE_FILE_NAME);
    assert.deepEqual(await readSearchCache(file), emptySearchCache());
    assert.deepEqual(await readSearchCache(file), { version: SEARCH_CACHE_VERSION, order: [], entries: {} });
  });

  it("坏 JSON / 空文件 / 顶层形状不对 → 空缓存", async () => {
    const dir = makeTempDir();
    const raws = [
      "",
      "   \n",
      "不是 JSON",
      "null",
      "[1,2,3]",
      '"just a string"',
      JSON.stringify({ version: 2, order: [], entries: {} }),
      JSON.stringify({ version: 1, order: "nope", entries: {} }),
      JSON.stringify({ version: 1, order: [], entries: [] }),
      JSON.stringify({ version: 1, order: [], entries: null }),
    ];
    for (const [index, raw] of raws.entries()) {
      const file = path.join(dir, "cache-" + index + ".json");
      await writeRaw(file, raw);
      assert.deepEqual(await readSearchCache(file), emptySearchCache(), "第 " + index + " 份应当读成空缓存");
    }
  });

  it("单条不合格只丢那一条（键与内容不符 / route 不合法 / 缺 payload）", async () => {
    const file = path.join(makeTempDir(), SEARCH_CACHE_FILE_NAME);
    await writeRaw(
      file,
      JSON.stringify({
        version: 1,
        order: ["registry\u0000ok", "registry\u0000wrong", "registry\u0000route", "registry\u0000nopayload", "缺条目"],
        entries: {
          "registry\u0000ok": entry("ok"),
          "registry\u0000wrong": { ...entry("other"), query: "other" },
          "registry\u0000route": { ...entry("route"), route: "carrier-pigeon" },
          "registry\u0000nopayload": { source: "registry", query: "nopayload", at: AT, route: "direct" },
        },
      }),
    );
    const cache = await readSearchCache(file);
    assert.deepEqual(Object.keys(cache.entries), ["registry\u0000ok"]);
    assert.deepEqual(cache.order, ["registry\u0000ok"]);
  });

  it("order 只留有效键、去重，entries 里没登记的补到末尾", async () => {
    const file = path.join(makeTempDir(), SEARCH_CACHE_FILE_NAME);
    await writeRaw(
      file,
      JSON.stringify({
        version: 1,
        order: ["registry\u0000second", "registry\u0000first", "registry\u0000second", "已经不存在"],
        entries: {
          "registry\u0000first": entry("first"),
          "registry\u0000second": entry("second"),
          "registry\u0000extra": entry("extra"),
        },
      }),
    );
    const cache = await readSearchCache(file);
    assert.deepEqual(cache.order, ["registry\u0000second", "registry\u0000first", "registry\u0000extra"]);
    assert.equal(Object.keys(cache.entries).length, 3);
  });
});

describe("search-cache: 原子写与往返", () => {
  it("writeSearchCache → readSearchCache 往返一致（父目录自动建）", async () => {
    const file = searchCacheFilePath(path.join(makeTempDir(), "nested", "sub"));
    assert.equal(path.basename(file), SEARCH_CACHE_FILE_NAME);

    let cache = store(emptySearchCache(), entry("alpha", { payload: { items: [{ name: "a" }] } }));
    cache = store(cache, entry("beta", { source: "skills.sh", mirrorHost: "ghfast.top", payload: { skills: [] } }));
    await writeSearchCache(file, cache);

    const back = await readSearchCache(file);
    assert.deepEqual(back, cache);
    assert.equal(back.entries["registry\u0000alpha"]?.mirrorHost, undefined);
    assert.equal(back.entries["skills.sh\u0000beta"]?.mirrorHost, "ghfast.top");

    const raw = JSON.parse(await fs.readFile(file, "utf8")) as { version: number; order: string[] };
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.order, ["registry\u0000alpha", "skills.sh\u0000beta"]);
  });

  it("写盘是原子的：不留临时文件，覆盖写后内容完整", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, SEARCH_CACHE_FILE_NAME);
    await writeSearchCache(file, store(emptySearchCache(), entry("alpha")));
    await writeSearchCache(file, store(emptySearchCache(), entry("beta")));
    const names = await fs.readdir(dir);
    assert.deepEqual(names, [SEARCH_CACHE_FILE_NAME], "同目录不该留下 .tmp 临时文件");
    const cache = await readSearchCache(file);
    assert.deepEqual(cache.order, ["registry\u0000beta"]);
  });
});
