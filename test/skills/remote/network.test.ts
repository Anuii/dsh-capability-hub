/**
 * D-B19 网络层：archive 下载形态、API 直连→镜像降级、镜像能力探测、设置读写、网络事件。
 *
 * 全部用假 fetch；**绝不联网**。验收点逐条对应下面的分节标题：
 *   1. 下载形态统一为 archive（codeload 形态不再出现）
 *   2. API 降级链（直连失败 → 无令牌经镜像重试；镜像再失败抛最初错误）
 *   3. probeDirect / probeMirror 的各分支
 *   4. 设置读写（含损坏数据）
 *   5. 网络事件（api / download / search 各一次）
 *   6. 路由接线（test-mirror 返回 direct + mirror；保存镜像时顺带探测）
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ARCHIVE_TIMEOUT_MS,
  GitHubClient,
  MIRRORED_HOSTS,
  MIRROR_TEST_URL,
  RATE_LIMIT_URL,
  applyMirror,
  archiveUrl,
  isApiUrl,
  isDegradableApiStatus,
  isMirroredUrl,
  mirrorHostOf,
  probeDirect,
  probeMirror,
} from "../../../src/skills/remote/github.ts";
import { readSettings, settingsFilePath, writeSettings } from "../../../src/skills/remote/settings.ts";
import { gzipResponse, jsonResponse, makeCtx, makeFakeFetch, makeLogger, makeTempDir, tarGzOf } from "./helpers.ts";
import { skillFixture } from "./tarfixture.ts";
import { buildRemoteEnv } from "./env.ts";
import type { NetworkEvent } from "../../../src/skills/remote/github.ts";
import type { FakeFetchRoute } from "./helpers.ts";
import type { HubContext } from "../../../src/platform/contract/host.ts";

const SECRET = "ghp_" + "n".repeat(36);
const MIRROR = "https://ghfast.top/";
const MIRROR_HOST = "ghfast.top";
/**
 * 历史下载主机（codeload.github.com）。拼出来而不是写字面量：
 * 它只用于「这条老路必须彻底消失」的断言，不该在代码里再出现一次可被抄走的地址。
 */
const LEGACY_ARCHIVE_HOST = ["code", "load", ".github.com"].join("");

function clientOf(
  routes: FakeFetchRoute[],
  options: { envToken?: string; mirror?: string; events?: NetworkEvent[] } = {},
) {
  const fake = makeFakeFetch(routes);
  const events = options.events ?? [];
  const client = new GitHubClient({
    fetchImpl: fake.fetch,
    logger: makeLogger().logger,
    envTokenProvider: () => options.envToken,
    ghTokenProvider: async () => undefined,
    cacheAuth: false,
    ...(options.mirror === undefined ? {} : { mirrorProvider: options.mirror }),
    onNetworkEvent: (event) => events.push(event),
  });
  return { client, fake, events };
}

const archiveEntries = () => skillFixture("productivity", "grilling");

function hubCtx(): HubContext {
  return makeCtx({ homeDir: makeTempDir("cap-hub-net-home-"), hubHome: makeTempDir("cap-hub-net-hub-") });
}

/* ===================== 1. 下载形态统一为 archive ===================== */

test("D-B19 1a：archiveUrl 就是 https://github.com/{repo}/archive/{ref}.tar.gz", () => {
  assert.equal(archiveUrl("acme/tools", "main"), "https://github.com/acme/tools/archive/main.tar.gz");
  // ref 里的特殊字符必须被编码，不能把路径改写到别处
  assert.equal(archiveUrl("acme/tools", "feat/x"), "https://github.com/acme/tools/archive/feat%2Fx.tar.gz");
  // 镜像判据只认这两个 host
  assert.deepEqual([...MIRRORED_HOSTS], ["raw.githubusercontent.com", "github.com"]);
  assert.equal(isMirroredUrl("https://github.com/a/b/archive/main.tar.gz"), true);
  assert.equal(isMirroredUrl("https://raw.githubusercontent.com/a/b/main/SKILL.md"), true);
});

