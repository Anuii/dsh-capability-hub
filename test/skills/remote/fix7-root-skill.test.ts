/**
 * FIX-7 测试：单技能仓库（SKILL.md 就在仓库根）的浏览、安装与更新。
 *
 *   J1 根级技能可安装；.github/.vscode 之类的仓库元数据目录不写进技能目录；目录名经过安全化
 *   J2 lock 字段正确（**键 = 原始技能名**、skillPath = "SKILL.md"、
 *      skillFolderHash = 按 npx 口径对**上游仓库根**算的值），安装后立刻检查更新为「最新」；
 *      应用更新写回同一口径
 *   J3 浏览：根级技能列成 skillPath = "SKILL.md"、装过的显示已安装
 *   D-2 需要清洗的技能名（大写/空格）下「注册 → 列表 → take/put → 检查更新 → 应用更新」全链路一致
 *
 * 口径与 npx skills（1.7.0）兼容：哈希按上游仓库根目录计算，lock 键 = 原始技能名。
 * 全部落盘都在 os.tmpdir() 下的临时目录里，绝不碰真实用户目录（PLAN §4 / C5）。
 */

import * as YAML from "yaml";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createSkillsRemoteModule } from "../../../src/skills/remote/module.ts";
import { lockFilePath, sourcesFilePath } from "../../../src/skills/remote/lockstore.ts";
import { hashFiles, recordedHash } from "../../../src/skills/remote/hash.ts";
import { sanitizeName } from "../../../src/skills/remote/rootskill.ts";
import type { SkillLockEntry } from "../../../src/skills/remote/types.ts";
import {
  jsonResponse,
  makeCtx,
  makeFakeApi,
  makeFakeFetch,
  makeLogger,
  makeTempDir,
  readTree,
  tarGzOf,
  withRootPaths,
} from "./helpers.ts";
import { skillFixture, type FixtureEntry } from "./tarfixture.ts";

const ROOT_SKILL_MD = "---\nname: Rooty Skill\ndescription: 根级技能\n---\n\n# 根级技能\n\n正文。\n";
const README_MD = "# 单技能仓库\n";
const NOTES_MD = "附带说明\n";
const CI_V1 = "name: ci\n";

/** 一个典型的「单技能仓库」：SKILL.md 在仓库根，混有仓库元数据目录 */
function rootRepoFixture(extra: FixtureEntry[] = []): FixtureEntry[] {
  return [
    { path: "SKILL.md", data: ROOT_SKILL_MD },
    { path: "README.md", data: README_MD },
    { path: ".gitignore", data: "node_modules\n" },
    { path: "agents/notes.md", data: NOTES_MD },
    { path: ".github/workflows/ci.yml", data: CI_V1 },
    { path: ".github/ISSUE_TEMPLATE/bug.yml", data: "name: bug\n" },
    { path: ".vscode/settings.json", data: "{}\n" },
    { path: "node_modules/pkg/index.js", data: "module.exports = 1;\n" },
    { path: "__pycache__/x.pyc", data: "x\n" },
    ...extra,
  ];
}

/** **实际写盘**的那批文件（判据见 rootskill.ts 的 rootSkillFiles：排除元数据目录） */
const WRITTEN_FILES = [
  { rel: "SKILL.md", data: Buffer.from(ROOT_SKILL_MD) },
  { rel: "README.md", data: Buffer.from(README_MD) },
  { rel: ".gitignore", data: Buffer.from("node_modules\n") },
  { rel: "agents/notes.md", data: Buffer.from(NOTES_MD) },
];

/**
 * **npx skills 哈希口径**下的期望值：上游仓库根的全部文件，只跳过 .git 与 node_modules
 * （含 .github/.vscode）—— 这里独立重算一遍，不调用被测函数。
 */
function npxExpectedHash(extra: FixtureEntry[] = []): string {
  const files = rootRepoFixture(extra)
    .filter((entry) => entry.type !== "dir")
    .filter(
      (entry) =>
        !entry.path
          .split("/")
          .slice(0, -1)
          .some((seg) => seg === "node_modules" || seg === ".git"),
    )
    .map((entry) => ({ rel: entry.path, data: Buffer.from(entry.data ?? "") }));
  return recordedHash(hashFiles(files));
}

