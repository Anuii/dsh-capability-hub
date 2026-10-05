/** 元数据缓存：configHash 失效面、7 天过期、并发写不丢别的服务器条目、畸形文件不炸。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  computeConfigHash,
  isEntryStale,
  isEntryValid,
  MetadataCache,
  sanitizeCacheFile,
} from "../../../src/mcp/runtime/atoms/metadata-cache.ts";
import { FakeClock } from "./fakes/fake-clock.ts";
import { makeServer, makeTempHome } from "./helpers.ts";

test("configHash 随「怎么到达」变化", () => {
  const base = makeServer({ serverName: "s", command: "node", args: ["a.js"] });
  const hash = computeConfigHash(base);
  assert.notEqual(hash, computeConfigHash({ ...base, command: "node2" }));
  assert.notEqual(hash, computeConfigHash({ ...base, args: ["b.js"] }));
  assert.notEqual(hash, computeConfigHash({ ...base, cwd: "C:/tmp" }));
  assert.notEqual(hash, computeConfigHash({ ...base, env: { A: "1" } }));
  assert.notEqual(hash, computeConfigHash({ ...base, transport: "streamable-http", url: "https://x" }));
  assert.notEqual(hash, computeConfigHash({ ...base, headers: { H: "v" } }));
  assert.notEqual(hash, computeConfigHash({ ...base, envFrom: { K: "echo 1" } }));
});

test("configHash 刻意排除展示与生命周期字段", () => {
  const base = makeServer({ serverName: "s", command: "node" });
  const hash = computeConfigHash(base);
  assert.equal(hash, computeConfigHash({ ...base, idleTimeoutMin: 0 }), "idleTimeout 不进哈希");
  assert.equal(hash, computeConfigHash({ ...base, lifecycle: "keep-alive" }), "lifecycle 不进哈希");
  assert.equal(hash, computeConfigHash({ ...base, disabled: true }), "disabled 不进哈希");
  assert.equal(hash, computeConfigHash({ ...base, debug: true }), "debug 不进哈希");
  assert.equal(hash, computeConfigHash({ ...base, toolCallTimeoutMs: 1 }), "toolCallTimeoutMs 不进哈希");
  assert.equal(hash, computeConfigHash({ ...base, includeTools: ["a"] }), "includeTools 不进哈希");
  assert.equal(hash, computeConfigHash({ ...base, excludeTools: ["a"] }), "excludeTools 不进哈希");
  assert.equal(hash, computeConfigHash({ ...base, searchKeywords: { a: ["b"] } }), "searchKeywords 不进哈希");
});

test("空 envFrom 不改变哈希（默认值不能给所有条目换 digest）", () => {
  const base = makeServer({ serverName: "s", command: "node" });
  assert.equal(computeConfigHash({ ...base, envFrom: {} }), computeConfigHash(base));
});

test("哈希与键顺序无关（canonical JSON）", () => {
  const a = makeServer({ serverName: "s", command: "node", env: { A: "1", B: "2" } });
  const b = makeServer({ serverName: "s", command: "node", env: { B: "2", A: "1" } });
  assert.equal(computeConfigHash(a), computeConfigHash(b));
});

test("7 天过期判定", () => {
  const server = makeServer({ serverName: "s", command: "node" });
  const now = 1_700_000_000_000;
  const entry = { configHash: computeConfigHash(server), tools: [], updatedAt: now - 6 * 24 * 3600 * 1000 };
  assert.equal(isEntryValid(entry, server, now), true);
  assert.equal(isEntryStale(entry, now), false);
  const old = { ...entry, updatedAt: now - 8 * 24 * 3600 * 1000 };
  assert.equal(isEntryValid(old, server, now), false);
  assert.equal(isEntryStale(old, now), true);
});

test("configHash 不匹配即失效", () => {
  const server = makeServer({ serverName: "s", command: "node" });
  const now = 1_700_000_000_000;
  const entry = { configHash: "deadbeef", tools: [], updatedAt: now };
  assert.equal(isEntryValid(entry, server, now), false);
});

test("版本不符 / 畸形条目被逐条丢弃，不影响其它条目", () => {
  assert.deepEqual(sanitizeCacheFile({ version: 99, servers: { a: {} } }), {});
  assert.deepEqual(sanitizeCacheFile(null), {});
  assert.deepEqual(sanitizeCacheFile({ version: 1, servers: null }), {});
  const good = { configHash: "h", tools: [{ name: "t", description: "d", inputSchema: {} }], cachedAt: 1 };
  const out = sanitizeCacheFile({
    version: 1,
    servers: { good, bad: null, worse: { configHash: "x" }, alsoBad: { configHash: "y", tools: "nope" } },
  });
  assert.deepEqual(Object.keys(out), ["good"]);
  assert.equal(out.good.updatedAt, 1, "兼容旧的 cachedAt 字段名");
  assert.equal(out.good.tools.length, 1);
});

test("读-合并-写：不覆盖文件里其它服务器的条目", async () => {
  const home = await makeTempHome("cache-merge");
  const clock = new FakeClock();
  try {
    const cacheA = new MetadataCache(home.hubHome, clock);
    const cacheB = new MetadataCache(home.hubHome, clock);
    await cacheA.write({ alpha: { configHash: "a", tools: [], updatedAt: clock.now() } });
    // 另一个"进程"（另一实例）写它自己的条目
    await cacheB.write({ beta: { configHash: "b", tools: [], updatedAt: clock.now() } });
    const raw = JSON.parse(await readFile(cacheA.filePath, "utf8"));
    assert.deepEqual(Object.keys(raw.servers).sort(), ["alpha", "beta"]);
    assert.equal(raw.version, 1);
  } finally {
    await home.cleanup();
  }
});

test("同名条目后写者胜", async () => {
  const home = await makeTempHome("cache-overwrite");
  const clock = new FakeClock();
  try {
    const cache = new MetadataCache(home.hubHome, clock);
    await cache.write({ alpha: { configHash: "first", tools: [], updatedAt: clock.now() } });
    await cache.write({ alpha: { configHash: "second", tools: [], updatedAt: clock.now() } });
    const raw = JSON.parse(await readFile(cache.filePath, "utf8"));
    assert.equal(raw.servers.alpha.configHash, "second");
  } finally {
    await home.cleanup();
  }
});

test("写回时丢掉磁盘上超龄的条目", async () => {
  const home = await makeTempHome("cache-stale");
  const clock = new FakeClock();
  try {
    const cache = new MetadataCache(home.hubHome, clock);
    await cache.write({ old: { configHash: "x", tools: [], updatedAt: clock.now() - 8 * 24 * 3600 * 1000 } });
    await cache.write({ fresh: { configHash: "y", tools: [], updatedAt: clock.now() } });
    const raw = JSON.parse(await readFile(cache.filePath, "utf8"));
    assert.deepEqual(Object.keys(raw.servers), ["fresh"]);
  } finally {
    await home.cleanup();
  }
});

test("文件损坏时视为无缓存，不抛异常", async () => {
  const home = await makeTempHome("cache-broken");
  const clock = new FakeClock();
  try {
    const cache = new MetadataCache(home.hubHome, clock);
    await cache.write({ alpha: { configHash: "a", tools: [], updatedAt: clock.now() } });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(cache.filePath, "{ not json", "utf8");
    const fresh = new MetadataCache(home.hubHome, clock);
    await fresh.load();
    assert.equal(fresh.get("alpha"), undefined);
    await fresh.write({ beta: { configHash: "b", tools: [], updatedAt: clock.now() } });
    const raw = JSON.parse(await readFile(cache.filePath, "utf8"));
    assert.deepEqual(Object.keys(raw.servers), ["beta"]);
  } finally {
    await home.cleanup();
  }
});