test("D-B19 1b：downloadTarball 只请求 archive 形态，历史 codeload 地址一个都不出现", async () => {
  const gz = tarGzOf(archiveEntries(), "tools-main");
  const { client, fake } = clientOf([{ match: (u) => u.includes(".tar.gz"), response: () => gzipResponse(gz) }]);
  const result = await client.downloadTarball("acme/tools", "main");
  assert.equal(result.ref, "main");
  assert.ok(result.entries.some((e) => e.path === "skills/productivity/grilling/SKILL.md"));

  const downloads = fake.calls.filter((call) => call.url.includes(".tar.gz"));
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0]!.url, "https://github.com/acme/tools/archive/main.tar.gz");
  // 老主机彻底消失：所有请求的 host 都是 github.com
  assert.equal(fake.calls.filter((call) => call.url.includes(LEGACY_ARCHIVE_HOST)).length, 0, "不得再请求历史下载主机");
  assert.equal(ARCHIVE_TIMEOUT_MS, 60_000);
});

test("D-B19 1c：设了镜像时 archive 带前缀，且**不带 Authorization**（令牌不给第三方）", async () => {
  const gz = tarGzOf(archiveEntries(), "tools-main");
  const { client, fake } = clientOf([{ match: () => true, response: () => gzipResponse(gz) }], {
    envToken: SECRET,
    mirror: MIRROR,
  });
  await client.downloadTarball("acme/tools", "main");
  const call = fake.calls.find((c) => c.url.includes(".tar.gz"))!;
  assert.equal(call.url, `${MIRROR}https://github.com/acme/tools/archive/main.tar.gz`);
  assert.equal(call.headers["authorization"], undefined, "走镜像时绝不能带令牌");
});

/* ===================== 2. API 降级链 ===================== */

test("D-B19 2a：直连 403 → 无令牌经镜像重试同一个 URL；直连那次带令牌", async () => {
  const events: NetworkEvent[] = [];
  const { client, fake } = clientOf(
    [
      {
        match: (u) => u.startsWith("https://api.github.com/"),
        response: () => new Response("rate limited", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      },
      {
        match: (u) => u.startsWith(MIRROR),
        response: () => jsonResponse({ default_branch: "develop" }),
      },
    ],
    { envToken: SECRET, mirror: MIRROR, events },
  );

  assert.equal(await client.defaultBranch("acme/tools"), "develop");

  const direct = fake.calls.filter((c) => c.url.startsWith("https://api.github.com/"));
  const mirrored = fake.calls.filter((c) => c.url.startsWith(MIRROR));
  assert.equal(direct.length, 1);
  assert.equal(direct[0]!.url, "https://api.github.com/repos/acme/tools");
  assert.equal(direct[0]!.headers["authorization"], `Bearer ${SECRET}`);
  assert.equal(mirrored.length, 1);
  assert.equal(mirrored[0]!.url, `${MIRROR}https://api.github.com/repos/acme/tools`);
  assert.equal(mirrored[0]!.headers["authorization"], undefined, "镜像分支绝不带令牌");
  // 事件如实报告这一条走了镜像
  assert.deepEqual(events.at(-1), {
    kind: "api",
    route: "mirror",
    url: "https://api.github.com/repos/acme/tools",
    mirrorHost: MIRROR_HOST,
  });
});

test("D-B19 2b：直连网络异常也会经镜像重试；镜像成功后照常返回数据", async () => {
  const { client, fake } = clientOf(
    [
      {
        match: (u) => u.startsWith("https://api.github.com/"),
        response: () => {
          throw new Error("ECONNRESET");
        },
      },
      { match: (u) => u.startsWith(MIRROR), response: () => jsonResponse({ default_branch: "trunk" }) },
    ],
    { mirror: MIRROR },
  );
  assert.equal(await client.defaultBranch("acme/tools"), "trunk");
  assert.equal(fake.calls.filter((c) => c.url.includes("api.github.com")).length, 2);
});

test("D-B19 2c：镜像也失败时抛出**最初那条**错误（限流仍是 RATE_LIMITED，文案不变）", async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const { client } = clientOf(
    [
      {
        match: (u) => u.startsWith("https://api.github.com/"),
        response: () =>
          new Response("rate limited", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
          }),
      },
      { match: (u) => u.startsWith(MIRROR), response: () => new Response("mirror says 500", { status: 500 }) },
    ],
    { mirror: MIRROR },
  );

  let thrown: { code?: string; status?: number; message?: string } | undefined;
  try {
    await client.tree("acme/tools", "main");
  } catch (error) {
    thrown = error as typeof thrown;
  }
  assert.equal(thrown?.code, "RATE_LIMITED", "必须保留直连那次错误的 code");
  assert.equal(thrown?.status, 429);
  assert.match(String(thrown?.message), /速率限制/, "必须保留直连那次的原始中文文案");
  assert.ok(!String(thrown?.message).includes("镜像"), "不得把镜像的错误盖到直连错误上");
});

