/**
 * FIX-2：平铺 .md 技能（技能根下直接放 <name>.md）在 skills-remote 里的行为。
 *
 * 调度者决定：平铺 .md 技能**不支持**来源登记、检查更新和更新，一律给出明确的中文说明，
 * 绝不改动文件（这类技能很少见；npx skills 的来源模型以目录为单位，强行支持会引入转换风险）。
 *
 * 本文件覆盖要求 2–5 各至少一条 + 「apply 之后根目录指纹不变」（要求 8），
 * 以及要求 6（GET skills/sources 照常列出历史条目）与要求 7（lockStash take/put 保持现状）。
 *
 * 所有落盘都在临时目录里（PLAN §4 红线）。
 */

import * as YAML from "yaml";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createSkillsRemoteModule } from "../../../src/skills/remote/module.ts";
import { lockFilePath } from "../../../src/skills/remote/lockstore.ts";
import type { FakeApi } from "./helpers.ts";
import { makeCtx, makeFakeApi, makeFakeFetch, makeLogger, makeTempDir, withRootPaths } from "./helpers.ts";

/** 契约要求的统一中文说明（逐字固定，故意在测试里独立写一遍，不复用源码常量） */
const FLAT_MESSAGE = "平铺 .md 技能不支持来源登记与更新，只有目录型技能（<名称>/SKILL.md）支持。";

const FLAT_ID = "user-agents:notes.md";

async function buildModule(
  options: {
    skills?: NonNullable<Parameters<typeof makeFakeApi>[0]>["skills"];
    rootPaths?: Record<string, string>;
  } = {},
) {
  const home = makeTempDir();
  const hubHome = makeTempDir();
  const { logger } = makeLogger();
  const ctx = makeCtx({ homeDir: home, hubHome, logger });
  const skills = makeFakeApi({ skills: options.skills ?? [] });
  if (options.rootPaths) withRootPaths(skills, options.rootPaths);
  const fake = makeFakeFetch([]);
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
  return { home, hubHome, ctx, skills: skills as FakeApi, fake, module };
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

/** 捕获抛出的 HubError（用于断言 status/code/message） */
async function rejection(promise: Promise<unknown>): Promise<{ status?: number; code?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { status?: number; code?: string; message: string };
    return { status: e.status, code: e.code, message: e.message };
  }
  throw new Error("预期抛错，但调用成功了");
}

/** 技能根的指纹：逐条记录「类型 + 相对路径 + 文件内容哈希」，任何增删改都会改变它 */
async function rootFingerprint(rootDir: string): Promise<string> {
  const lines: string[] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        lines.push(`d ${rel}`);
        await visit(abs, rel);
      } else if (entry.isFile()) {
        const data = await fs.readFile(abs);
        lines.push(`f ${rel} ${createHash("sha256").update(data).digest("hex")}`);
      } else {
        lines.push(`o ${rel}`);
      }
    }
  }
  await visit(rootDir, "");
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** 造一个平铺技能：<root>/notes.md（FIX-1 之后 path 就是这个文件） */
async function seedFlatSkill(
  root: string,
  name = "notes.md",
  body = "---\nname: notes\ndescription: 平铺\n---\n\n正文\n",
) {
  const file = path.join(root, name);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(file, body);
  return file;
}

/**
 * 历史数据：lock 里有平铺技能的来源条目。
 * 键用技能名（npx skills 语义，= frontmatter name「notes」），skillPath 是目录形态 ——
 * 这正是 FIX-1 §7.5 描述的真实历史形态（平铺技能的 dirName「notes.md」匹配不上它）。
 */
async function writeFlatLockEntry(ctx: { homeDir: string }): Promise<void> {
  const lockFile = lockFilePath(ctx as never);
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  await fs.writeFile(
    lockFile,
    JSON.stringify({
      version: 3,
      skills: {
        notes: {
          source: "a/b",
          sourceType: "github",
          sourceUrl: "https://github.com/a/b.git",
          skillPath: "skills/x/notes/SKILL.md",
          skillFolderHash: "0".repeat(64),
          installedAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      },
    }),
  );
}

/* ---------- 要求 2：register 明确拒绝 ---------- */

test("FIX-2 登记：平铺 .md 技能 → BAD_REQUEST(400) + 统一中文说明，且不写任何来源", async () => {
  const userAgents = makeTempDir();
  const flat = await seedFlatSkill(userAgents);
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "notes.md", path: flat, name: "notes" }],
    rootPaths: { "user-agents": userAgents },
  });

  const err = await rejection(
    call(env.module as never, "POST skills/sources/register", {
      body: { skillId: FLAT_ID, repo: "a/b" },
    }),
  );
  assert.equal(err.status, 400);
  assert.equal(err.code, "BAD_REQUEST");
  assert.equal(err.message, FLAT_MESSAGE);

  // 没有落盘：lock 文件不应出现
  await assert.rejects(fs.stat(lockFilePath(env.ctx)), "不得写出来源记录");
  // 技能文件逐字节不变
  assert.match(await fs.readFile(flat, "utf8"), /正文/);
});

