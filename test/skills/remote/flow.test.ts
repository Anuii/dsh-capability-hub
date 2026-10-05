import * as YAML from "yaml";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createSkillsRemoteModule } from "../../../src/skills/remote/module.ts";
import { lockFilePath, sourcesFilePath } from "../../../src/skills/remote/lockstore.ts";
import type { FakeApi } from "./helpers.ts";
import {
  archiveInstalledHash,
  jsonResponse,
  localInstalledHash,
  makeCtx,
  makeFakeApi,
  makeFakeFetch,
  makeLogger,
  makeTempDir,
  readTree,
  tarGzOf,
  withRootPaths,
  writeTree,
} from "./helpers.ts";
import { skillFixture } from "./tarfixture.ts";

const SKILL_MD_V1 = "---\nname: foo\ndescription: v1\n---\n\n# foo\n\nv1\n";
const YAML_V1 = "name: foo\n";

async function buildModule(
  options: {
    skills?: NonNullable<Parameters<typeof makeFakeApi>[0]>["skills"];
    rootPaths?: Record<string, string>;
    routes?: Parameters<typeof makeFakeFetch>[0];
    home?: string;
    hubHome?: string;
    profileName?: string;
    failMoveToTrashOnce?: boolean;
    failSetEnabledOnce?: boolean;
    disableProjectRoots?: boolean;
    envToken?: string;
  } = {},
) {
  const home = options.home ?? makeTempDir();
  const hubHome = options.hubHome ?? makeTempDir();
  const sink: ReturnType<typeof makeLogger>["sink"] = [];
  const { logger } = makeLogger(sink);
  const ctx = makeCtx({ homeDir: home, hubHome, logger, profileName: options.profileName ?? "capability-hub-dev" });
  const skills = makeFakeApi({
    skills: options.skills ?? [],
    failMoveToTrashOnce: options.failMoveToTrashOnce,
    failSetEnabledOnce: options.failSetEnabledOnce,
  });
  if (options.disableProjectRoots) {
    skills.rootPath = () => undefined;
  }
  if (options.rootPaths) withRootPaths(skills, options.rootPaths);
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
  return { home, hubHome, ctx, skills: skills as FakeApi, fake, module, sink };
}

function call(
  module: { routes: Record<string, (r: never) => Promise<unknown>> },
  key: string,
  req: { query?: Record<string, string>; body?: unknown } = {},
) {
  const handler = module.routes[key];
  if (!handler) throw new Error(`路由不存在：${key}`);
  return handler({ query: req.query ?? {}, body: req.body, signal: new AbortController().signal } as never) as Promise<
    Record<string, unknown>
  >;
}

async function seedLocalSkill(root: string, dirName: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, dirName);
  await writeTree(dir, files);
  return dir;
}

test("安装：写盘、写来源，lock 的 skillFolderHash = 上游目录哈希", async () => {
  const userAgents = makeTempDir();
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "placeholder", path: path.join(userAgents, "placeholder") }],
    rootPaths: { "user-agents": userAgents },
    routes: [
      { match: (u) => u.includes("/repos/"), response: () => jsonResponse({ default_branch: "main" }) },
      {
        match: (u) => u.includes("/tar.gz/main"),
        response: () =>
          new Response(
            new Uint8Array(
              tarGzOf([
                ...skillFixture("productivity", "grilling", { description: "拷问" }),
                ...skillFixture("engineering", "tdd", { description: "测试驱动" }),
              ]),
            ),
            { status: 200 },
          ),
      },
    ],
  });

  const result = await call(env.module as never, "POST skills/install", {
    body: { repo: "mattpocock/skills", skillPaths: ["skills/productivity/grilling/SKILL.md"], target: "user-agents" },
  });
  const results = result.results as { ok: boolean; skillId?: string; skillPath: string }[];
  assert.equal(results.length, 1);
  assert.equal(results[0]!.ok, true);
  assert.equal(results[0]!.skillId, "user-agents:grilling");

  const onDisk = await readTree(path.join(userAgents, "grilling"));
  assert.ok(onDisk["SKILL.md"]?.includes("name: grilling"));
  assert.ok(onDisk["agents/openai.yaml"]);

  const lock = JSON.parse(await fs.readFile(lockFilePath(env.ctx), "utf8"));
  assert.equal(lock.version, 3);
  const entry = lock.skills.grilling;
  assert.equal(entry.source, "mattpocock/skills");
  assert.equal(entry.sourceType, "github");
  assert.equal(entry.sourceUrl, "https://github.com/mattpocock/skills.git");
  assert.equal(entry.skillPath, "skills/productivity/grilling/SKILL.md");
  assert.equal(entry.installedAt, entry.updatedAt);
  assert.match(entry.installedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  // 关键：写入的是「上游目录内容哈希」
  const upstream = archiveInstalledHash(tarGzOf(skillFixture("productivity", "grilling", { description: "拷问" })));
  assert.ok(entry.skillFolderHash.length === 64);
  assert.equal(entry.skillFolderHash, upstream, "安装写入的必须是上游目录哈希（非本地值）");
  assert.ok(env.sink.length > 0, "应有中文日志");
});