test("D-B19 2d：直连 500 + 镜像也失败 → 仍是直连那次的 UPSTREAM 文案（不含镜像字样）", async () => {
  const { client } = clientOf(
    [
      { match: (u) => u.startsWith("https://api.github.com/"), response: () => new Response("boom", { status: 500 }) },
      { match: (u) => u.startsWith(MIRROR), response: () => new Response("nope", { status: 502 }) },
    ],
    { mirror: MIRROR },
  );
  await assert.rejects(client.tree("acme/tools", "main"), (error: { code?: string; message: string }) => {
    assert.equal(error.code, "UPSTREAM");
    assert.match(error.message, /HTTP 500/);
    assert.ok(!error.message.includes("镜像"));
    return true;
  });
});

test("D-B19 2e：直连网络异常 + 镜像也异常 → 抛出最初那条异常，而不是镜像的", async () => {
  const { client } = clientOf(
    [
      {
        match: (u) => u.startsWith("https://api.github.com/"),
        response: () => {
          throw new Error("direct down");
        },
      },
      {
        match: (u) => u.startsWith(MIRROR),
        response: () => {
          throw new Error("mirror down");
        },
      },
    ],
    { mirror: MIRROR },
  );
  await assert.rejects(client.tree("acme/tools", "main"), (error: Error) => {
    assert.match(error.message, /direct down/);
    assert.ok(!error.message.includes("mirror down"));
    return true;
  });
});

test("D-B19 2f：没设镜像时行为与旧实现一致（一次直连，不重试）", async () => {
  const { client, fake } = clientOf([{ match: () => true, response: () => new Response("nope", { status: 403 }) }]);
  await assert.rejects(client.tree("acme/tools", "main"), (error: { code?: string }) => error.code === "UPSTREAM");
  assert.equal(fake.calls.length, 1);
});

test("D-B19 2g：404 / 401 是确定答复，不换路重试", async () => {
  for (const status of [404, 401]) {
    const { client, fake } = clientOf(
      [
        { match: (u) => u.startsWith("https://api.github.com/"), response: () => new Response("no", { status }) },
        { match: (u) => u.startsWith(MIRROR), response: () => jsonResponse({ default_branch: "develop" }) },
      ],
      { mirror: MIRROR },
    );
    assert.equal(await client.defaultBranch("acme/tools"), undefined);
    assert.equal(fake.calls.length, 1, `HTTP ${status} 不应触发镜像重试`);
  }
});

test("D-B19 2h：isDegradableApiStatus 的判据", () => {
  for (const status of [403, 429, 500, 502, 503]) assert.equal(isDegradableApiStatus(status), true, String(status));
  for (const status of [200, 201, 301, 304, 401, 404, 422]) {
    assert.equal(isDegradableApiStatus(status), false, String(status));
  }
});

/* ===================== 3. 探测 ===================== */

test("D-B19 3a：probeDirect 成功 → ok + status + ISO 时刻；有令牌就带 Authorization", async () => {
  const { fetch: fake, calls } = makeFakeFetch([
    { match: (u) => u === RATE_LIMIT_URL, response: () => jsonResponse({ resources: { core: { remaining: 1 } } }) },
  ]);
  const status = await probeDirect(fake);
  assert.equal(status.ok, true);
  assert.equal(status.status, 200);
  assert.equal(status.message, undefined);
  assert.ok(!Number.isNaN(Date.parse(status.checkedAt)), status.checkedAt);
  assert.equal(calls[0]!.headers["authorization"], undefined);

  const withToken = makeFakeFetch([{ match: () => true, response: () => jsonResponse({}) }]);
  await probeDirect(withToken.fetch, SECRET);
  assert.equal(withToken.calls[0]!.headers["authorization"], `Bearer ${SECRET}`);
});