test("FIX-2 登记：同一批里目录型技能照常登记（拒绝只针对平铺形态）", async () => {
  const userAgents = makeTempDir();
  const flat = await seedFlatSkill(userAgents);
  const dir = path.join(userAgents, "lyco");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: lyco\ndescription: d\n---\n");
  const env = await buildModule({
    skills: [
      { rootId: "user-agents", dirName: "notes.md", path: flat, name: "notes" },
      { rootId: "user-agents", dirName: "lyco", path: dir, name: "lyco" },
    ],
    rootPaths: { "user-agents": userAgents },
  });
  const ok = await call(env.module as never, "POST skills/sources/register", {
    body: { skillId: "user-agents:lyco", repo: "a/b" },
  });
  assert.equal((ok.entry as { repo: string }).repo, "a/b");
  const err = await rejection(
    call(env.module as never, "POST skills/sources/register", { body: { skillId: FLAT_ID, repo: "a/b" } }),
  );
  assert.equal(err.message, FLAT_MESSAGE);
});

/* ---------- 要求 3：discover 显式跳过 ---------- */

test("FIX-2 来源推测：平铺技能不给出候选（显式跳过，不靠 walkFiles 恰好返回空）", async () => {
  const userAgents = makeTempDir();
  const link = "见 https://raw.githubusercontent.com/lilyco-42/lyco-skill/main/docs/logo.png\n";
  // 平铺技能的文件内容里**故意**放一条 github 链接，并且把 name 取成「skills」——
  // 预置仓库 anthropics/skills 的仓库名正是 skills，于是「按名字匹配」这一支本来会产出
  // medium 候选。这样本用例的通过**只能**来自显式跳过，而不是 walkFiles 恰好返回空。
  const flat = await seedFlatSkill(userAgents, "notes.md", `---\nname: skills\ndescription: 平铺\n---\n\n${link}`);
  const dir = path.join(userAgents, "lyco");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: lyco\ndescription: d\n---\n");
  await fs.writeFile(path.join(dir, "install.ps1"), link);
  const env = await buildModule({
    skills: [
      { rootId: "user-agents", dirName: "notes.md", path: flat, name: "skills" },
      { rootId: "user-agents", dirName: "lyco", path: dir, name: "lyco" },
    ],
    rootPaths: { "user-agents": userAgents },
  });

  const result = await call(env.module as never, "POST skills/sources/discover", { body: {} });
  const candidates = result.candidates as { skillId: string; repo: string }[];
  assert.equal(candidates.filter((c) => c.skillId === FLAT_ID).length, 0, "平铺技能不得出现候选");
  assert.ok(
    candidates.some((c) => c.skillId === "user-agents:lyco" && c.repo === "lilyco-42/lyco-skill"),
    "目录型技能照常扫到链接",
  );
  // 只给候选，不登记
  assert.equal(((await call(env.module as never, "GET skills/sources", { query: {} })).entries as unknown[]).length, 0);
});

/* ---------- 要求 4：check 为 no-source，且不下载 ---------- */

test("FIX-2 检查更新：平铺技能 → no-source + 统一说明；即使有登记来源也不下载", async () => {
  const userAgents = makeTempDir();
  const flat = await seedFlatSkill(userAgents);
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "notes.md", path: flat, name: "notes" }],
    rootPaths: { "user-agents": userAgents },
  });
  await writeFlatLockEntry(env.ctx);

  const result = await call(env.module as never, "POST skills/updates/check", { body: {} });
  const items = result.results as { skillId: string; status: string; message?: string }[];
  assert.equal(items.length, 1);
  assert.equal(items[0]!.skillId, FLAT_ID);
  assert.equal(items[0]!.status, "no-source");
  assert.equal(items[0]!.message, FLAT_MESSAGE);
  // 「不下载」的证据：整个过程没有任何网络请求
  assert.equal(env.fake.calls.length, 0, "平铺技能不该触发任何下载");
  // 历史来源条目仍在（没被删改）
  assert.equal(((await call(env.module as never, "GET skills/sources", { query: {} })).entries as unknown[]).length, 1);
});

/* ---------- 要求 5 + 要求 8：apply 拒绝，且零文件改动 ---------- */