type FakeRoutes = Parameters<typeof makeFakeFetch>[0];
type FakeSkills = NonNullable<Parameters<typeof makeFakeApi>[0]>["skills"];

interface EnvOptions {
  skills?: FakeSkills;
  rootPaths?: Record<string, string>;
  routes?: FakeRoutes;
  /** 可变的上游归档（测试中途换内容用） */
  archive?: Buffer;
}

async function buildModule(options: EnvOptions = {}) {
  const home = makeTempDir();
  const hubHome = makeTempDir();
  const sink: ReturnType<typeof makeLogger>["sink"] = [];
  const { logger } = makeLogger(sink);
  const ctx = makeCtx({ homeDir: home, hubHome, logger });
  const skills = makeFakeApi({ skills: options.skills ?? [] });
  if (options.rootPaths) withRootPaths(skills, options.rootPaths);
  const routes: FakeRoutes = options.routes ?? [
    { match: (u) => u.includes("/repos/"), response: () => jsonResponse({ default_branch: "main" }) },
    {
      match: (u) => u.includes("/tar.gz/"),
      response: () => new Response(new Uint8Array(options.archive ?? Buffer.alloc(0)), { status: 200 }),
    },
  ];
  const fake = makeFakeFetch(routes);
  const module = createSkillsRemoteModule(
    ctx,
    { skills, yaml: YAML },
    {
      fetchImpl: fake.fetch,
      envTokenProvider: () => undefined,
      ghTokenProvider: async () => undefined,
      cacheAuth: false,
    },
  );
  return { home, hubHome, ctx, skills, fake, module, sink };
}