test("D-B19 3b：probeDirect 失败 → ok:false + 状态码 + 中文原因（403 / 429 / 5xx 各有说法）", async () => {
  const of = async (status: number) => {
    const { fetch: fake } = makeFakeFetch([{ match: () => true, response: () => new Response("x", { status }) }]);
    return await probeDirect(fake);
  };
  const forbidden = await of(403);
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.status, 403);
  assert.match(String(forbidden.message), /HTTP 403/);

  const limited = await of(429);
  assert.match(String(limited.message), /速率限制/);

  const broken = await of(503);
  assert.equal(broken.status, 503);
  assert.match(String(broken.message), /HTTP 503/);
});

test("D-B19 3c：probeDirect 网络层失败 → 没有 status，只有中文原因（超时说「请求超时」）", async () => {
  const { fetch: down } = makeFakeFetch([
    {
      match: () => true,
      response: () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    },
  ]);
  const network = await probeDirect(down);
  assert.equal(network.ok, false);
  assert.equal(network.status, undefined);
  assert.match(String(network.message), /连接 api.github.com 失败/);
  assert.match(String(network.message), /ENOTFOUND/);

  const { fetch: timedOut } = makeFakeFetch([
    {
      match: () => true,
      response: () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        throw error;
      },
    },
  ]);
  const timeout = await probeDirect(timedOut);
  assert.equal(timeout.status, undefined);
  assert.match(String(timeout.message), /请求超时/);
});

test("D-B19 3d：probeMirror 两项都通 → downloads + api + probedAt，且两次探测都不带令牌", async () => {
  const { fetch: fake, calls } = makeFakeFetch([
    { match: (u) => u.includes(MIRROR_TEST_URL), response: () => new Response("small file", { status: 200 }) },
    { match: (u) => u.includes(RATE_LIMIT_URL), response: () => jsonResponse({ resources: { core: {} } }) },
  ]);
  const capabilities = await probeMirror(MIRROR, fake);
  assert.equal(capabilities.configured, true);
  assert.equal(capabilities.downloads, true);
  assert.equal(capabilities.api, true);
  assert.equal(capabilities.error, undefined);
  assert.ok(!Number.isNaN(Date.parse(String(capabilities.probedAt))));

  const urls = calls.map((c) => c.url).sort();
  assert.deepEqual(urls, [`${MIRROR}${MIRROR_TEST_URL}`, `${MIRROR}${RATE_LIMIT_URL}`].sort());
  assert.ok(
    calls.every((c) => c.headers["authorization"] === undefined),
    "镜像探测绝不带令牌",
  );
});

test("D-B19 3e：probeMirror 只有 API 失败 → api:false 但不算整体不可用（无 error）", async () => {
  const { fetch: fake } = makeFakeFetch([
    { match: (u) => u.includes(MIRROR_TEST_URL), response: () => new Response("ok", { status: 200 }) },
    { match: (u) => u.includes(RATE_LIMIT_URL), response: () => new Response("no", { status: 403 }) },
  ]);
  const capabilities = await probeMirror(MIRROR, fake);
  assert.equal(capabilities.downloads, true);
  assert.equal(capabilities.api, false);
  assert.equal(capabilities.error, undefined);
});

test("D-B19 3f：probeMirror 两项都失败 → 中文原因里带状态码与镜像主机名", async () => {
  const { fetch: fake } = makeFakeFetch([
    { match: (u) => u.includes(MIRROR_TEST_URL), response: () => new Response("no", { status: 403 }) },
    { match: (u) => u.includes(RATE_LIMIT_URL), response: () => new Response("no", { status: 502 }) },
  ]);
  const capabilities = await probeMirror(MIRROR, fake);
  assert.equal(capabilities.downloads, false);
  assert.equal(capabilities.api, false);
  assert.match(String(capabilities.error), /ghfast\.top/);
  assert.match(String(capabilities.error), /下载 HTTP 403/);
  assert.match(String(capabilities.error), /API HTTP 502/);
});