test("安装：目标已存在时该项失败并说明，不覆盖", async () => {
  const userAgents = makeTempDir();
  const existing = await seedLocalSkill(userAgents, "grilling", {
    "SKILL.md": "---\nname: grilling\ndescription: 本地的\n---\n",
  });
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "grilling", path: existing }],
    rootPaths: { "user-agents": userAgents },
    routes: [
      { match: (u) => u.includes("/repos/"), response: () => jsonResponse({ default_branch: "main" }) },
      {
        match: (u) => u.includes("/tar.gz/"),
        response: () => new Response(new Uint8Array(tarGzOf(skillFixture("x", "grilling"))), { status: 200 }),
      },
    ],
  });
  const result = await call(env.module as never, "POST skills/install", {
    body: { repo: "a/b", skillPaths: ["skills/x/grilling/SKILL.md"], target: "user-agents" },
  });
  const results = result.results as { ok: boolean; message?: string }[];
  assert.equal(results[0]!.ok, false);
  assert.match(results[0]!.message!, /已存在/);
  const stillLocal = await fs.readFile(path.join(existing, "SKILL.md"), "utf8");
  assert.match(stillLocal, /本地的/, "原有内容必须保持不动");
  // lock 不应写入
  await assert.rejects(fs.stat(lockFilePath(env.ctx)));
});

test("安装到 project-* 需要 workspace", async () => {
  const env = await buildModule({ rootPaths: { "project-agents": makeTempDir() }, disableProjectRoots: false });
  await assert.rejects(
    call(env.module as never, "POST skills/install", {
      body: { repo: "a/b", skillPaths: ["SKILL.md"], target: "project-agents" },
    }),
    /workspace/,
  );
  // 根存在但为空（skills-local 对未就绪的根返回空串）→ 也按「找不到根」处理
  const missing = await buildModule({});
  missing.skills.rootPath = () => "";
  await assert.rejects(
    call(missing.module as never, "POST skills/install", {
      body: { repo: "a/b", skillPaths: ["SKILL.md"], target: "user-dsh" },
    }),
    /找不到目标技能根/,
  );
});

test("安装到 user-dsh 写 sources.json 而非 lock", async () => {
  const userDsh = makeTempDir();
  const env = await buildModule({
    rootPaths: { "user-dsh": userDsh },
    routes: [
      {
        match: (u) => u.includes("/tar.gz/"),
        response: () =>
          new Response(new Uint8Array(tarGzOf(skillFixture("x", "tool", { description: "工具" }))), { status: 200 }),
      },
    ],
  });
  const result = await call(env.module as never, "POST skills/install", {
    body: { repo: "me/tools", ref: "v1", skillPaths: ["skills/x/tool"], target: "user-dsh" },
  });
  assert.equal((result.results as { ok: boolean }[])[0]!.ok, true);
  const sources = JSON.parse(await fs.readFile(sourcesFilePath(env.ctx), "utf8"));
  assert.equal(sources.entries["user-dsh/tool"].repo, "me/tools");
  assert.equal(sources.entries["user-dsh/tool"].ref, "v1");
  await assert.rejects(fs.stat(lockFilePath(env.ctx)), "lock 不应被创建");
});

test("登记：skillFolderHash 记为本地目录当前哈希，installedAt/updatedAt 为现在", async () => {
  const userAgents = makeTempDir();
  const dir = await seedLocalSkill(userAgents, "lyco", {
    "SKILL.md": "---\nname: lyco\ndescription: d\n---\n",
    "README.md": "r",
  });
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "lyco", path: dir, name: "lyco" }],
    rootPaths: { "user-agents": userAgents },
  });
  const result = await call(env.module as never, "POST skills/sources/register", {
    body: { skillId: "user-agents:lyco", repo: "https://github.com/lilyco-42/lyco-skill", skillPath: "SKILL.md" },
  });
  const entry = result.entry as { repo: string; skillFolderHash: string; store: string };
  assert.equal(entry.repo, "lilyco-42/lyco-skill");
  assert.equal(entry.store, "skill-lock");

  const lock = JSON.parse(await fs.readFile(lockFilePath(env.ctx), "utf8"));
  assert.equal(lock.skills["lyco"].skillFolderHash, await localInstalledHash(dir));
  assert.equal(lock.skills["lyco"].skillPath, "SKILL.md");
});

test("注销：删除条目；不存在时报 NOT_FOUND", async () => {
  const userAgents = makeTempDir();
  const dir = await seedLocalSkill(userAgents, "lyco", { "SKILL.md": "---\nname: lyco\ndescription: d\n---\n" });
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "lyco", path: dir, name: "lyco" }],
    rootPaths: { "user-agents": userAgents },
  });
  await call(env.module as never, "POST skills/sources/register", {
    body: { skillId: "user-agents:lyco", repo: "a/b" },
  });
  const listed = await call(env.module as never, "GET skills/sources", { query: {} });
  assert.equal((listed.entries as unknown[]).length, 1);
  await call(env.module as never, "POST skills/sources/unregister", { body: { skillId: "user-agents:lyco" } });
  const after = await call(env.module as never, "GET skills/sources", { query: {} });
  assert.equal((after.entries as unknown[]).length, 0);
  await assert.rejects(
    call(env.module as never, "POST skills/sources/unregister", { body: { skillId: "user-agents:lyco" } }),
    /没有登记来源/,
  );
});