function call(
  module: { routes: Record<string, (r: never) => Promise<unknown>> },
  key: string,
  req: { query?: Record<string, string>; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const handler = module.routes[key];
  if (!handler) throw new Error("路由不存在：" + key);
  return handler({ query: req.query ?? {}, body: req.body, signal: new AbortController().signal } as never) as Promise<
    Record<string, unknown>
  >;
}

async function readLockJson(home: string): Promise<{ version: number; skills: Record<string, SkillLockEntry> }> {
  return JSON.parse(await fs.readFile(path.join(home, ".agents", ".skill-lock.json"), "utf8")) as {
    version: number;
    skills: Record<string, SkillLockEntry>;
  };
}

type Env = Awaited<ReturnType<typeof buildModule>>;

interface InstallItem {
  skillPath: string;
  ok: boolean;
  skillId?: string;
  message?: string;
}

async function installRoot(env: Env, repo: string): Promise<InstallItem> {
  const result = await call(env.module as never, "POST skills/install", {
    body: { repo, skillPaths: ["SKILL.md"], target: "user-agents" },
  });
  return (result.results as InstallItem[])[0]!;
}

async function sourceEntries(env: Env): Promise<{ skillId: string; skillPath: string; orphan: boolean }[]> {
  const listed = await call(env.module as never, "GET skills/sources", { query: {} });
  return listed.entries as { skillId: string; skillPath: string; orphan: boolean }[];
}

async function checkStatus(env: Env): Promise<{ skillId: string; status: string; message?: string }> {
  const checked = await call(env.module as never, "POST skills/updates/check", { body: {} });
  return (checked.results as { skillId: string; status: string; message?: string }[])[0]!;
}

/* =========================== J1 =========================== */

test("FIX-7 J1/J2 安装：根级技能可安装 —— 目录名 sanitizeName(name)，元数据目录不写盘，lock 字段正确", async () => {
  const userAgents = makeTempDir();
  const archive = tarGzOf(rootRepoFixture(), "single-skill-main");
  const env = await buildModule({ rootPaths: { "user-agents": userAgents }, archive });

  const item = await installRoot(env, "a/single-skill");
  assert.equal(item.ok, true, item.message);
  assert.equal(item.skillPath, "SKILL.md");
  // 目录名 = sanitizeName("Rooty Skill")（仓库名是 single-skill，说明用的是 frontmatter name）
  assert.equal(item.skillId, "user-agents:rooty-skill");

  const onDisk = await readTree(path.join(userAgents, "rooty-skill"));
  assert.deepEqual(
    Object.keys(onDisk).sort(),
    [".gitignore", "README.md", "SKILL.md", "agents/notes.md"],
    "技能目录里只能有真正的内容文件：.github/.vscode/node_modules/__pycache__ 一个都不许有",
  );
  assert.match(onDisk["SKILL.md"]!, /name: Rooty Skill/);
  const installedPaths = Object.keys(await readTree(userAgents));
  assert.ok(installedPaths.length > 0);
  assert.equal(
    installedPaths.every((rel) => rel.startsWith("rooty-skill/")),
    true,
    installedPaths.join(", "),
  );

  const lock = await readLockJson(env.home);
  assert.equal(lock.version, 3);
  // 锁键 = 原始技能名（npx 语义：addSkillToLock(skill.name, …)），目录名才是 sanitizeName
  const entry = lock.skills["Rooty Skill"]!;
  assert.ok(entry, "lock 的键必须是原始技能名：" + Object.keys(lock.skills).join(", "));
  assert.equal(entry.source, "a/single-skill");
  assert.equal(entry.sourceType, "github");
  assert.equal(entry.sourceUrl, "https://github.com/a/single-skill.git");
  assert.equal(entry.ref, "main");
  assert.equal(entry.skillPath, "SKILL.md", "skillPath 只表示技能在仓库内的位置（根级就是 SKILL.md）");
  assert.equal(entry.installedAt, entry.updatedAt);
  // 哈希按 npx 口径对「上游仓库根」算（含 .github/.vscode，只跳 .git/node_modules）
  assert.equal(entry.skillFolderHash, npxExpectedHash());
  // 与「实际写盘的那批文件」的哈希不同 —— 记录的是上游内容，不是本地内容（D-B7）
  assert.notEqual(entry.skillFolderHash, recordedHash(hashFiles(WRITTEN_FILES)));
});

test("FIX-7 J1 安装：根级仓库里混入穿越文件名 → 整体拒绝、零写入", async () => {
  const userAgents = makeTempDir();
  const archive = tarGzOf(rootRepoFixture([{ path: "evil\\..\\..\\pwned.txt", data: "x" }]), "single-skill-main");
  const env = await buildModule({ rootPaths: { "user-agents": userAgents }, archive });

  const item = await installRoot(env, "a/single-skill");
  assert.equal(item.ok, false);
  assert.match(item.message!, /不安全/);
  await assert.rejects(fs.stat(path.join(userAgents, "rooty-skill")), "不合格时一个文件都不写");
  await assert.rejects(fs.stat(lockFilePath(env.ctx)), "来源也必须没写");
});

test("FIX-7 J1 安装：根级技能目录名仍须通过 safeSegmentName（Windows 保留名 con 被拒）", async () => {
  const userAgents = makeTempDir();
  const archive = tarGzOf([{ path: "SKILL.md", data: "---\nname: con\ndescription: d\n---\n" }], "con-main");
  const env = await buildModule({ rootPaths: { "user-agents": userAgents }, archive });

  const item = await installRoot(env, "a/con");
  assert.equal(item.ok, false);
  assert.match(item.message!, /保留设备名/);
  assert.deepEqual(Object.keys(await readTree(userAgents)), [], "拒绝时不得留下任何目录");
});

test("FIX-7 J1 安装：取不到 frontmatter name 时键与目录名都回退成仓库名（目录名过 sanitizeName）", async () => {
  const userAgents = makeTempDir();
  const archive = tarGzOf(
    [
      { path: "SKILL.md", data: "# 没有 frontmatter 的技能\n" },
      { path: "README.md", data: README_MD },
    ],
    "Cool_Skill-main",
  );
  const env = await buildModule({ rootPaths: { "user-agents": userAgents }, archive });

  const item = await installRoot(env, "a/Cool_Skill");
  assert.equal(item.ok, true, item.message);
  assert.equal(item.skillId, "user-agents:cool_skill");
  const lock = await readLockJson(env.home);
  assert.deepEqual(Object.keys(lock.skills), ["Cool_Skill"], "键 = 仓库名原样");
  assert.equal(lock.skills["Cool_Skill"]!.skillPath, "SKILL.md");
  assert.equal(
    lock.skills["Cool_Skill"]!.skillFolderHash,
    recordedHash(
      hashFiles([
        { rel: "SKILL.md", data: Buffer.from("# 没有 frontmatter 的技能\n") },
        { rel: "README.md", data: Buffer.from(README_MD) },
      ]),
    ),
  );
});

test("FIX-7 安装：根级技能装到 user-dsh（非 lock-backed 根）→ 写 sources.json", async () => {
  const userDsh = makeTempDir();
  const archive = tarGzOf(rootRepoFixture(), "single-skill-main");
  const env = await buildModule({ rootPaths: { "user-dsh": userDsh }, archive });

  const result = await call(env.module as never, "POST skills/install", {
    body: { repo: "a/single-skill", skillPaths: ["SKILL.md"], target: "user-dsh" },
  });
  const item = (result.results as InstallItem[])[0]!;
  assert.equal(item.ok, true, item.message);
  assert.equal(item.skillId, "user-dsh:rooty-skill");

  const file = JSON.parse(await fs.readFile(sourcesFilePath(env.ctx), "utf8"));
  const stored = file.entries["user-dsh/rooty-skill"];
  assert.ok(stored, "其它根写 sources.json");
  assert.equal(stored.repo, "a/single-skill");
  assert.equal(stored.dirName, "rooty-skill");
  assert.equal(stored.skillPath, "SKILL.md");
  assert.equal(stored.skillFolderHash, npxExpectedHash());
  assert.deepEqual(Object.keys(await readTree(path.join(userDsh, "rooty-skill"))).sort(), [
    ".gitignore",
    "README.md",
    "SKILL.md",
    "agents/notes.md",
  ]);
  await assert.rejects(fs.stat(lockFilePath(env.ctx)), "user-dsh 不该动 lock");
});

/* =========================== J2 =========================== */

test("FIX-7 J2 安装后检查更新 = 「最新」；上游内容一变就报「有更新」（含只改 .github）", async () => {
  const userAgents = makeTempDir();
  const skillDir = path.join(userAgents, "rooty-skill");
  let archive = tarGzOf(rootRepoFixture(), "single-skill-main");
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "rooty-skill", path: skillDir, name: "Rooty Skill" }],
    rootPaths: { "user-agents": userAgents },
    routes: [
      { match: (u) => u.includes("/repos/"), response: () => jsonResponse({ default_branch: "main" }) },
      { match: (u) => u.includes("/tar.gz/"), response: () => new Response(new Uint8Array(archive), { status: 200 }) },
    ],
  });

  const item = await installRoot(env, "a/single-skill");
  assert.equal(item.ok, true, item.message);

  // 安装与检查更新共用同一口径（npx：上游仓库根）→ 立刻检查必须是 up-to-date
  const first = await checkStatus(env);
  assert.equal(first.skillId, "user-agents:rooty-skill");
  assert.equal(first.status, "up-to-date", first.message ?? "");

  // 改技能内容 → 有更新
  archive = tarGzOf(rootRepoFixture([{ path: "agents/extra.md", data: "新增\n" }]), "single-skill-main");
  assert.equal((await checkStatus(env)).status, "update-available", "内容变了要报有更新");

  // 只改 .github 里的文件 → 也必须是「有更新」（npx 的哈希含 .github；记录与比较的基准都是上游仓库根）
  archive = tarGzOf(rootRepoFixture([{ path: ".github/workflows/ci.yml", data: "name: ci2\n" }]), "single-skill-main");
  assert.equal((await checkStatus(env)).status, "update-available", "只改 .github 也要报有更新（与 npx 一致）");

  // 只改 node_modules 里的文件 → 仍判「最新」（npx 的算法跳过 .git 与 node_modules）
  archive = tarGzOf(
    rootRepoFixture([{ path: "node_modules/pkg/index.js", data: "module.exports = 2;\n" }]),
    "single-skill-main",
  );
  assert.equal((await checkStatus(env)).status, "up-to-date", "node_modules 不参与哈希");
});