test("D-B19 3g：probeMirror 网络层失败 → error 里是网络错误文字；空镜像 → configured:false 且不联网", async () => {
  const { fetch: fake } = makeFakeFetch([
    {
      match: () => true,
      response: () => {
        throw new Error("ECONNREFUSED");
      },
    },
  ]);
  const capabilities = await probeMirror(MIRROR, fake);
  assert.match(String(capabilities.error), /ECONNREFUSED/);

  const untouched = makeFakeFetch([]);
  const empty = await probeMirror("   ", untouched.fetch);
  assert.equal(empty.configured, false);
  assert.equal(empty.downloads, undefined);
  assert.equal(untouched.calls.length, 0);
});

/* ===================== 4. 镜像判据与设置读写 ===================== */

test("D-B19 4a：mirrorHostOf / isApiUrl / applyMirror 的边界", () => {
  assert.equal(mirrorHostOf(MIRROR), MIRROR_HOST);
  assert.equal(mirrorHostOf("https://ghfast.top"), MIRROR_HOST);
  assert.equal(mirrorHostOf(""), undefined);
  assert.equal(mirrorHostOf("不是地址"), undefined);
  assert.equal(mirrorHostOf(undefined), undefined);

  assert.equal(isApiUrl(`${RATE_LIMIT_URL}?x=1`), true);
  assert.equal(isApiUrl("https://github.com/a/b/archive/main.tar.gz"), false);
  assert.equal(isApiUrl("不是地址"), false);

  assert.equal(applyMirror("https://api.github.com/repos/a/b", MIRROR), `${MIRROR}https://api.github.com/repos/a/b`);
  assert.equal(
    applyMirror("https://api.github.com/repos/a/b", "https://ghfast.top"),
    "https://ghfast.top/https://api.github.com/repos/a/b",
  );
  assert.equal(applyMirror("https://skills.sh/api/search", MIRROR), "https://skills.sh/api/search");
  assert.equal(applyMirror("不是地址", MIRROR), "不是地址");
});

test("D-B19 4b：设置读写保留 mirrorCapabilities / directStatus；形状不对就丢弃，绝不报错", async () => {
  const ctx = hubCtx();
  assert.deepEqual(await readSettings(ctx), { version: 1 }, "文件不存在 → 只有 version");

  const file = settingsFilePath(ctx);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{ 这不是 JSON");
  assert.deepEqual(await readSettings(ctx), { version: 1 }, "坏 JSON 按「没设置」处理");

  const capabilities = {
    configured: true,
    downloads: true,
    api: false,
    probedAt: "2026-10-01T00:00:00.000Z",
    error: "API 不可用",
  };
  const direct = { ok: false, status: 403, message: "HTTP 403", checkedAt: "2026-10-01T00:00:01.000Z" };
  await fs.writeFile(
    file,
    JSON.stringify({ version: 1, githubMirror: MIRROR, mirrorCapabilities: capabilities, directStatus: direct }),
  );
  const read = await readSettings(ctx);
  assert.equal(read.githubMirror, MIRROR);
  assert.deepEqual(read.mirrorCapabilities, capabilities);
  assert.deepEqual(read.directStatus, direct);

  // 各种坏形状：整条丢弃，其余字段照常读
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      githubMirror: 123,
      mirrorCapabilities: { downloads: true },
      directStatus: { ok: "yes", checkedAt: "x" },
    }),
  );
  assert.deepEqual(await readSettings(ctx), { version: 1 }, "形状不对的字段全部丢弃");

  await fs.writeFile(file, JSON.stringify({ version: 1, githubMirror: MIRROR, directStatus: { ok: true } }));
  assert.deepEqual(await readSettings(ctx), { version: 1, githubMirror: MIRROR }, "缺 checkedAt 的直连状态丢弃");

  await fs.writeFile(file, JSON.stringify({ version: 1, mirrorCapabilities: { configured: false } }));
  const minimal = await readSettings(ctx);
  assert.deepEqual(minimal.mirrorCapabilities, { configured: false });
});