test("FIX-2 应用更新：平铺技能 → ok:false + 统一说明；技能根指纹逐字节不变（零改动）", async () => {
  const userAgents = makeTempDir();
  const flat = await seedFlatSkill(userAgents);
  await fs.writeFile(path.join(userAgents, "README.md"), "# 根目录下的普通文件\n");
  const otherDir = path.join(userAgents, "lyco");
  await fs.mkdir(otherDir, { recursive: true });
  await fs.writeFile(path.join(otherDir, "SKILL.md"), "---\nname: lyco\ndescription: d\n---\n");

  const env = await buildModule({
    skills: [
      { rootId: "user-agents", dirName: "notes.md", path: flat, name: "notes" },
      { rootId: "user-agents", dirName: "lyco", path: otherDir, name: "lyco" },
    ],
    rootPaths: { "user-agents": userAgents },
  });
  await writeFlatLockEntry(env.ctx);

  const before = await rootFingerprint(userAgents);
  const lockBefore = await fs.readFile(lockFilePath(env.ctx), "utf8");

  const result = await call(env.module as never, "POST skills/updates/apply", { body: { ids: [FLAT_ID] } });
  const item = (result.results as { skillId: string; ok: boolean; message?: string; trashId?: string }[])[0]!;
  assert.equal(item.skillId, FLAT_ID);
  assert.equal(item.ok, false);
  assert.equal(item.message, FLAT_MESSAGE);
  assert.equal(item.trashId, undefined, "不得产生回收站条目");

  // 零文件改动
  assert.equal(await rootFingerprint(userAgents), before, "技能根必须逐字节不变");
  assert.equal((await fs.lstat(flat)).isFile(), true, "平铺技能仍然必须是一个文件（不得被换成目录）");
  assert.deepEqual((await fs.readdir(userAgents)).sort(), ["README.md", "lyco", "notes.md"], "不得留下 staging 目录");
  assert.equal(env.skills.moveToTrashCalls.length, 0, "不得调用 moveToTrash");
  assert.equal(env.skills.trash.size, 0, "回收站必须是空的");
  assert.equal(env.fake.calls.length, 0, "不得下载");
  assert.equal(await fs.readFile(lockFilePath(env.ctx), "utf8"), lockBefore, "lock 不得被改动");
});

/* ---------- 要求 6：GET skills/sources 照常列出历史条目 ---------- */

test("FIX-2 GET skills/sources：历史数据里的平铺技能来源照常列出，不报错", async () => {
  const userAgents = makeTempDir();
  const flat = await seedFlatSkill(userAgents);
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "notes.md", path: flat, name: "notes" }],
    rootPaths: { "user-agents": userAgents },
  });
  await writeFlatLockEntry(env.ctx);
  const listed = await call(env.module as never, "GET skills/sources", { query: {} });
  const entries = listed.entries as { repo: string; skillId: string }[];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.repo, "a/b");
});

/* ---------- 要求 7：lockStash 的 take/put 保持现状 ---------- */

test("FIX-2 lockStash：平铺技能（path 是文件）下 take 返回 undefined、put 不崩也不改 lock", async () => {
  const userAgents = makeTempDir();
  const flat = await seedFlatSkill(userAgents);
  const env = await buildModule({
    skills: [{ rootId: "user-agents", dirName: "notes.md", path: flat, name: "notes" }],
    rootPaths: { "user-agents": userAgents },
  });

  // lock 文件不存在时 take 直接 undefined
  assert.equal(await env.module.lockStash.take({ rootId: "user-agents", dirName: "notes.md", path: flat }), undefined);

  // 有历史条目时，平铺技能的 dirName（含 .md）匹配不上 lock 键，兜底匹配
  // （skillPath.includes('/notes.md/')）也匹配不上 → 仍然 undefined（不崩，条目原样留着）
  await writeFlatLockEntry(env.ctx);
  const lockBefore = await fs.readFile(lockFilePath(env.ctx), "utf8");
  assert.equal(await env.module.lockStash.take({ rootId: "user-agents", dirName: "notes.md", path: flat }), undefined);
  assert.equal(await fs.readFile(lockFilePath(env.ctx), "utf8"), lockBefore, "take 失败不得改动 lock");

  // put 是 no-op + 不崩（skills-local 删除/恢复平铺技能时会调到这里）
  await env.module.lockStash.put({ rootId: "user-agents", dirName: "notes.md", path: flat }, { anything: true });
  // user-dsh 根（非 lock-backed）本来就是 no-op
  await env.module.lockStash.put({ rootId: "user-dsh", dirName: "notes.md", path: flat }, { anything: true });
  assert.equal((await fs.stat(flat)).isFile(), true, "stash 操作不得碰技能文件");
});

/* ---------- 形态判断本身 ---------- */

test("FIX-2 形态判断：path 是目录 → 不是平铺；path 是文件 → 是平铺；path 不存在时按 dirName 兜底", async () => {
  const { isFlatSkill, isFlatDirName } = await import("../../../src/skills/remote/skillshape.ts");
  const dirRoot = makeTempDir();
  const dir = path.join(dirRoot, "lyco");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "x");
  const file = await seedFlatSkill(dirRoot);

  assert.equal(await isFlatSkill({ dirName: "lyco", path: dir }), false);
  assert.equal(await isFlatSkill({ dirName: "notes.md", path: file }), true);
  // 「dirName 以 .md 结尾但 path 是目录」→ 按目录型处理（不看名字）
  assert.equal(await isFlatSkill({ dirName: "weird.md", path: dir }), false);
  // path 不存在 → 退回命名形态
  assert.equal(await isFlatSkill({ dirName: "gone.md", path: path.join(dirRoot, "gone.md") }), true);
  assert.equal(await isFlatSkill({ dirName: "gone", path: path.join(dirRoot, "gone") }), false);
  assert.equal(isFlatDirName("NOTES.MD"), true);
  assert.equal(isFlatDirName("notes"), false);
});