test('FIX-7 J2 兼容 npx 预置的条目：键 = 原始技能名、skillPath "SKILL.md"、hash 按 npx 口径 → 判「最新」', async () => {
  const userAgents = makeTempDir();
  const skillDir = path.join(userAgents, "rooty-skill");
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "rooty-skill", path: skillDir, name: "Rooty Skill" }],
    rootPaths: { "user-agents": userAgents },
    archive: tarGzOf(rootRepoFixture(), "single-skill-main"),
  });

  // 完全按 npx skills 的写法预置（addSkillToLock(skill.name, { skillPath: "SKILL.md", skillFolderHash })）
  await fs.mkdir(path.dirname(lockFilePath(env.ctx)), { recursive: true });
  await fs.writeFile(
    lockFilePath(env.ctx),
    JSON.stringify(
      {
        version: 3,
        skills: {
          "Rooty Skill": {
            source: "a/single-skill",
            sourceType: "github",
            sourceUrl: "https://github.com/a/single-skill.git",
            ref: "main",
            skillPath: "SKILL.md",
            skillFolderHash: npxExpectedHash(),
            installedAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      },
      null,
      2,
    ),
  );

  const item = await checkStatus(env);
  assert.equal(item.skillId, "user-agents:rooty-skill", "skillId 由 sanitizeName(lock 键) 派生");
  assert.equal(item.status, "up-to-date", item.message ?? "");
  const entries = await sourceEntries(env);
  assert.equal(entries[0]!.orphan, false, "npx 写的条目不能被判成悬空");
});