test("D-B19 4c：writeSettings 写入探测结果；清空时把镜像与探测结果一起清掉", async () => {
  const ctx = hubCtx();
  const written = await writeSettings(ctx, {
    mirror: MIRROR,
    mirrorCapabilities: { configured: true, downloads: true, api: true, probedAt: "2026-10-01T00:00:00.000Z" },
    directStatus: { ok: true, status: 200, checkedAt: "2026-10-01T00:00:00.000Z" },
  });
  assert.equal(written.githubMirror, MIRROR);
  assert.equal(written.mirrorCapabilities?.downloads, true);
  assert.equal(written.directStatus?.ok, true);
  assert.deepEqual(await readSettings(ctx), written, "写下去的要能原样读回来");

  // 直接传坏形状：写入前就被清洗掉（绝不让坏数据落盘）
  const sanitized = await writeSettings(ctx, {
    mirror: MIRROR,
    mirrorCapabilities: { configured: "yes" } as never,
    directStatus: { ok: true, checkedAt: "" } as never,
  });
  assert.equal(sanitized.mirrorCapabilities, undefined);
  assert.equal(sanitized.directStatus, undefined);

  const cleared = await writeSettings(ctx, {});
  assert.deepEqual(cleared, { version: 1 });
  assert.deepEqual(await readSettings(ctx), { version: 1 });
});

/* ===================== 5. 网络事件 ===================== */

test("D-B19 5a：api / download / search 各发一次事件，route 与 mirrorHost 如实填写", async () => {
  const entries = archiveEntries();
  const gz = tarGzOf(entries, "tools-main");
  const events: NetworkEvent[] = [];
  const { client } = clientOf(
    [
      {
        match: (u) => u.startsWith("https://api.github.com/"),
        response: () => jsonResponse({ default_branch: "main" }),
      },
      { match: (u) => u.includes(".tar.gz"), response: () => gzipResponse(gz) },
      { match: (u) => u.includes("raw.githubusercontent.com"), response: () => new Response("file", { status: 200 }) },
      { match: (u) => u.includes("skills.sh"), response: () => jsonResponse({ skills: [] }) },
    ],
    { mirror: MIRROR, events },
  );

  await client.defaultBranch("acme/tools");
  await client.downloadTarball("acme/tools", "main");
  await client.rawFile("acme/tools", "main", "SKILL.md");
  await client.searchSkillsSh("pdf");

  const kinds = events.map((e) => `${e.kind}:${e.route}`);
  assert.deepEqual(kinds, ["api:direct", "download:mirror", "download:mirror", "search:direct"]);
  const download = events.find((e) => e.kind === "download")!;
  assert.equal(download.mirrorHost, MIRROR_HOST);
  assert.equal(download.url, "https://github.com/acme/tools/archive/main.tar.gz", "事件里报原始地址，不是镜像地址");
  const search = events.find((e) => e.kind === "search")!;
  assert.equal(search.mirrorHost, undefined, "skills.sh 永不走镜像");
  assert.ok(search.url.startsWith("https://skills.sh/api/search"));
});

test("D-B19 5b：事件回调抛异常绝不影响请求本身", async () => {
  const gz = tarGzOf(archiveEntries(), "tools-main");
  const fake = makeFakeFetch([{ match: () => true, response: () => gzipResponse(gz) }]);
  const client = new GitHubClient({
    fetchImpl: fake.fetch,
    logger: makeLogger().logger,
    envTokenProvider: () => undefined,
    ghTokenProvider: async () => undefined,
    cacheAuth: false,
    onNetworkEvent: () => {
      throw new Error("监听器炸了");
    },
  });
  const result = await client.downloadTarball("acme/tools", "main");
  assert.equal(result.ref, "main");
});

/* ===================== 6. 路由接线 ===================== */

