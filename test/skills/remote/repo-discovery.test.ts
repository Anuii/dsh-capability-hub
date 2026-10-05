/**
 * 汇总发现（D-B16）：发现缓存、已安装现算、逐仓库失败隔离、增删改只动该仓库、子目录校验。
 * 全程用假 fetch，不联网；所有落盘都在临时目录。
 */
import * as YAML from "yaml";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createSkillsRemoteModule } from "../../../src/skills/remote/module.ts";
import { composeDiscoveryView, discoveryFilePath } from "../../../src/skills/remote/repo-discovery.ts";
import { normalizeSubPath, reposFilePath } from "../../../src/skills/remote/repos.ts";
import type { FakeFetchRoute } from "./helpers.ts";
import { makeCtx, makeFakeApi, makeFakeFetch, makeLogger, makeTempDir, tarGzOf, writeTree } from "./helpers.ts";
import { skillFixture } from "./tarfixture.ts";

type Routes = Record<string, (r: never) => Promise<unknown>>;

interface Skill {
  repo: string;
  dirName: string;
  skillPath: string;
  ref?: string;
  installedId?: string;
  name?: string;
}
interface RepoView {
  repo: string;
  ref?: string;
  subPath?: string;
  scannedAt?: string;
  skillCount?: number;
  error?: string;
  stale?: boolean;
  preset: boolean;
}
interface View {
  cached: boolean;
  lastScannedAt?: string;
  repos: RepoView[];
  skills: Skill[];
}

const ARCHIVES: Record<string, Buffer> = {
  "anthropics/skills": tarGzOf(
    [
      ...skillFixture("document", "pdf", { description: "PDF" }),
      ...skillFixture("design", "canvas", { description: "画布" }),
    ],
    "skills-main",
  ),
  "mattpocock/skills": tarGzOf(
    [
      ...skillFixture("engineering", "tdd", { description: "测试驱动" }),
      ...skillFixture("productivity", "grilling", { description: "拷问" }),
    ],
    "skills-main",
  ),
  "vercel-labs/skills": tarGzOf([...skillFixture("tools", "find-skills", { description: "找技能" })], "skills-main"),
  "acme/extra": tarGzOf(
    [...skillFixture("a", "one", { description: "一" }), ...skillFixture("b", "two", { description: "二" })],
    "extra-main",
  ),
};