test('FIX-7 J2 应用更新：根级技能写回同一批内容（元数据仍不写盘），skillPath 保持 "SKILL.md"', async () => {
  const userAgents = makeTempDir();
  const skillDir = path.join(userAgents, "rooty-skill");
  const archive = tarGzOf(rootRepoFixture(), "single-skill-main");
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "rooty-skill", path: skillDir, name: "Rooty Skill" }],
    rootPaths: { "user-agents": userAgents },
    archive,
  });

  const item = await installRoot(env, "a/single-skill");
  assert.equal(item.ok, true, item.message);
  const before = await readLockJson(env.home);

  const dirty = await readLockJson(env.home);
  dirty.skills["Rooty Skill"]!.skillFolderHash = "0".repeat(64);
  await fs.writeFile(lockFilePath(env.ctx), JSON.stringify(dirty, null, 2));

  const applied = await call(env.module as never, "POST skills/updates/apply", {
    body: { ids: ["user-agents:rooty-skill"] },
  });
  const appliedItem = (applied.results as { ok: boolean; message?: string }[])[0]!;
  assert.equal(appliedItem.ok, true, appliedItem.message ?? "");

  const after = await readLockJson(env.home);
  assert.equal(after.skills["Rooty Skill"]!.skillPath, "SKILL.md");
  assert.equal(after.skills["Rooty Skill"]!.skillFolderHash, npxExpectedHash());
  assert.equal(after.skills["Rooty Skill"]!.installedAt, before.skills["Rooty Skill"]!.installedAt, "installedAt 不变");
  assert.deepEqual(
    Object.keys(await readTree(skillDir)).sort(),
    [".gitignore", "README.md", "SKILL.md", "agents/notes.md"],
    "更新写回的内容同样不含元数据目录",
  );
  const leftovers = Object.keys(await readTree(userAgents)).filter((rel) => rel.includes("capability-hub-incoming"));
  assert.deepEqual(leftovers, [], "不该留下 staging 残留");
});

/* =========================== D-2（键与目录名不同） =========================== */