test("来源推测：仓库同名匹配 + 目录内链接扫描，置信度与中文 reason", async () => {
  const userAgents = makeTempDir();
  const named = await seedLocalSkill(userAgents, "anthropics", {
    "SKILL.md": "---\nname: anthropics\ndescription: d\n---\n",
  });
  const linked = await seedLocalSkill(userAgents, "lyco", {
    "SKILL.md": "---\nname: lyco\ndescription: d\n---\n",
    "install.ps1":
      '$Repo = "lilyco-42/lyco-skill"\n# see https://raw.githubusercontent.com/lilyco-42/lyco-skill/main/docs/logo.png\n',
  });
  const env = await buildModule({
    skills: [
      { rootId: "user-agents", dirName: "anthropics", path: named, name: "anthropics" },
      { rootId: "user-agents", dirName: "lyco", path: linked, name: "lyco" },
    ],
    rootPaths: { "user-agents": userAgents },
  });
  const result = await call(env.module as never, "POST skills/sources/discover", { body: {} });
  const candidates = result.candidates as {
    skillId: string;
    repo: string;
    confidence: string;
    reason: string;
    skillPath: string;
  }[];
  const lyco = candidates.find((c) => c.skillId === "user-agents:lyco")!;
  assert.equal(lyco.repo, "lilyco-42/lyco-skill");
  // FIX-6（D-2）：本用例的技能目录是普通临时目录（不在任何 git 工作区里），
  // 因此「技能在仓库内的位置」算不出来 → 置信度降为 low，skillPath 退回「<目录名>/SKILL.md」。
  // 能确定位置时（本机就是该仓库的克隆）仍是 high，见 fix6-sources.test.ts。
  assert.equal(lyco.confidence, "low");
  assert.equal(lyco.skillPath, "lyco/SKILL.md");
  assert.match(lyco.reason, /技能目录内的文件里出现了/);
  assert.match(lyco.reason, /install\.ps1/);
  // 预置仓库里没有名字叫 anthropics 的仓库（anthropics/skills 的 repo 名是 skills），所以不该误报
  assert.ok(!candidates.some((c) => c.skillId === "user-agents:anthropics"), "不应把 owner 名误当仓库名");

  // 只返回候选，不登记
  assert.equal((await call(env.module as never, "GET skills/sources", { query: {} })).entries instanceof Array, true);
  assert.equal(((await call(env.module as never, "GET skills/sources", { query: {} })).entries as unknown[]).length, 0);
});

test("来源推测：磁盘上的预置仓库同名目录会被标为中置信候选", async () => {
  const userAgents = makeTempDir();
  const dir = await seedLocalSkill(userAgents, "skills", { "SKILL.md": "---\nname: skills\ndescription: d\n---\n" });
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "skills", path: dir, name: "skills" }],
    rootPaths: { "user-agents": userAgents },
  });
  const result = await call(env.module as never, "POST skills/sources/discover", { body: {} });
  const candidates = result.candidates as { repo: string; confidence: string; reason: string }[];
  assert.ok(candidates.some((c) => c.repo === "anthropics/skills" && c.confidence === "medium"));
});