test("D-B19 6a：test-mirror 返回 { ok, ms, direct, mirror }（ok 仍是「下载可用」）", async () => {
  const env = await buildRemoteEnv({
    routes: [
      { match: (u) => u.includes(MIRROR_TEST_URL), response: () => new Response("small", { status: 200 }) },
      {
        match: (u) => u.startsWith("https://api.github.com/"),
        response: () => jsonResponse({ resources: { core: {} } }),
      },
      { match: (u) => u.startsWith(MIRROR), response: () => jsonResponse({ resources: { core: {} } }) },
    ],
  });
  const result = await env.call("POST skills/settings/test-mirror", { body: { githubMirror: MIRROR } });
  assert.equal(result.ok, true);
  assert.equal(typeof result.ms, "number");
  assert.equal((result.direct as { ok: boolean }).ok, true);
  const mirror = result.mirror as { configured: boolean; downloads: boolean; api: boolean };
  assert.equal(mirror.configured, true);
  assert.equal(mirror.downloads, true);
  assert.equal(mirror.api, true);

  // 下载不通时 ok 仍为 false（只表示下载），但 API 能力照样报告出来
  const partial = await buildRemoteEnv({
    routes: [
      { match: (u) => u.includes(MIRROR_TEST_URL), response: () => new Response("no", { status: 403 }) },
      { match: (u) => u.startsWith("https://api.github.com/"), response: () => jsonResponse({}) },
      { match: (u) => u.startsWith(MIRROR), response: () => jsonResponse({}) },
    ],
  });
  const partialResult = await partial.call("POST skills/settings/test-mirror", { body: { githubMirror: MIRROR } });
  assert.equal(partialResult.ok, false);
  const partialMirror = partialResult.mirror as { downloads: boolean; api: boolean };
  assert.equal(partialMirror.downloads, false);
  assert.equal(partialMirror.api, true);
});

test("D-B19 6b：保存镜像时顺带探测并写回设置；探测失败也不影响保存成功", async () => {
  const env = await buildRemoteEnv({
    routes: [
      { match: (u) => u.includes(MIRROR_TEST_URL), response: () => new Response("small", { status: 200 }) },
      {
        match: (u) => u.startsWith("https://api.github.com/"),
        response: () => jsonResponse({ resources: { core: {} } }),
      },
      { match: (u) => u.startsWith(MIRROR), response: () => jsonResponse({ resources: { core: {} } }) },
    ],
  });
  const saved = await env.call("POST skills/settings", { body: { githubMirror: MIRROR } });
  assert.equal(saved.githubMirror, MIRROR);
  assert.equal((saved.directStatus as { ok: boolean }).ok, true);
  assert.equal((saved.mirrorCapabilities as { downloads: boolean }).downloads, true);

  const onDisk = await env.readSettings();
  assert.equal(onDisk.githubMirror, MIRROR);
  assert.equal((onDisk.directStatus as { ok: boolean }).ok, true, "探测结果要写回设置");
  assert.equal((onDisk.mirrorCapabilities as { api: boolean }).api, true);

  // 探测全网络失败：**保存照常成功**，探测结论落成「不可用 + 中文原因」（不是抛错、不是空）
  const broken = await buildRemoteEnv({
    routes: [
      {
        match: () => true,
        response: () => {
          throw new Error("ECONNREFUSED");
        },
      },
    ],
  });
  const savedAnyway = await broken.call("POST skills/settings", { body: { githubMirror: MIRROR } });
  assert.equal(savedAnyway.githubMirror, MIRROR, "探测失败不能让保存失败");
  const brokenDisk = await broken.readSettings();
  assert.equal(brokenDisk.githubMirror, MIRROR);
  const brokenCapabilities = brokenDisk.mirrorCapabilities as { downloads: boolean; api: boolean; error?: string };
  assert.equal(brokenCapabilities.downloads, false);
  assert.equal(brokenCapabilities.api, false);
  assert.match(String(brokenCapabilities.error), /ECONNREFUSED/);
  assert.equal((brokenDisk.directStatus as { ok: boolean }).ok, false, "直连探测失败也要如实记录");
});

test("D-B19 6c：清空镜像时把探测结果一并清掉（坏数据不残留）", async () => {
  const env = await buildRemoteEnv({
    routes: [
      { match: (u) => u.includes(MIRROR_TEST_URL), response: () => new Response("small", { status: 200 }) },
      { match: (u) => u.startsWith("https://api.github.com/"), response: () => jsonResponse({}) },
      { match: (u) => u.startsWith(MIRROR), response: () => jsonResponse({}) },
    ],
  });
  await env.call("POST skills/settings", { body: { githubMirror: MIRROR } });
  assert.ok((await env.readSettings()).mirrorCapabilities !== undefined);

  const cleared = await env.call("POST skills/settings", { body: { githubMirror: "" } });
  assert.equal(cleared.githubMirror, undefined);
  const onDisk = await env.readSettings();
  assert.equal(onDisk.githubMirror, undefined);
  assert.equal(onDisk.mirrorCapabilities, undefined);
  assert.equal(onDisk.directStatus, undefined);
});