test("FIX-7 D-2 需要清洗的技能名：注册 → 列表 → take/put → 检查更新 → 应用更新 全链路一致", async () => {
  const userAgents = makeTempDir();
  const skillDir = path.join(userAgents, "rooty-skill");
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "rooty-skill", path: skillDir, name: "Rooty Skill" }],
    rootPaths: { "user-agents": userAgents },
    archive: tarGzOf(rootRepoFixture(), "single-skill-main"),
  });

  // ① 键 = 原始技能名（有大写与空格），目录名 = sanitizeName(键)
  const item = await installRoot(env, "a/single-skill");
  assert.equal(item.ok, true, item.message);
  assert.equal(item.skillId, "user-agents:rooty-skill");
  let lock = await readLockJson(env.home);
  assert.deepEqual(Object.keys(lock.skills), ["Rooty Skill"], "lock 键必须是原始技能名");
  assert.equal(lock.skills["Rooty Skill"]!.skillPath, "SKILL.md");

  // ② 列表：skillId 由 sanitizeName(键) 派生 → 与本机技能 id 相同，不是悬空条目
  let entries = await sourceEntries(env);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.skillId, "user-agents:rooty-skill");
  assert.equal(entries[0]!.orphan, false);

  // ③ LockStash：take/put 按 sanitizeName(键) === 目录名 命中；放回后派生结果不变
  const taken = (await env.module.lockStash.take({
    rootId: "user-agents",
    dirName: "rooty-skill",
    path: skillDir,
  })) as SkillLockEntry;
  assert.ok(taken, "take 必须能按目录名找到「键与目录名不同」的条目");
  assert.equal(taken.skillPath, "SKILL.md");
  assert.equal((await readLockJson(env.home)).skills["Rooty Skill"], undefined, "take 应删掉命中的那个键");
  await env.module.lockStash.put({ rootId: "user-agents", dirName: "rooty-skill", path: skillDir }, taken);
  entries = await sourceEntries(env);
  assert.equal(entries[0]!.skillId, "user-agents:rooty-skill", "put 之后派生结果不变");
  assert.equal(entries[0]!.orphan, false);

  // ④ 检查更新：键与目录名不同也要找得到来源 → 最新
  const checked = await checkStatus(env);
  assert.equal(checked.skillId, "user-agents:rooty-skill");
  assert.equal(checked.status, "up-to-date", checked.message ?? "");

  // ⑤ 应用更新：写回哈希与 skillPath 正确，installedAt 不变
  const beforeApply = await readLockJson(env.home);
  const keyBefore = Object.keys(beforeApply.skills)[0]!;
  const installedAt = beforeApply.skills[keyBefore]!.installedAt;
  beforeApply.skills[keyBefore]!.skillFolderHash = "0".repeat(64);
  await fs.writeFile(lockFilePath(env.ctx), JSON.stringify(beforeApply, null, 2));
  const applied = await call(env.module as never, "POST skills/updates/apply", {
    body: { ids: ["user-agents:rooty-skill"] },
  });
  const appliedItem = (applied.results as { ok: boolean; message?: string }[])[0]!;
  assert.equal(appliedItem.ok, true, appliedItem.message ?? "");
  const final = await readLockJson(env.home);
  const finalKey = Object.keys(final.skills)[0]!;
  assert.equal(sanitizeName(finalKey), "rooty-skill", "写回后键的派生目录名仍然是 rooty-skill：" + finalKey);
  assert.equal(final.skills[finalKey]!.skillFolderHash, npxExpectedHash());
  assert.equal(final.skills[finalKey]!.skillPath, "SKILL.md");
  assert.equal(final.skills[finalKey]!.installedAt, installedAt, "installedAt 不变");

  // ⑥ 注册同一个技能：复用已有的键（不产生第二个条目）。注意 register 按 D-B8 的语义把
  //    比较基准换成**本地目录**的哈希，所以这一步放在最后 —— 它只验证「键的复用」。
  const registered = await call(env.module as never, "POST skills/sources/register", {
    body: { skillId: "user-agents:rooty-skill", repo: "a/single-skill", skillPath: "SKILL.md" },
  });
  assert.equal((registered.entry as { skillId: string }).skillId, "user-agents:rooty-skill");
  const afterRegister = await readLockJson(env.home);
  assert.equal(
    Object.keys(afterRegister.skills).length,
    1,
    "注册不得写出第二个键：" + Object.keys(afterRegister.skills).join(", "),
  );
  assert.equal(sanitizeName(Object.keys(afterRegister.skills)[0]!), "rooty-skill");
});

/* =========================== J3 =========================== */