test("检查更新：无来源 → no-source；上游一致 → up-to-date；不一致 → update-available", async () => {
  const userAgents = makeTempDir();
  const grillingDir = await seedLocalSkill(userAgents, "grilling", {
    "SKILL.md": SKILL_MD_V1,
    "agents/openai.yaml": YAML_V1,
  });
  const orphanDir = await seedLocalSkill(userAgents, "no-source-skill", {
    "SKILL.md": "---\nname: no-source-skill\ndescription: d\n---\n",
  });

  const upstreamGz = tarGzOf(skillFixture("productivity", "grilling", { description: "v1", extraFiles: {} }));
  // 上游与本地一致：直接写 lock 记录 = 上游哈希
  const matchingHash = archiveInstalledHash(upstreamGz);

  const env = await buildModule({
    skills: [
      { rootId: "user-agents", dirName: "grilling", path: grillingDir, name: "grilling" },
      { rootId: "user-agents", dirName: "no-source-skill", path: orphanDir, name: "no-source-skill" },
    ],
    rootPaths: { "user-agents": userAgents },
    routes: [
      { match: (u) => u.includes("/repos/"), response: () => jsonResponse({ default_branch: "main" }) },
      {
        match: (u) => u.includes("/tar.gz/"),
        response: () => new Response(new Uint8Array(upstreamGz), { status: 200 }),
      },
    ],
  });
  await fs.mkdir(path.dirname(lockFilePath(env.ctx)), { recursive: true });
  await fs.writeFile(
    lockFilePath(env.ctx),
    JSON.stringify({
      version: 3,
      skills: {
        grilling: {
          source: "mattpocock/skills",
          sourceType: "github",
          sourceUrl: "https://github.com/mattpocock/skills.git",
          skillPath: "skills/productivity/grilling/SKILL.md",
          skillFolderHash: matchingHash,
          installedAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      },
    }),
  );

  const same = await call(env.module as never, "POST skills/updates/check", { body: {} });
  const byId = new Map((same.results as { skillId: string; status: string }[]).map((r) => [r.skillId, r.status]));
  assert.equal(byId.get("user-agents:grilling"), "up-to-date");
  assert.equal(byId.get("user-agents:no-source-skill"), "no-source");
  assert.equal(same.auth, "anonymous");
  assert.equal(env.fake.calls.filter((c) => c.url.includes("codeload")).length, 1, "同一仓库只下载一次");

  // 改掉记录值 → 变成 update-available
  const lock = JSON.parse(await fs.readFile(lockFilePath(env.ctx), "utf8"));
  lock.skills.grilling.skillFolderHash = "0".repeat(64);
  await fs.writeFile(lockFilePath(env.ctx), JSON.stringify(lock));
  const changed = await call(env.module as never, "POST skills/updates/check", {
    body: { ids: ["user-agents:grilling"] },
  });
  assert.equal((changed.results as { status: string }[])[0]!.status, "update-available");
  assert.match((changed.results as { message?: string }[])[0]!.message!, /内容哈希不一致/);
});

test("检查更新：上游找不到该技能 → error（逐项，不影响其他技能）", async () => {
  const userAgents = makeTempDir();
  const dir = await seedLocalSkill(userAgents, "gone", { "SKILL.md": SKILL_MD_V1 });
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "gone", path: dir, name: "gone" }],
    rootPaths: { "user-agents": userAgents },
    routes: [
      {
        match: (u) => u.includes("/tar.gz/"),
        response: () => new Response(new Uint8Array(tarGzOf(skillFixture("x", "other"))), { status: 200 }),
      },
    ],
  });
  await fs.mkdir(path.dirname(lockFilePath(env.ctx)), { recursive: true });
  await fs.writeFile(
    lockFilePath(env.ctx),
    JSON.stringify({
      version: 3,
      skills: {
        gone: {
          source: "a/b",
          sourceType: "github",
          sourceUrl: "https://github.com/a/b.git",
          skillPath: "skills/x/gone/SKILL.md",
          skillFolderHash: "a".repeat(64),
          installedAt: "x",
          updatedAt: "x",
        },
      },
    }),
  );
  const result = await call(env.module as never, "POST skills/updates/check", { body: {} });
  const item = (result.results as { status: string; message?: string }[])[0]!;
  assert.equal(item.status, "error");
  assert.match(item.message!, /找不到/);
});

test("检查更新：下载失败 → error，其余技能继续", async () => {
  const userAgents = makeTempDir();
  const dir = await seedLocalSkill(userAgents, "x", { "SKILL.md": SKILL_MD_V1 });
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "x", path: dir, name: "x" }],
    rootPaths: { "user-agents": userAgents },
    routes: [{ match: (u) => u.includes("codeload"), response: () => new Response("nope", { status: 500 }) }],
  });
  await fs.mkdir(path.dirname(lockFilePath(env.ctx)), { recursive: true });
  await fs.writeFile(
    lockFilePath(env.ctx),
    JSON.stringify({
      version: 3,
      skills: {
        x: {
          source: "a/b",
          sourceType: "github",
          sourceUrl: "s",
          skillPath: "SKILL.md",
          skillFolderHash: "a".repeat(64),
          installedAt: "i",
          updatedAt: "i",
        },
      },
    }),
  );
  const result = await call(env.module as never, "POST skills/updates/check", { body: {} });
  const item = (result.results as { status: string; message?: string }[])[0]!;
  assert.equal(item.status, "error");
  assert.match(item.message!, /HTTP 500/);
});

