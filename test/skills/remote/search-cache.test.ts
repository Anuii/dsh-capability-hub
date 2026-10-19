/**
 * D-B19 skills.sh 搜索缓存：成功写缓存、失败回落、没有缓存照旧报错、关键词归一化、缓存坏掉只降级。
 *
 * 全部用假 fetch；**绝不联网**。缓存文件就是模块默认的 <hubHome>/search-cache.json，
 * 而 buildRemoteEnv 给的 hubHome 是临时目录——真实数据目录一次也不会被碰。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  lookup,
  readSearchCache,
  searchCacheFilePath,
  store,
  writeSearchCache,
  type SearchCacheEntry,
} from "../../../src/shared/node/search-cache.ts";
import { buildRemoteEnv, callsMatching } from "./env.ts";
import { jsonResponse } from "./helpers.ts";
import type { RemoteEnv } from "./env.ts";
import type { FakeFetchRoute } from "./helpers.ts";
import type { SearchResponse } from "../../../src/skills/contract/remote.ts";

/** 缓存写入时刻：回落时 provenance.at 必须是它（不是「现在」）。 */
const CACHED_AT = "2025-10-01T08:00:00.000Z";

/** skills.sh 的原始响应（字段名与实测一致）。 */
const SKILLS_SH_PDF = {
  query: "pdf",
  searchType: "fuzzy",
  skills: [{ id: "anthropics/skills/pdf", skillId: "pdf", name: "pdf", installs: 205717, source: "anthropics/skills" }],
  count: 1,
};

/** 归一化后的一条结果（本机没装同名技能，所以 skillPath 是 undefined）。 */
const PDF_ITEM = { name: "pdf", repo: "anthropics/skills", skillPath: undefined, installs: 205717 };

/** 清掉 undefined 键：写进 JSON 再读回来时它们本来也会消失。 */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

const okRoutes = (): FakeFetchRoute[] => [
  { match: (u) => u.includes("skills.sh"), response: () => jsonResponse(SKILLS_SH_PDF) },
];

const networkDownRoutes = (): FakeFetchRoute[] => [
  {
    match: (u) => u.includes("skills.sh"),
    response: () => {
      throw new Error("ECONNRESET");
    },
  },
];

const rateLimitedRoutes = (): FakeFetchRoute[] => [
  {
    match: (u) => u.includes("skills.sh"),
    response: () => new Response("rate limited", { status: 429, headers: { "x-ratelimit-remaining": "0" } }),
  },
];

/** 预置一条缓存（默认 skills.sh + pdf）；返回缓存文件路径。 */
async function seedCache(
  hubHome: string,
  options: { query?: string; at?: string; source?: "skills.sh" | "registry"; payload?: unknown } = {},
): Promise<string> {
  const file = searchCacheFilePath(hubHome);
  const entry: SearchCacheEntry = {
    source: options.source ?? "skills.sh",
    query: options.query ?? "pdf",
    at: options.at ?? CACHED_AT,
    route: "direct",
    payload: options.payload ?? { results: [PDF_ITEM] },
  };
  await writeSearchCache(file, store(await readSearchCache(file), entry));
  return file;
}

/** 走一次搜索路由。 */
async function search(env: RemoteEnv, q: string, limit?: string): Promise<SearchResponse> {
  const query: Record<string, string> = { q };
  if (limit !== undefined) query.limit = limit;
  return (await env.call("GET skills/search", { query })) as unknown as SearchResponse;
}

/** 取一次调用抛出的错误（不抛就返回 undefined）。 */
async function catchOf(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; status?: number; message?: string } | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error as { code?: string; status?: number; message?: string };
  }
}

/** 日志里某一级的全部文字（断言「只记 warning」用）。 */
function logged(env: RemoteEnv, level: "debug" | "warn"): string[] {
  return env.sink.filter((record) => record.level === level).map((record) => record.args.map(String).join(" "));
}