test('FIX-7 J3 浏览：根级技能列成 skillPath = "SKILL.md"，装过的显示已安装（目录名 = sanitizeName(name)）', async () => {
  const userAgents = makeTempDir();
  // 本机已装：目录名是 sanitizeName("My Skill") = "my-skill"；skills-local 读不到 name 的形态
  const installedDir = path.join(userAgents, "my-skill");
  await fs.mkdir(installedDir, { recursive: true });
  await fs.writeFile(path.join(installedDir, "SKILL.md"), "---\nname: My Skill\ndescription: d\n---\n");

  const archive = tarGzOf(
    [
      { path: "SKILL.md", data: "---\nname: My Skill\ndescription: 上游\n---\n" },
      { path: "README.md", data: README_MD },
      ...skillFixture("tools", "other"),
    ],
    "weird_repo_name-main",
  );
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "my-skill", path: installedDir }],
    rootPaths: { "user-agents": userAgents },
    archive,
  });

  const result = await call(env.module as never, "POST skills/repo/browse", { body: { repo: "a/weird_repo_name" } });
  const skills = result.skills as { skillPath: string; dirName: string; name?: string; installedId?: string }[];

  const root = skills.find((s) => s.skillPath === "SKILL.md")!;
  assert.ok(root, "根级 SKILL.md 必须被列出来");
  assert.equal(root.name, "My Skill");
  assert.equal(root.dirName, "weird_repo_name", "根级技能的目录名仍是仓库名（安装时才换成 sanitizeName(name)）");
  assert.equal(root.installedId, "user-agents:my-skill", "按「安装时会用的目录名」也要查一次，否则装完仍显示未安装");

  const other = skills.find((s) => s.skillPath === "skills/tools/other/SKILL.md")!;
  assert.ok(other);
  assert.equal(other.installedId, undefined);

  // 浏览给出的 skillPath 与安装接受的值完全一致（D-B6：列得出 → 装得上）
  await fs.rm(installedDir, { recursive: true, force: true });
  const installItem = await installRoot(env, "a/weird_repo_name");
  assert.equal(installItem.ok, true, installItem.message);
  assert.equal(installItem.skillId, "user-agents:my-skill");

  // 装出来的 lock 条目与本机技能对得上（不是悬空条目）—— 键与 skillId 派生规则自洽
  const entries = await sourceEntries(env);
  const recorded = entries.find((e) => e.skillId === "user-agents:my-skill");
  assert.ok(recorded, "lock 条目的 skillId 必须与本机技能 id 相同：" + entries.map((e) => e.skillId).join(", "));
  assert.equal(recorded.skillPath, "SKILL.md");
  assert.equal(recorded.orphan, false);
});

test("FIX-7 J3 浏览：frontmatter name 与仓库名一致时，根级技能照常标出已安装", async () => {
  const userAgents = makeTempDir();
  const installedDir = path.join(userAgents, "rooty-skill");
  await fs.mkdir(installedDir, { recursive: true });
  await fs.writeFile(path.join(installedDir, "SKILL.md"), ROOT_SKILL_MD);
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "rooty-skill", path: installedDir, name: "Rooty Skill" }],
    rootPaths: { "user-agents": userAgents },
    archive: tarGzOf(rootRepoFixture(), "single-skill-main"),
  });
  const result = await call(env.module as never, "POST skills/repo/browse", { body: { repo: "a/single-skill" } });
  const root = (result.skills as { skillPath: string; installedId?: string }[]).find(
    (s) => s.skillPath === "SKILL.md",
  )!;
  assert.equal(root.installedId, "user-agents:rooty-skill");
});

/* =========================== 单元 =========================== */

test("FIX-7 sanitizeName：与 npx skills（dist/cli.mjs:2183-2185）的规则逐条一致", () => {
  assert.equal(sanitizeName("My Skill"), "my-skill");
  assert.equal(sanitizeName("Rooty_Skill"), "rooty_skill", "下划线在保留集里");
  assert.equal(sanitizeName("a/b"), "a-b");
  assert.equal(sanitizeName("MiXeD.Case"), "mixed.case");
  assert.equal(sanitizeName("--Weird--"), "weird", "首尾的 . 与 - 都要去掉");
  assert.equal(sanitizeName("..."), "unnamed-skill");
  assert.equal(sanitizeName("   "), "unnamed-skill");
  assert.equal(sanitizeName("中文技能"), "unnamed-skill");
  assert.equal(sanitizeName("A".repeat(300)).length, 255, "超长截断到 255");
});