test("applyUpdate：按契约五步顺序执行，并写回新哈希（installedAt 不变）", async () => {
  const userAgents = makeTempDir();
  const dir = await seedLocalSkill(userAgents, "grilling", { "SKILL.md": SKILL_MD_V1, "agents/openai.yaml": YAML_V1 });
  const upstreamGz = tarGzOf(
    skillFixture("productivity", "grilling", { description: "v2", extraFiles: { "extra.txt": "new file" } }),
  );
  const env = await buildModule({
    skills: [
      { rootId: "user-agents", dirName: "grilling", path: dir, name: "grilling", modelInvocationDisabled: true },
    ],
    rootPaths: { "user-agents": userAgents },
    routes: [
      { match: (u) => u.includes("/repos/"), response: () => jsonResponse({ default_branch: "main" }) },
      {
        match: (u) => u.includes("/tar.gz/"),
        response: () => new Response(new Uint8Array(upstreamGz), { status: 200 }),
      },
    ],
  });
  await fs.mkdir(path.dirname(lockFilePath(env.ctx)), { recursive: true });
  const originalInstalledAt = "2026-09-22T01:17:31.905Z";
  await fs.writeFile(
    lockFilePath(env.ctx),
    JSON.stringify({
      version: 3,
      skills: {
        grilling: {
          source: "mattpocock/skills",
          sourceType: "github",
          sourceUrl: "https://github.com/mattpocock/skills.git",
          skillPath: "skills/productivity/grilling/SKILL.md",
          skillFolderHash: "0".repeat(64),
          pluginName: "mattpocock-skills",
          installedAt: originalInstalledAt,
          updatedAt: originalInstalledAt,
        },
      },
      dismissed: {},
    }),
  );

  const result = await call(env.module as never, "POST skills/updates/apply", {
    body: { ids: ["user-agents:grilling"] },
  });
  const item = (result.results as { ok: boolean; message?: string; trashId?: string }[])[0]!;
  assert.equal(item.ok, true, item.message);
  assert.ok(item.trashId, "应报告回收站 id");

  // 顺序：moveToTrash(update) → setEnabled(false)（因为原本停用）
  assert.deepEqual(
    env.skills.calls.filter((c) => c.startsWith("moveToTrash") || c.startsWith("setEnabled")),
    ["moveToTrash(user-agents:grilling,update)", "setEnabled(user-agents:grilling,false)"],
  );
  assert.equal(env.skills.moveToTrashCalls[0]!.lockEntry !== undefined, true, "应把更新前的 lock 条目交给回收站");
  assert.equal((env.skills.moveToTrashCalls[0]!.lockEntry as { installedAt: string }).installedAt, originalInstalledAt);

  const newFiles = await readTree(path.join(userAgents, "grilling"));
  assert.match(newFiles["SKILL.md"]!, /v2/);
  assert.equal(newFiles["extra.txt"], "new file", "覆盖式更新：新版本的多余文件也要写入");

  const lock = JSON.parse(await fs.readFile(lockFilePath(env.ctx), "utf8"));
  const entry = lock.skills.grilling;
  assert.equal(entry.skillFolderHash, archiveInstalledHash(upstreamGz));
  assert.equal(entry.installedAt, originalInstalledAt, "installedAt 必须保持不变");
  assert.notEqual(entry.updatedAt, originalInstalledAt, "updatedAt 应刷新");
  assert.equal(entry.pluginName, "mattpocock-skills", "未知字段保留");
  assert.equal(lock.version, 3);
});

test("applyUpdate：原本启用则不改启停状态", async () => {
  const userAgents = makeTempDir();
  const dir = await seedLocalSkill(userAgents, "foo", { "SKILL.md": SKILL_MD_V1 });
  const upstreamGz = tarGzOf(skillFixture("x", "foo", { description: "v2" }));
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "foo", path: dir, name: "foo" }],
    rootPaths: { "user-agents": userAgents },
    routes: [
      {
        match: (u) => u.includes("/tar.gz/"),
        response: () => new Response(new Uint8Array(upstreamGz), { status: 200 }),
      },
    ],
  });
  await fs.mkdir(path.dirname(lockFilePath(env.ctx)), { recursive: true });
  await fs.writeFile(
    lockFilePath(env.ctx),
    JSON.stringify({
      version: 3,
      skills: {
        foo: {
          source: "a/b",
          sourceType: "github",
          sourceUrl: "s",
          skillPath: "skills/x/foo/SKILL.md",
          skillFolderHash: "0".repeat(64),
          installedAt: "i",
          updatedAt: "i",
        },
      },
    }),
  );
  const result = await call(env.module as never, "POST skills/updates/apply", { body: { ids: ["user-agents:foo"] } });
  assert.equal((result.results as { ok: boolean }[])[0]!.ok, true);
  assert.equal(env.skills.setEnabledCalls.length, 0, "原本启用就不该调用 setEnabled");
});

test("applyUpdate 回滚：moveToTrash 失败 → 目录原样、lock 未改、ok=false", async () => {
  const userAgents = makeTempDir();
  const dir = await seedLocalSkill(userAgents, "foo", { "SKILL.md": SKILL_MD_V1 });
  const upstreamGz = tarGzOf(skillFixture("x", "foo", { description: "v2" }));
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "foo", path: dir, name: "foo" }],
    rootPaths: { "user-agents": userAgents },
    failMoveToTrashOnce: true,
    routes: [
      {
        match: (u) => u.includes("/tar.gz/"),
        response: () => new Response(new Uint8Array(upstreamGz), { status: 200 }),
      },
    ],
  });
  await fs.mkdir(path.dirname(lockFilePath(env.ctx)), { recursive: true });
  await fs.writeFile(
    lockFilePath(env.ctx),
    JSON.stringify({
      version: 3,
      skills: {
        foo: {
          source: "a/b",
          sourceType: "github",
          sourceUrl: "s",
          skillPath: "skills/x/foo/SKILL.md",
          skillFolderHash: "0".repeat(64),
          installedAt: "i",
          updatedAt: "i",
        },
      },
    }),
  );
  const before = await fs.readFile(lockFilePath(env.ctx), "utf8").catch(() => "");
  const result = await call(env.module as never, "POST skills/updates/apply", { body: { ids: ["user-agents:foo"] } });
  const item = (result.results as { ok: boolean; message?: string }[])[0]!;
  assert.equal(item.ok, false);
  assert.match(item.message!, /移入回收站失败/);
  assert.equal(await fs.readFile(path.join(dir, "SKILL.md"), "utf8"), SKILL_MD_V1, "原目录必须保持原状");
  assert.equal(await fs.readFile(lockFilePath(env.ctx), "utf8").catch(() => ""), before, "lock 不应被改动");
});