/** codeload 路由：按仓库返回归档；没登记的仓库 404（= 该仓库扫描失败） */
function codeloadRoutes(
  downloads: string[],
  options: { delayMs?: number; inFlight?: { now: number; max: number } } = {},
): FakeFetchRoute[] {
  return [
    {
      match: (u) => u.includes("api.github.com/repos/"),
      response: () =>
        new Response(JSON.stringify({ default_branch: "main" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    },
    {
      match: (u) => u.includes("codeload.github.com/"),
      response: async (u) => {
        const repo = u.split("codeload.github.com/")[1]!.split("/tar.gz/")[0]!;
        downloads.push(repo);
        if (options.inFlight) {
          options.inFlight.now++;
          options.inFlight.max = Math.max(options.inFlight.max, options.inFlight.now);
        }
        if (options.delayMs) await new Promise((done) => setTimeout(done, options.delayMs));
        if (options.inFlight) options.inFlight.now--;
        const archive = ARCHIVES[repo];
        if (archive === undefined) return new Response("not found", { status: 404 });
        return new Response(new Uint8Array(archive), { status: 200 });
      },
    },
  ];
}

async function build(
  options: {
    routes?: FakeFetchRoute[];
    local?: { dirName: string; name?: string }[];
    envToken?: string;
    hubHome?: string;
  } = {},
) {
  const home = makeTempDir();
  const hubHome = options.hubHome ?? makeTempDir();
  const ctx = makeCtx({ homeDir: home, hubHome, logger: makeLogger().logger });
  const skills = makeFakeApi({
    skills: (options.local ?? []).map((s) => ({
      rootId: "user-agents",
      dirName: s.dirName,
      name: s.name ?? s.dirName,
      path: path.join(home, ".agents", "skills", s.dirName),
    })),
  });
  const fake = makeFakeFetch(options.routes ?? []);
  const module = createSkillsRemoteModule(
    ctx,
    { skills, yaml: YAML },
    {
      fetchImpl: fake.fetch,
      envTokenProvider: () => options.envToken,
      ghTokenProvider: async () => undefined,
      cacheAuth: false,
    },
  );
  const call = (key: string, req: { query?: Record<string, string>; body?: unknown } = {}) => {
    const handler = (module.routes as Routes)[key];
    if (!handler) throw new Error("路由不存在：" + key);
    return handler({
      query: req.query ?? {},
      body: req.body,
      signal: new AbortController().signal,
    } as never) as Promise<Record<string, unknown>>;
  };
  return { home, hubHome, ctx, skills, fake, call };
}

test("从未扫描：GET 只读、不联网，cached=false，列出预置仓库", async () => {
  const downloads: string[] = [];
  const env = await build({ routes: codeloadRoutes(downloads) });
  const view = (await env.call("GET skills/discovery")) as unknown as View;
  assert.equal(view.cached, false);
  assert.equal(view.lastScannedAt, undefined);
  assert.equal(view.skills.length, 0);
  assert.ok(view.repos.length >= 4);
  assert.ok(view.repos.every((r) => r.scannedAt === undefined));
  assert.equal(env.fake.calls.length, 0, "GET 不得联网");
});

test("全部刷新：逐仓库独立成败，汇总技能带仓库与分支，已安装现算且不进缓存", async () => {
  const downloads: string[] = [];
  const env = await build({ routes: codeloadRoutes(downloads), local: [{ dirName: "tdd" }] });
  const view = (await env.call("POST skills/discovery/refresh", { body: {} })) as unknown as View;
  assert.equal(view.cached, true);
  assert.ok(view.lastScannedAt);
  const failed = view.repos.find((r) => r.repo === "ComposioHQ/awesome-claude-skills")!;
  assert.ok(failed.error && failed.error.length > 0, "没登记归档的仓库应失败并记原因");
  assert.equal(failed.skillCount, undefined);
  assert.equal(view.repos.find((r) => r.repo === "mattpocock/skills")!.skillCount, 2);
  const tdd = view.skills.find((s) => s.dirName === "tdd")!;
  assert.equal(tdd.repo, "mattpocock/skills");
  assert.equal(tdd.ref, "main");
  assert.equal(tdd.installedId, "user-agents:tdd");
  assert.equal(view.skills.find((s) => s.dirName === "grilling")!.installedId, undefined);
  assert.ok(view.skills.some((s) => s.repo === "anthropics/skills" && s.dirName === "pdf"));

  const raw = await fs.readFile(discoveryFilePath(env.ctx), "utf8");
  assert.ok(!raw.includes("installedId"), "缓存里不能有「已安装」");

  // 本机新装一个：不重新扫描，GET 立刻反映
  env.skills.skills.push({ rootId: "user-agents", dirName: "pdf", name: "pdf", path: path.join(env.home, "pdf") });
  const before = env.fake.calls.length;
  const again = (await env.call("GET skills/discovery")) as unknown as View;
  assert.equal(env.fake.calls.length, before, "GET 不联网");
  assert.equal(again.skills.find((s) => s.dirName === "pdf")!.installedId, "user-agents:pdf");
});

test("扫描并发不超过 2", async () => {
  const downloads: string[] = [];
  const inFlight = { now: 0, max: 0 };
  const env = await build({ routes: codeloadRoutes(downloads, { delayMs: 30, inFlight }) });
  await env.call("POST skills/discovery/refresh", { body: {} });
  assert.ok(downloads.length >= 4);
  assert.ok(inFlight.max <= 2, "同时下载数 " + inFlight.max);
});

test("只刷新指定仓库；不在列表里的仓库 NOT_FOUND", async () => {
  const downloads: string[] = [];
  const env = await build({ routes: codeloadRoutes(downloads) });
  const view = (await env.call("POST skills/discovery/refresh", {
    body: { repos: ["MATTPOCOCK/skills"] },
  })) as unknown as View;
  assert.deepEqual(downloads, ["mattpocock/skills"]);
  assert.equal(view.repos.filter((r) => r.scannedAt !== undefined).length, 1);
  await assert.rejects(
    env.call("POST skills/discovery/refresh", { body: { repos: ["nobody/here"] } }),
    /不在仓库列表中/,
  );
});

test("加入仓库：只补扫这一个；链接里的分支与子目录被拆出；扫描失败不让 add 失败", async () => {
  const downloads: string[] = [];
  const env = await build({ routes: codeloadRoutes(downloads) });
  const added = await env.call("POST skills/repos/add", {
    body: { repo: "https://github.com/acme/extra/tree/main/skills/b" },
  });
  assert.deepEqual(downloads, ["acme/extra"]);
  const record = added.repo as { repo: string; ref?: string; subPath?: string };
  assert.deepEqual(record, { repo: "acme/extra", preset: false, ref: "main", subPath: "skills/b" });
  const view = added.discovery as View;
  assert.deepEqual(
    view.skills.map((s) => s.dirName),
    ["two"],
    "子目录只发现 b 下的技能",
  );

  const missing = await env.call("POST skills/repos/add", { body: { repo: "ghost/none" } });
  const ghost = (missing.discovery as View).repos.find((r) => r.repo === "ghost/none")!;
  assert.ok(ghost.error, "扫描失败记在仓库条目上");
});

test("修改分支或子目录：变了才重扫该仓库；没变不联网", async () => {
  const downloads: string[] = [];
  const env = await build({ routes: codeloadRoutes(downloads) });
  await env.call("POST skills/repos/add", { body: { repo: "acme/extra", ref: "main" } });
  assert.equal(
    ((await env.call("GET skills/discovery")) as unknown as View).skills.filter((s) => s.repo === "acme/extra").length,
    2,
  );
  downloads.length = 0;
  const changed = await env.call("POST skills/repos/update", { body: { repo: "acme/extra", subPath: "/skills/a/" } });
  assert.equal(changed.changed, true);
  assert.deepEqual(downloads, ["acme/extra"]);
  assert.deepEqual(
    (changed.discovery as View).skills.filter((s) => s.repo === "acme/extra").map((s) => s.dirName),
    ["one"],
  );
  downloads.length = 0;
  const same = await env.call("POST skills/repos/update", { body: { repo: "acme/extra", subPath: "skills/a" } });
  assert.equal(same.changed, false);
  assert.equal(downloads.length, 0);
  // 清空子目录 = 整个仓库；预置仓库也能改，preset 标记保留
  const cleared = await env.call("POST skills/repos/update", { body: { repo: "acme/extra", subPath: "" } });
  assert.equal((cleared.repo as { subPath?: string }).subPath, undefined);
  const preset = await env.call("POST skills/repos/update", { body: { repo: "anthropics/skills", ref: "" } });
  assert.deepEqual(preset.repo, { repo: "anthropics/skills", preset: true });
  await assert.rejects(env.call("POST skills/repos/update", { body: { repo: "acme/extra" } }), /至少修改/);
  await assert.rejects(env.call("POST skills/repos/update", { body: { repo: "nobody/here", ref: "x" } }), /不在列表中/);
});

test("移出仓库：缓存条目一起删掉，汇总里不再有它的技能", async () => {
  const downloads: string[] = [];
  const env = await build({ routes: codeloadRoutes(downloads) });
  await env.call("POST skills/discovery/refresh", { body: {} });
  const removed = await env.call("POST skills/repos/remove", { body: { repo: "mattpocock/skills" } });
  const view = removed.discovery as View;
  assert.ok(!view.repos.some((r) => r.repo === "mattpocock/skills"));
  assert.ok(!view.skills.some((s) => s.repo === "mattpocock/skills"));
  const raw = JSON.parse(await fs.readFile(discoveryFilePath(env.ctx), "utf8")) as { repos: Record<string, unknown> };
  assert.equal(raw.repos["mattpocock/skills"], undefined);
});

test("子目录校验：拒绝 ..、绝对路径、盘符与反斜杠；首尾斜杠被去掉", () => {
  assert.equal(normalizeSubPath(" /skills/x/ "), "skills/x");
  assert.equal(normalizeSubPath(""), undefined);
  assert.equal(normalizeSubPath(undefined), undefined);
  for (const bad of ["../x", "a/../b", "C:/x", "a\\b", "a//b"]) {
    assert.throws(() => normalizeSubPath(bad), /子目录/, bad);
  }
});

test("兼容：旧 repos.json 没有 subPath 照常读；坏的缓存文件当作空", async () => {
  const hubHome = makeTempDir();
  const ctx = makeCtx({ homeDir: makeTempDir(), hubHome });
  await writeTree(path.dirname(reposFilePath(ctx)), {
    "repos.json": JSON.stringify({ version: 1, repos: [{ repo: "acme/extra", ref: "main", preset: false, extra: 1 }] }),
    "discovery.json": "{ not json",
  });
  const downloads: string[] = [];
  const env = await build({ routes: codeloadRoutes(downloads), hubHome });
  const list = await env.call("GET skills/repos");
  assert.deepEqual(list.repos, [{ repo: "acme/extra", ref: "main", preset: false }]);
  const view = (await env.call("GET skills/discovery")) as unknown as View;
  assert.equal(view.cached, false);
  await env.call("POST skills/discovery/refresh", { body: {} });
  assert.equal(((await env.call("GET skills/discovery")) as unknown as View).skills.length, 2);
});

test("令牌不进缓存与错误信息", async () => {
  const SECRET = "ghp_" + "A".repeat(36);
  const routes: FakeFetchRoute[] = [
    { match: (u) => u.includes("api.github.com/repos/"), response: () => new Response("{}", { status: 200 }) },
    {
      match: (u) => u.includes("codeload.github.com/"),
      response: () => new Response("upstream says " + SECRET, { status: 500 }),
    },
  ];
  const env = await build({ routes, envToken: SECRET });
  const view = await env.call("POST skills/discovery/refresh", { body: {} });
  assert.ok(!JSON.stringify(view).includes(SECRET));
  const raw = await fs.readFile(discoveryFilePath(env.ctx), "utf8");
  assert.ok(!raw.includes(SECRET));
});

test("composeDiscoveryView：stale 标记、未扫描仓库、lastScannedAt 取最新", () => {
  const view = composeDiscoveryView(
    [
      { repo: "a/one", ref: "dev", preset: false },
      { repo: "b/two", preset: true },
      { repo: "c/three", preset: false },
    ],
    {
      version: 1,
      repos: {
        "a/one": {
          repo: "a/one",
          ref: "main",
          resolvedRef: "main",
          scannedAt: "2026-10-01T00:00:00.000Z",
          skills: [{ skillPath: "x/SKILL.md", dirName: "x" }],
        },
        "b/two": { repo: "b/two", scannedAt: "2026-10-03T00:00:00.000Z", skills: [], error: "失败了" },
        "gone/repo": {
          repo: "gone/repo",
          scannedAt: "2026-10-09T00:00:00.000Z",
          skills: [{ skillPath: "g/SKILL.md", dirName: "g" }],
        },
      },
    },
    (skill) => (skill.dirName === "x" ? "user-agents:x" : undefined),
  );
  assert.equal(view.cached, true);
  assert.equal(view.lastScannedAt, "2026-10-03T00:00:00.000Z", "不在列表里的缓存条目不参与");
  assert.equal(view.repos[0]!.stale, true);
  assert.equal(view.repos[1]!.error, "失败了");
  assert.equal(view.repos[2]!.scannedAt, undefined);
  assert.deepEqual(view.skills, [
    { skillPath: "x/SKILL.md", dirName: "x", repo: "a/one", ref: "main", installedId: "user-agents:x" },
  ]);
});