/* ===================== 1. 成功：写缓存 ===================== */

test("D-B19 搜索成功：响应带 provenance.direct，缓存里的 at 与它一致", async () => {
  const env = await buildRemoteEnv({ routes: okRoutes() });
  const response = await search(env, "pdf");

  assert.equal(response.provenance?.route, "direct");
  const at = String(response.provenance?.at);
  assert.ok(!Number.isNaN(Date.parse(at)), "provenance.at 必须是 ISO 时刻：" + at);
  assert.deepEqual(plain(response.results), plain([PDF_ITEM]));

  const file = searchCacheFilePath(env.hubHome);
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as {
    version: number;
    order: string[];
    entries: Record<string, SearchCacheEntry>;
  };
  assert.equal(raw.version, 1);
  const key = "skills.sh\u0000pdf";
  assert.deepEqual(raw.order, [key], "只写了一个关键词");
  const entry = raw.entries[key]!;
  assert.equal(entry.source, "skills.sh");
  assert.equal(entry.query, "pdf", "关键词原样保存（不转小写）");
  assert.equal(entry.route, "direct", "skills.sh 不走镜像，路线固定直连");
  assert.equal(entry.mirrorHost, undefined);
  assert.equal(entry.at, at, "缓存里的 at 必须等于响应的 provenance.at");
  assert.deepEqual(entry.payload, { results: plain([PDF_ITEM]) });

  // 共享读函数读回来也是同一份（下一次失败就靠它回落）
  assert.equal(lookup(await readSearchCache(file), "skills.sh", "PDF")?.at, at);
});

/* ===================== 2. 失败：回落缓存 ===================== */

test("D-B19 搜索失败回落：网络错误 + 同关键词缓存 → 返回缓存并标缓存时刻，不抛错", async () => {
  const env = await buildRemoteEnv({ routes: networkDownRoutes() });
  await seedCache(env.hubHome, { at: CACHED_AT });

  const response = await search(env, "pdf");
  assert.deepEqual(plain(response.results), plain([PDF_ITEM]), "返回的是缓存里的结果");
  assert.equal(response.provenance?.route, "cache");
  assert.equal(response.provenance?.at, CACHED_AT, "at 是缓存写入时刻，不是现在");

  assert.equal(callsMatching(env, "skills.sh").length, 1, "确实先试过联网");
  const warns = logged(env, "warn");
  assert.ok(
    warns.some((line) => line.includes("缓存")),
    "回落要记一条 warning：" + warns.join(" / "),
  );
});

test("D-B19 限流也回落：429 + 同关键词缓存 → 不报错；无缓存时才抛 RATE_LIMITED", async () => {
  const cached = await buildRemoteEnv({ routes: rateLimitedRoutes() });
  await seedCache(cached.hubHome);
  const response = await search(cached, "pdf");
  assert.equal(response.provenance?.route, "cache");
  assert.deepEqual(plain(response.results), plain([PDF_ITEM]));

  const bare = await buildRemoteEnv({ routes: rateLimitedRoutes() });
  const thrown = await catchOf(() => search(bare, "pdf"));
  assert.equal(thrown?.code, "RATE_LIMITED");
  assert.equal(thrown?.status, 429);
  assert.match(String(thrown?.message), /速率限制/);
});

test("D-B19 端到端：先成功写缓存、再断网 → 同一关键词回落到第一次的结果", async () => {
  let calls = 0;
  const env = await buildRemoteEnv({
    routes: [
      {
        match: (u) => u.includes("skills.sh"),
        response: () => {
          calls += 1;
          if (calls > 1) throw new Error("EHOSTUNREACH");
          return jsonResponse(SKILLS_SH_PDF);
        },
      },
    ],
  });

  const first = await search(env, "pdf");
  const second = await search(env, "pdf");
  assert.equal(second.provenance?.route, "cache");
  assert.equal(second.provenance?.at, first.provenance?.at, "回落的时刻 = 第一次成功写入的时刻");
  assert.deepEqual(plain(second.results), plain(first.results));
});