test("applyUpdate 回滚：恢复启停状态失败 → 目录从回收站拿回、lock 未改", async () => {
  const userAgents = makeTempDir();
  const dir = await seedLocalSkill(userAgents, "foo", { "SKILL.md": SKILL_MD_V1 });
  const upstreamGz = tarGzOf(skillFixture("x", "foo", { description: "v2" }));
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "foo", path: dir, name: "foo", modelInvocationDisabled: true }],
    rootPaths: { "user-agents": userAgents },
    failSetEnabledOnce: true,
    routes: [
      {
        match: (u) => u.includes("/tar.gz/"),
        response: () => new Response(new Uint8Array(upstreamGz), { status: 200 }),
      },
    ],
  });
  await fs.mkdir(path.dirname(lockFilePath(env.ctx)), { recursive: true });
  await fs.writeFile(
    lockFilePath(env.ctx),
    JSON.stringify({
      version: 3,
      skills: {
        foo: {
          source: "a/b",
          sourceType: "github",
          sourceUrl: "s",
          skillPath: "skills/x/foo/SKILL.md",
          skillFolderHash: "0".repeat(64),
          installedAt: "i",
          updatedAt: "i",
        },
      },
    }),
  );
  const lockBefore = await fs.readFile(lockFilePath(env.ctx), "utf8");
  const result = await call(env.module as never, "POST skills/updates/apply", { body: { ids: ["user-agents:foo"] } });
  const item = (result.results as { ok: boolean; message?: string }[])[0]!;
  assert.equal(item.ok, false);
  assert.match(item.message!, /恢复「停用」状态失败/);
  assert.match(item.message!, /已从回收站恢复原目录/);
  assert.equal(await fs.readFile(path.join(dir, "SKILL.md"), "utf8"), SKILL_MD_V1, "必须从回收站拿回原目录");
  assert.match(await fs.readFile(path.join(dir, "SKILL.md"), "utf8"), /name: foo/);
  assert.deepEqual(env.skills.restoreCalls, [{ trashId: "trash-1", replace: true }]);
  assert.equal(await fs.readFile(lockFilePath(env.ctx), "utf8"), lockBefore, "lock 不应被改动");
  // 覆盖式更新写进去的新文件必须被清掉（目录恢复成原状）
  assert.deepEqual(Object.keys(await readTree(dir)).sort(), ["SKILL.md"]);
});

test("applyUpdate：无来源 → ok=false 并逐项说明", async () => {
  const userAgents = makeTempDir();
  const dir = await seedLocalSkill(userAgents, "foo", { "SKILL.md": SKILL_MD_V1 });
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "foo", path: dir, name: "foo" }],
    rootPaths: { "user-agents": userAgents },
  });
  const result = await call(env.module as never, "POST skills/updates/apply", { body: { ids: ["user-agents:foo"] } });
  const item = (result.results as { ok: boolean; message?: string }[])[0]!;
  assert.equal(item.ok, false);
  assert.match(item.message!, /没有来源记录/);
  await assert.rejects(call(env.module as never, "POST skills/updates/apply", { body: { ids: [] } }), /至少选择一个/);
});

test("路由参数校验：错误码与中文提示", async () => {
  const env = await buildModule({});
  const cases: [string, { body?: unknown; query?: Record<string, string> }, RegExp][] = [
    ["POST skills/sources/register", { body: {} }, /不能为空/],
    ["POST skills/sources/unregister", { body: {} }, /不能为空/],
    ["POST skills/repo/browse", { body: { repo: "" } }, /不能为空/],
    ["POST skills/repos/add", { body: { repo: "nope" } }, /无法解析|格式/],
    ["POST skills/repos/remove", { body: {} }, /不能为空/],
    ["POST skills/updates/apply", { body: {} }, /至少选择一个/],
    ["POST skills/install", { body: { repo: "a/b", target: "user-agents" } }, /至少选择一个/],
    ["GET skills/search", { query: { q: "a" } }, /至少需要 2 个字符/],
    ["POST skills/sources/discover", { body: { ids: "not-array" } }, /数组/],
  ];
  for (const [key, req, pattern] of cases) {
    await assert.rejects(call(env.module as never, key, req as never), pattern, key);
  }
});

test("仓库列表：首次读取自动落盘预置仓库，支持增删", async () => {
  const env = await buildModule({});
  const list = await call(env.module as never, "GET skills/repos");
  const repos = list.repos as { repo: string; preset: boolean }[];
  assert.ok(repos.length >= 4);
  assert.ok(repos.every((r) => r.preset));
  assert.ok(repos.some((r) => r.repo === "anthropics/skills"));
  assert.ok(repos.some((r) => r.repo === "ComposioHQ/awesome-claude-skills"));
  assert.ok(repos.some((r) => r.repo === "mattpocock/skills"));
  assert.ok(repos.some((r) => r.repo === "vercel-labs/skills"));

  const added = await call(env.module as never, "POST skills/repos/add", {
    body: { repo: "https://github.com/JimLiu/baoyu-skills", ref: "main" },
  });
  assert.ok((added.repos as { repo: string }[]).some((r) => r.repo === "JimLiu/baoyu-skills"));
  await assert.rejects(
    call(env.module as never, "POST skills/repos/add", { body: { repo: "jimliu/baoyu-skills" } }),
    /已在列表中/,
  );
  await call(env.module as never, "POST skills/repos/remove", { body: { repo: "JimLiu/baoyu-skills" } });
  const after = await call(env.module as never, "GET skills/repos");
  assert.ok(!(after.repos as { repo: string }[]).some((r) => r.repo === "JimLiu/baoyu-skills"));
  await assert.rejects(
    call(env.module as never, "POST skills/repos/remove", { body: { repo: "JimLiu/baoyu-skills" } }),
    /不在列表中/,
  );
});

test("浏览仓库：列出技能、解析 name/description、标出已安装", async () => {
  const userAgents = makeTempDir();
  const installedDir = await seedLocalSkill(userAgents, "tdd", {
    "SKILL.md": "---\nname: tdd\ndescription: 本地版\n---\n",
  });
  const archive = tarGzOf([
    ...skillFixture("engineering", "tdd", { description: "测试驱动开发" }),
    ...skillFixture("productivity", "grilling", { description: "拷问" }),
    { path: "skills/.experimental/broken/SKILL.md", data: "---\nname: broken\n---\n" },
  ]);
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "tdd", path: installedDir, name: "tdd" }],
    rootPaths: { "user-agents": userAgents },
    routes: [
      { match: (u) => u.includes("/repos/"), response: () => jsonResponse({ default_branch: "main" }) },
      { match: (u) => u.includes("/tar.gz/"), response: () => new Response(new Uint8Array(archive), { status: 200 }) },
    ],
  });
  const result = await call(env.module as never, "POST skills/repo/browse", { body: { repo: "mattpocock/skills" } });
  const skills = result.skills as {
    skillPath: string;
    dirName: string;
    name?: string;
    description?: string;
    installedId?: string;
  }[];
  assert.equal(result.repo, "mattpocock/skills");
  assert.equal(result.ref, "main");
  const tdd = skills.find((s) => s.dirName === "tdd")!;
  assert.equal(tdd.name, "tdd");
  assert.equal(tdd.description, "测试驱动开发");
  assert.equal(tdd.installedId, "user-agents:tdd", "本机已装的要标出来");
  assert.equal(skills.find((s) => s.dirName === "grilling")!.installedId, undefined);
  assert.equal(skills.find((s) => s.dirName === "broken")!.description, undefined);
});

test("浏览仓库：/tree/<ref>/<path> 只列出该子路径下的技能", async () => {
  const archive = tarGzOf([
    ...skillFixture("engineering", "tdd", { description: "a" }),
    ...skillFixture("productivity", "grilling", { description: "b" }),
  ]);
  const env = await buildModule({
    routes: [
      { match: (u) => u.includes("/tar.gz/"), response: () => new Response(new Uint8Array(archive), { status: 200 }) },
    ],
  });
  const result = await call(env.module as never, "POST skills/repo/browse", {
    body: { repo: "https://github.com/a/b/tree/main/skills/engineering" },
  });
  const skills = result.skills as { dirName: string }[];
  assert.deepEqual(
    skills.map((s) => s.dirName),
    ["tdd"],
  );
  assert.equal(result.ref, "main");
});

test("浏览仓库：没有技能时 UPSTREAM 且中文说明", async () => {
  const env = await buildModule({
    routes: [
      {
        match: (u) => u.includes("/tar.gz/"),
        response: () => new Response(new Uint8Array(tarGzOf([{ path: "README.md", data: "hi" }])), { status: 200 }),
      },
    ],
  });
  await assert.rejects(
    call(env.module as never, "POST skills/repo/browse", { body: { repo: "a/b" } }),
    /没有找到任何技能/,
  );
});