/* ===================== 3. 失败：没有缓存照旧报错 ===================== */

test("D-B19 无同来源缓存：照旧抛原来的中文错误（registry 的缓存不顶用）", async () => {
  const env = await buildRemoteEnv({ routes: networkDownRoutes() });
  // 同一个关键词、但来源是 registry —— 键带来源前缀，不能被 skills.sh 的失败借走
  await seedCache(env.hubHome, { source: "registry" });

  const thrown = await catchOf(() => search(env, "pdf"));
  assert.equal(thrown?.code, "UPSTREAM");
  assert.equal(thrown?.status, 502);
  assert.match(String(thrown?.message), /搜索 skills\.sh 失败/);

  const cache = await readSearchCache(searchCacheFilePath(env.hubHome));
  assert.equal(lookup(cache, "skills.sh", "pdf"), undefined, "失败的搜索不写缓存");
  assert.notEqual(lookup(cache, "registry", "pdf"), undefined, "别人的缓存原样留着");
});

/* ===================== 4. 关键词归一化 ===================== */

test("D-B19 关键词归一化：大小写与首尾空白命中同一份缓存", async () => {
  const env = await buildRemoteEnv({ routes: networkDownRoutes() });
  await seedCache(env.hubHome, { query: "  PDF  " });

  for (const q of ["pdf", "PDF", "  Pdf  "]) {
    const response = await search(env, q);
    assert.equal(response.provenance?.route, "cache", q);
    assert.deepEqual(plain(response.results), plain([PDF_ITEM]), q);
  }
  // 换了关键词就不命中：照旧抛错（不是「任何缓存都能顶」）
  assert.equal((await catchOf(() => search(env, "docx")))?.code, "UPSTREAM");
});

/* ===================== 5. 缓存出问题只降级 ===================== */

test("D-B19 写缓存失败只记 warning：本次响应照常返回", async () => {
  const env = await buildRemoteEnv({ routes: okRoutes() });
  // 把缓存路径做成「非空目录」：读 → 空缓存；原子写的 rename 一定失败
  const file = searchCacheFilePath(env.hubHome);
  await fs.mkdir(file, { recursive: true });
  await fs.writeFile(path.join(file, "marker.txt"), "x");

  const response = await search(env, "pdf");
  assert.equal(response.provenance?.route, "direct");
  assert.deepEqual(plain(response.results), plain([PDF_ITEM]), "写缓存失败不影响响应");

  const warns = logged(env, "warn");
  assert.ok(
    warns.some((line) => line.includes("写搜索缓存失败")),
    "必须记一条 warning：" + warns.join(" / "),
  );
  assert.equal((await fs.stat(file)).isDirectory(), true, "缓存路径没被写坏");
});

test("D-B19 缓存坏掉只降级：坏 JSON 不影响成功路径，payload 形状不对就当没缓存", async () => {
  // 坏 JSON：搜索成功照常返回，并把文件重写成合法缓存
  const broken = await buildRemoteEnv({ routes: okRoutes() });
  const brokenFile = searchCacheFilePath(broken.hubHome);
  await fs.writeFile(brokenFile, "{ 这不是 JSON");
  const ok = await search(broken, "pdf");
  assert.equal(ok.provenance?.route, "direct");
  assert.equal(lookup(await readSearchCache(brokenFile), "skills.sh", "pdf")?.at, ok.provenance?.at);

  // payload 形状不对（手改过）：搜索失败时按「没有缓存」处理，照旧抛原错误
  const stale = await buildRemoteEnv({ routes: networkDownRoutes() });
  await seedCache(stale.hubHome, { payload: { items: [] } });
  const thrown = await catchOf(() => search(stale, "pdf"));
  assert.equal(thrown?.code, "UPSTREAM");
  assert.match(String(thrown?.message), /搜索 skills\.sh 失败/);
});