test("skills.sh 搜索：归一化结果 + 关键词长度校验", async () => {
  const env = await buildModule({
    routes: [
      {
        match: (u) => u.includes("skills.sh"),
        response: () =>
          jsonResponse({
            query: "pdf",
            searchType: "fuzzy",
            skills: [
              {
                id: "anthropics/skills/pdf",
                skillId: "pdf",
                name: "pdf",
                installs: 205717,
                source: "anthropics/skills",
              },
            ],
            count: 1,
          }),
      },
    ],
  });
  const result = await call(env.module as never, "GET skills/search", { query: { q: "pdf" } });
  assert.deepEqual(result.results, [
    { name: "pdf", repo: "anthropics/skills", skillPath: undefined, installs: 205717 },
  ]);
  await assert.rejects(call(env.module as never, "GET skills/search", { query: { q: "a" } }), /至少需要 2 个字符/);
  await assert.rejects(call(env.module as never, "GET skills/search", { query: { q: "pdf", limit: "999" } }), /1-100/);
});

test("GET skills/github-auth 返回凭据模式", async () => {
  const env = await buildModule({});
  const result = await call(env.module as never, "GET skills/github-auth", { query: {} });
  assert.equal(result.mode, "anonymous");
  // FIX-6（D-3）：路由会主动查一次 /rate_limit；本用例的假 fetch 没配这条路由（404），
  // 因此「查不到就省略这个字段、不报错」。
  assert.ok(env.fake.calls.some((c) => c.url === "https://api.github.com/rate_limit"));
  assert.equal("rateLimitRemaining" in result, false);
});

test("工厂返回的 lockStash 直接可用（接线给 skills-local）", async () => {
  const env = await buildModule({});
  assert.equal(typeof env.module.lockStash.take, "function");
  assert.equal(typeof env.module.lockStash.put, "function");
  assert.equal(await env.module.lockStash.take({ rootId: "user-agents", dirName: "x", path: "/tmp/x" }), undefined);
});

test("令牌不泄漏（C4）：配置 GITHUB_TOKEN 后逐路由检查响应与日志", async () => {
  const SECRET = "ghp_" + "z".repeat(36);
  const archive = tarGzOf(skillFixture("x", "foo", { description: "d" }));
  const env = await buildModule({
    envToken: SECRET,
    routes: [
      { match: (u) => u.includes("/repos/"), response: () => jsonResponse({ default_branch: "main" }) },
      { match: (u) => u.includes("codeload"), response: () => new Response(new Uint8Array(archive), { status: 200 }) },
      {
        match: (u) => u.includes("skills.sh"),
        response: () =>
          jsonResponse({ query: "pdf", skills: [{ id: "a/b", skillId: "b", name: "b", installs: 3, source: "a/b" }] }),
      },
    ],
  });

  const responses: unknown[] = [];
  responses.push(await call(env.module as never, "GET skills/github-auth", { query: {} }));
  responses.push(await call(env.module as never, "GET skills/repos"));
  responses.push(await call(env.module as never, "GET skills/sources", { query: {} }));
  responses.push(await call(env.module as never, "POST skills/repo/browse", { body: { repo: "a/b" } }));
  responses.push(await call(env.module as never, "POST skills/updates/check", { body: {} }));
  responses.push(await call(env.module as never, "GET skills/search", { query: { q: "pdf" } }));

  const serialized = JSON.stringify(responses);
  assert.ok(!serialized.includes(SECRET), "任何路由响应里都不得出现令牌");
  assert.ok(serialized.includes('"mode":"env"'), "应如实报告凭据模式");
  const logs = JSON.stringify(env.sink);
  assert.ok(!logs.includes(SECRET), "日志里不得出现令牌");

  // 令牌确实被用来发请求（证明凭据链真的生效，而不是「碰巧没用到」）
  assert.ok(
    env.fake.calls.some((c) => c.headers["authorization"] === `Bearer ${SECRET}`),
    "请求应带上令牌",
  );

  // 落盘文件里也不得出现令牌
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(abs)));
      else out.push(abs);
    }
    return out;
  };
  for (const file of [...(await walk(env.home)), ...(await walk(env.hubHome))]) {
    const content = await fs.readFile(file, "utf8").catch(() => "");
    assert.ok(!content.includes(SECRET), `文件里不得出现令牌：${file}`);
  }
});

test('所有路由都是 async 函数，且键符合 "<METHOD> <path>" 格式', async () => {
  const env = await buildModule({});
  const keys = Object.keys(env.module.routes);
  assert.ok(keys.length >= 12, `路由数 ${keys.length}`);
  for (const key of keys) {
    assert.match(key, /^(GET|POST) [a-z-]+\/[a-z/-]+$/, key);
    assert.equal(typeof env.module.routes[key], "function");
  }
  const expected = [
    "GET skills/sources",
    "POST skills/sources/discover",
    "POST skills/sources/register",
    "POST skills/sources/unregister",
    "POST skills/updates/check",
    "POST skills/updates/apply",
    "GET skills/repos",
    "POST skills/repos/add",
    "POST skills/repos/remove",
    "POST skills/repo/browse",
    "GET skills/search",
    "POST skills/install",
    "GET skills/github-auth",
  ];
  for (const key of expected) assert.ok(keys.includes(key), `缺少路由 ${key}`);
});
