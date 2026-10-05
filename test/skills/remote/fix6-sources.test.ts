/**
 * FIX-6 测试：skills-remote 的 4 个来源相关缺陷（T4a-2 走查发现）。
 *
 *   D-1 根级 skillPath 的 skillId 派生（lock 键 = 本地目录名）+ 反查一致性
 *   D-2 候选 / 已登记条目的 skillPath 永远是「仓库内相对路径」
 *   D-3 每个 GitHub 响应（成功或失败）都记录配额；github-auth 主动查 /rate_limit
 *   D-4 GitHub 保留路径不会被当成候选仓库
 *
 * 全部落盘都在 os.tmpdir() 下的临时目录里，绝不碰真实用户目录（PLAN §4）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSkillsRemoteModule } from '../../../src/skills/remote/module.ts';
import { createSourceStore, lockEntryToSourceEntry, lockFilePath } from '../../../src/skills/remote/lockstore.ts';
import { GitHubClient } from '../../../src/skills/remote/github.ts';
import { describeUnsafePath } from '../../../src/skills/remote/safepath.ts';
import type { SkillLockEntry } from '../../../src/skills/remote/types.ts';
import { jsonResponse, makeCtx, makeFakeApi, makeFakeFetch, makeLogger, makeTempDir, withRootPaths, writeTree } from './helpers.ts';
import { repoArchive, skillFixture } from './tarfixture.ts';

const ROOT_SKILL_MD = '---\nname: rooty\ndescription: d\n---\n\n正文。\n';
const TOKEN = 'ghp_' + 'q'.repeat(36);

/** D-4：GitHub 的保留一级路径 —— 都不该被当成候选仓库 */
const RESERVED_OWNERS = [
  'sponsors', 'orgs', 'apps', 'marketplace', 'settings', 'features', 'topics', 'collections',
  'explore', 'login', 'about', 'pricing', 'enterprise', 'issues', 'pulls', 'notifications',
  'search', 'users', 'site', 'security', 'customer-stories', 'readme',
];

type FakeRoutes = Parameters<typeof makeFakeFetch>[0];
type FakeSkills = NonNullable<Parameters<typeof makeFakeApi>[0]>['skills'];

interface EnvOptions {
  skills?: FakeSkills;
  rootPaths?: Record<string, string>;
  routes?: FakeRoutes;
  envToken?: string;
}

async function buildModule(options: EnvOptions = {}) {
  const home = makeTempDir();
  const hubHome = makeTempDir();
  const sink: ReturnType<typeof makeLogger>['sink'] = [];
  const { logger } = makeLogger(sink);
  const ctx = makeCtx({ homeDir: home, hubHome, logger });
  const skills = makeFakeApi({ skills: options.skills ?? [] });
  if (options.rootPaths) withRootPaths(skills, options.rootPaths);
  const fake = makeFakeFetch(options.routes ?? []);
  const module = createSkillsRemoteModule(ctx, { skills }, {
    fetchImpl: fake.fetch,
    envTokenProvider: () => options.envToken,
    ghTokenProvider: async () => undefined,
    cacheAuth: false,
  });
  return { home, hubHome, ctx, skills, fake, module, sink };
}

function call(
  module: { routes: Record<string, (r: never) => Promise<unknown>> },
  key: string,
  req: { query?: Record<string, string>; body?: unknown } = {}
): Promise<Record<string, unknown>> {
  const handler = module.routes[key];
  if (!handler) throw new Error('路由不存在：' + key);
  return handler({ query: req.query ?? {}, body: req.body, signal: new AbortController().signal } as never) as Promise<Record<string, unknown>>;
}

function rejection(promise: Promise<unknown>): Promise<{ status?: number; code?: string; message?: string }> {
  return promise.then(
    () => {
      throw new Error('期望抛错，但成功返回了');
    },
    (error: { status?: number; code?: string; message?: string }) => error
  );
}

async function readLockJson(home: string): Promise<{ version: number; skills: Record<string, SkillLockEntry> }> {
  return JSON.parse(await fs.readFile(path.join(home, '.agents', '.skill-lock.json'), 'utf8')) as {
    version: number;
    skills: Record<string, SkillLockEntry>;
  };
}

/** E2：skillPath 必须是「仓库内相对路径」——不得绝对、不得含盘符、不得含本机 home */
function assertRepoRelative(value: string, what: string): void {
  assert.equal(typeof value, 'string', what + ' 必须是字符串');
  assert.notEqual(value.trim(), '', what + ' 不能为空');
  assert.equal(describeUnsafePath(value), undefined, what + ' 不安全：' + value);
  assert.equal(path.isAbsolute(value), false, what + ' 不能是绝对路径：' + value);
  assert.equal(/^[A-Za-z]:/.test(value), false, what + ' 不能含盘符：' + value);
  assert.equal(value.includes('\\'), false, what + ' 必须用正斜杠：' + value);
  const homeSlash = os.homedir().replace(/\\/g, '/').toLowerCase();
  assert.equal(value.toLowerCase().includes(homeSlash), false, what + ' 不能含本机 home 路径：' + value);
}

/** 取一次「已知剩余额度」（包成函数，避免 TS 对属性访问做控制流收窄） */
function lastRemaining(client: GitHubClient): number | undefined {
  return client.lastKnownRateLimit?.remaining;
}

function lockEntry(partial: Partial<SkillLockEntry> = {}): SkillLockEntry {
  const entry: SkillLockEntry = {
    source: 'a/b',
    sourceType: 'github',
    sourceUrl: 'https://github.com/a/b.git',
    installedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...partial,
  };
  return entry;
}

/** 造一个「本机克隆」：<root>/clone/.git/config（origin 可指定）+ <root>/clone/<subPath>/ */
async function seedFakeClone(root: string, originUrl: string, subPath: string, link: string, name = 'lyco'): Promise<string> {
  const clone = path.join(root, 'clone');
  const dir = path.join(clone, ...subPath.split('/'));
  await writeTree(dir, {
    'SKILL.md': '---\nname: ' + name + '\ndescription: d\n---\n',
    'notes.md': '参考文档：' + link + '\n',
  });
  await writeTree(clone, {
    '.git/config':
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ' + originUrl + '\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
  });
  return dir;
}

/* =========================== D-1 =========================== */

test('FIX-6 D-1 单元：lock 条目 → skillId 一律由 lock 键派生（根级 / 多级 / 键与路径不同）', () => {
  // 根级技能：npx skills 写的就是 skillPath = "SKILL.md"
  const root = lockEntryToSourceEntry('rooty', lockEntry({ skillPath: 'SKILL.md' }));
  assert.equal(root.skillId, 'user-agents:rooty', '旧实现会派生出 user-agents:SKILL.md');
  assert.equal(root.skillPath, 'SKILL.md');

  // 多级路径
  const nested = lockEntryToSourceEntry('grilling', lockEntry({ skillPath: 'skills/productivity/grilling/SKILL.md' }));
  assert.equal(nested.skillId, 'user-agents:grilling');
  assert.equal(nested.skillPath, 'skills/productivity/grilling/SKILL.md');

  // 键与 skillPath 的父目录名不同 → 以键为准（skillPath 只表示仓库内的位置）
  const mismatch = lockEntryToSourceEntry('grilling', lockEntry({ skillPath: 'skills/productivity/v2-grilling/SKILL.md' }));
  assert.equal(mismatch.skillId, 'user-agents:grilling', '目录名来自 lock 键，不是 skillPath 的父目录');

  // 老数据没有 skillPath（CLI 的 legacy 条目）→ 退回目录名，仍是仓库内相对路径
  const legacy = lockEntryToSourceEntry('grilling', lockEntry());
  assert.equal(legacy.skillId, 'user-agents:grilling');
  assert.equal(legacy.skillPath, 'grilling/SKILL.md');
  assertRepoRelative(legacy.skillPath, 'legacy skillPath');
});

test('FIX-6 D-1：根级 skillPath 的登记、列表与反查一致（register → sources → take/put → 检查/应用更新）', async () => {
  const userAgents = makeTempDir();
  const skillDir = path.join(userAgents, 'rooty');
  await writeTree(skillDir, { 'SKILL.md': ROOT_SKILL_MD });
  const upstream = repoArchive([{ path: 'SKILL.md', data: ROOT_SKILL_MD }], { root: 'rooty-main' });
  const env = await buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'rooty', path: skillDir, name: 'rooty' }],
    rootPaths: { 'user-agents': userAgents },
    routes: [
      { match: (u) => u.includes('/repos/'), response: () => jsonResponse({ default_branch: 'main' }) },
      { match: (u) => u.includes('codeload'), response: () => new Response(new Uint8Array(upstream), { status: 200 }) },
    ],
  });

  // ① 登记：skillPath = "SKILL.md"（技能位于仓库根）
  const registered = await call(env.module as never, 'POST skills/sources/register', {
    body: { skillId: 'user-agents:rooty', repo: 'a/b', skillPath: 'SKILL.md' },
  });
  const entry = registered.entry as { skillId: string; skillPath: string };
  assert.equal(entry.skillId, 'user-agents:rooty');
  assert.equal(entry.skillPath, 'SKILL.md');

  const lock = await readLockJson(env.home);
  assert.equal(lock.skills['rooty']?.skillPath, 'SKILL.md');
  assert.equal(lock.skills['rooty']?.source, 'a/b');

  // ② 列表：skillId 与技能 id 对齐，不是悬空条目
  const listed = await call(env.module as never, 'GET skills/sources', { query: {} });
  const entries = listed.entries as { skillId: string; skillPath: string; orphan: boolean }[];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.skillId, 'user-agents:rooty');
  assert.equal(entries[0]!.skillPath, 'SKILL.md');
  assert.equal(entries[0]!.orphan, false, '根级技能不该被标记成悬空条目');

  // ③ 反查（LockStash）：按本地目录名取出 / 放回，条目逐字段原样恢复
  const taken = (await env.module.lockStash.take({ rootId: 'user-agents', dirName: 'rooty', path: skillDir })) as SkillLockEntry;
  assert.equal(taken.skillPath, 'SKILL.md');
  assert.equal((await readLockJson(env.home)).skills['rooty'], undefined, 'take 后条目应被移除');
  await env.module.lockStash.put({ rootId: 'user-agents', dirName: 'rooty', path: skillDir }, taken);
  const restored = await readLockJson(env.home);
  assert.deepEqual(restored.skills['rooty'], lock.skills['rooty'], 'put 后条目逐字段一致');

  // ④ 检查更新：根级 skillPath 要能定位到「仓库根」，而不是报「上游找不到」
  const checked = await call(env.module as never, 'POST skills/updates/check', { body: {} });
  const item = (checked.results as { skillId: string; status: string; message?: string }[])[0]!;
  assert.equal(item.skillId, 'user-agents:rooty');
  assert.equal(item.status, 'up-to-date', item.message ?? '');

  // ⑤ 应用更新：写回的 skillPath 必须是 "SKILL.md"（旧写法会写出 "/SKILL.md"）
  const dirty = await readLockJson(env.home);
  dirty.skills['rooty']!.skillFolderHash = '0'.repeat(64);
  await fs.writeFile(lockFilePath(env.ctx), JSON.stringify(dirty, null, 2));

  const applied = await call(env.module as never, 'POST skills/updates/apply', { body: { ids: ['user-agents:rooty'] } });
  const appliedItem = (applied.results as { ok: boolean; message?: string }[])[0]!;
  assert.equal(appliedItem.ok, true, appliedItem.message ?? '');

  const after = await readLockJson(env.home);
  assert.equal(after.skills['rooty']!.skillPath, 'SKILL.md');
  assertRepoRelative(after.skills['rooty']!.skillPath, '写回的 skillPath');
  assert.equal(after.skills['rooty']!.installedAt, lock.skills['rooty']!.installedAt, 'installedAt 必须不变');
  assert.match(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), /name: rooty/);
});

test('FIX-6 D-1：lock 键与本地目录名不同（大小写 / 只有 skillPath 对得上）时反查仍然一致', async () => {
  const home = makeTempDir();
  const hubHome = makeTempDir();
  await writeTree(home, {
    '.agents/.skill-lock.json': JSON.stringify(
      {
        version: 3,
        skills: {
          Grilling: lockEntry({ skillPath: 'skills/productivity/grilling/SKILL.md' }),
          'legacy-key': lockEntry({ skillPath: 'skills/tools/lyco/SKILL.md' }),
        },
      },
      null,
      2
    ),
  });
  const ctx = makeCtx({ homeDir: home, hubHome });
  const sources = createSourceStore(ctx);

  // 大小写不同（Windows 目录名不区分大小写）→ 仍读得到同一条
  const folded = await sources.get({ rootId: 'user-agents', dirName: 'grilling', path: '/tmp/grilling' }, 'grilling');
  assert.equal(folded?.lockName, 'Grilling');
  assert.equal(folded?.entry.repo, 'a/b');
  assertRepoRelative(folded!.entry.skillPath, '反查到的 skillPath');

  // 只有 skillPath 的父目录名对得上（键完全不同）→ 唯一命中的兜底
  const viaPath = (await sources.stash.take({ rootId: 'user-agents', dirName: 'lyco', path: '/tmp/lyco' })) as SkillLockEntry;
  assert.equal(viaPath.source, 'a/b');
  const after = await readLockJson(home);
  assert.equal(after.skills['legacy-key'], undefined, 'take 应删掉命中的那个键');
  assert.ok(after.skills['Grilling'], '其他条目不受影响');

  // 写侧复用同一个键：登记同名技能不会写出重复条目
  await sources.upsert(
    { rootId: 'user-agents', dirName: 'grilling', path: '/tmp/grilling' },
    { skillId: 'user-agents:grilling', repo: 'a/b', skillPath: 'skills/productivity/grilling/SKILL.md', store: 'skill-lock' },
    'grilling'
  );
  const written = await readLockJson(home);
  assert.deepEqual(Object.keys(written.skills), ['Grilling'], '不应新增键（大小写不同的老键被复用）');
});

test('FIX-6 D-2 防护：lock 里历史遗留的绝对路径 skillPath 读出时被归一，且不改写文件', async () => {
  const home = makeTempDir();
  const hubHome = makeTempDir();
  const lockText = JSON.stringify(
    {
      version: 3,
      skills: {
        archify: lockEntry({ skillPath: 'C:/Users/you/.agents/skills/archify/SKILL.md' }),
        lyco: lockEntry({ skillPath: '/home/you/.agents/skills/lyco/SKILL.md' }),
      },
    },
    null,
    2
  );
  await writeTree(home, { '.agents/.skill-lock.json': lockText });
  const sources = createSourceStore(makeCtx({ homeDir: home, hubHome }));

  const listed = await sources.list();
  const byId = new Map(listed.map((e) => [e.skillId, e]));
  assert.equal(byId.get('user-agents:archify')?.skillPath, 'archify/SKILL.md');
  assert.equal(byId.get('user-agents:lyco')?.skillPath, 'lyco/SKILL.md');
  for (const entry of listed) assertRepoRelative(entry.skillPath, entry.skillId + ' 的 skillPath');
  assert.equal(await fs.readFile(path.join(home, '.agents', '.skill-lock.json'), 'utf8'), lockText, '读侧归一只改视图，不动文件');
});

/* =========================== D-2 =========================== */

test('FIX-6 D-2：技能目录是本机克隆时，候选 skillPath 用仓库内相对路径（不再是本机绝对路径）', async () => {
  const tmp = makeTempDir();
  const dir = await seedFakeClone(tmp, 'https://github.com/lilyco-42/lyco-skill.git', 'skills/lyco', 'https://github.com/lilyco-42/lyco-skill');
  const env = await buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'lyco', path: dir, name: 'lyco' }],
    rootPaths: { 'user-agents': tmp },
  });

  const result = await call(env.module as never, 'POST skills/sources/discover', { body: {} });
  const candidates = result.candidates as { repo: string; skillPath: string; confidence: string; reason: string }[];
  const hit = candidates.find((c) => c.repo === 'lilyco-42/lyco-skill');
  assert.ok(hit, '应找到链接候选');
  assert.equal(hit.skillPath, 'skills/lyco/SKILL.md');
  assert.equal(hit.confidence, 'high');
  assertRepoRelative(hit.skillPath, '克隆里的候选 skillPath');
  // 旧实现这里会是本机绝对路径（C:/Users/you/.../clone/skills/lyco/SKILL.md）
  assert.equal(hit.skillPath.includes(tmp.replace(/\\/g, '/')), false);
});

test('FIX-6 D-2：本机不在 git 工作区时降为 low 并写明原因，skillPath 仍是相对路径', async () => {
  const userAgents = makeTempDir();
  const dir = path.join(userAgents, 'lyco');
  await writeTree(dir, {
    'SKILL.md': '---\nname: lyco\ndescription: d\n---\n',
    'notes.md': '参考 https://github.com/lilyco-42/lyco-skill\n',
  });
  const env = await buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'lyco', path: dir, name: 'lyco' }],
    rootPaths: { 'user-agents': userAgents },
  });

  const result = await call(env.module as never, 'POST skills/sources/discover', { body: {} });
  const candidates = result.candidates as { repo: string; skillPath: string; confidence: string; reason: string }[];
  const hit = candidates.find((c) => c.repo === 'lilyco-42/lyco-skill');
  assert.ok(hit);
  assert.equal(hit.confidence, 'low', '算不出仓库内位置 → 降为 low');
  assert.equal(hit.skillPath, 'lyco/SKILL.md');
  assert.match(hit.reason, /无法确定它在仓库内的位置/);
  assert.match(hit.reason, /技能目录内的文件里出现了/, '原有理由仍然保留');
  assertRepoRelative(hit.skillPath, '非克隆场景的候选 skillPath');

  // 登记这个候选后，来源记录里也必须是相对路径
  const registered = await call(env.module as never, 'POST skills/sources/register', {
    body: { skillId: 'user-agents:lyco', repo: 'lilyco-42/lyco-skill', skillPath: hit.skillPath },
  });
  const entry = registered.entry as { skillPath: string; skillId: string };
  assert.equal(entry.skillId, 'user-agents:lyco');
  assertRepoRelative(entry.skillPath, '登记后的 skillPath');
  assert.equal((await readLockJson(env.home)).skills['lyco']?.skillPath, 'lyco/SKILL.md');
});

test('FIX-6 D-2：本机 .git 的 origin 是别的仓库时，不拿它的目录布局（降为 low）', async () => {
  const tmp = makeTempDir();
  const dir = await seedFakeClone(tmp, 'https://github.com/someone/else.git', 'skills/lyco', 'https://github.com/lilyco-42/lyco-skill');
  const env = await buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'lyco', path: dir, name: 'lyco' }],
    rootPaths: { 'user-agents': tmp },
  });
  const result = await call(env.module as never, 'POST skills/sources/discover', { body: {} });
  const candidates = result.candidates as { repo: string; skillPath: string; confidence: string }[];
  const hit = candidates.find((c) => c.repo === 'lilyco-42/lyco-skill');
  assert.ok(hit);
  assert.equal(hit.confidence, 'low');
  assert.equal(hit.skillPath, 'lyco/SKILL.md');
  assertRepoRelative(hit.skillPath, 'origin 不匹配时的候选 skillPath');
});

test('FIX-6 D-2：按仓库名匹配的候选（medium）同样使用仓库内相对路径', async () => {
  const tmp = makeTempDir();
  const dir = await seedFakeClone(tmp, 'git@github.com:anthropics/skills.git', 'skills/pdf', 'https://example.com/x', 'skills');
  const env = await buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'skills', path: dir, name: 'skills' }],
    rootPaths: { 'user-agents': tmp },
  });
  const result = await call(env.module as never, 'POST skills/sources/discover', { body: {} });
  const candidates = result.candidates as { repo: string; skillPath: string; confidence: string }[];
  const medium = candidates.find((c) => c.repo === 'anthropics/skills' && c.confidence === 'medium');
  assert.ok(medium, '预置仓库 anthropics/skills 的仓库名是 skills，应给出 medium 候选');
  assert.equal(medium.skillPath, 'skills/pdf/SKILL.md');
  assertRepoRelative(medium.skillPath, '名字匹配候选的 skillPath');
});

test('FIX-6 D-2 防护：一批技能的候选路径全都不含本机路径（汇总断言）', async () => {
  const tmp = makeTempDir();
  const clone = await seedFakeClone(tmp, 'https://github.com/lilyco-42/lyco-skill.git', 'skills/lyco', 'https://github.com/lilyco-42/lyco-skill');
  const plain = path.join(tmp, 'plain');
  await writeTree(plain, {
    'SKILL.md': '---\nname: plain\ndescription: d\n---\n',
    'notes.md': '见 https://github.com/mattpocock/skills 与 https://raw.githubusercontent.com/anthropics/skills/main/x.md\n',
  });
  const env = await buildModule({
    skills: [
      { rootId: 'user-agents', dirName: 'lyco', path: clone, name: 'lyco' },
      { rootId: 'user-agents', dirName: 'plain', path: plain, name: 'plain' },
    ],
    rootPaths: { 'user-agents': tmp },
  });
  const result = await call(env.module as never, 'POST skills/sources/discover', { body: {} });
  const candidates = result.candidates as { repo: string; skillPath: string }[];
  assert.ok(candidates.length >= 3, '应有多个候选，实际 ' + candidates.length);
  for (const candidate of candidates) {
    assertRepoRelative(candidate.skillPath, candidate.repo + ' 的候选 skillPath');
  }
});

test('FIX-6 D-2 防护：登记时给出本机绝对路径 → BAD_REQUEST(400)，且不写任何来源', async () => {
  const userAgents = makeTempDir();
  const dir = path.join(userAgents, 'lyco');
  await writeTree(dir, { 'SKILL.md': '---\nname: lyco\ndescription: d\n---\n' });
  const env = await buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'lyco', path: dir, name: 'lyco' }],
    rootPaths: { 'user-agents': userAgents },
  });

  for (const bad of ['C:/Users/you/.agents/skills/lyco/SKILL.md', 'C:\\Users\\you\\.agents\\skills\\lyco\\SKILL.md', '/home/you/.agents/skills/lyco/SKILL.md']) {
    const err = await rejection(
      call(env.module as never, 'POST skills/sources/register', { body: { skillId: 'user-agents:lyco', repo: 'a/b', skillPath: bad } })
    );
    assert.equal(err.status, 400, bad);
    assert.equal(err.code, 'BAD_REQUEST', bad);
    assert.match(String(err.message), /不安全/, bad);
    await assert.rejects(fs.stat(lockFilePath(env.ctx)), '拒绝时不得落盘');
  }
});

/* =========================== D-3 =========================== */

test('FIX-6 D-3：成功响应也记录 x-ratelimit-*（默认分支 / 下载 / 搜索三条成功路径）', async () => {
  const sink: ReturnType<typeof makeLogger>['sink'] = [];
  const { logger } = makeLogger(sink);
  const archive = repoArchive([{ path: 'SKILL.md', data: ROOT_SKILL_MD }], { root: 'demo-main' });
  const fake = makeFakeFetch([
    { match: (u) => u.includes('/repos/'), response: () => jsonResponse({ default_branch: 'main' }, { headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1800000000' } }) },
    { match: (u) => u.includes('codeload'), response: () => new Response(new Uint8Array(archive), { status: 200, headers: { 'x-ratelimit-remaining': '4321' } }) },
    { match: (u) => u.includes('skills.sh'), response: () => jsonResponse({ skills: [] }, { headers: { 'x-ratelimit-remaining': '77' } }) },
  ]);
  const client = new GitHubClient({
    fetchImpl: fake.fetch as unknown as typeof fetch,
    logger,
    envTokenProvider: () => undefined,
    ghTokenProvider: async () => undefined,
  });

  assert.equal(client.lastKnownRateLimit, undefined, '初始未知');
  await client.defaultBranch('a/b');
  assert.equal(lastRemaining(client), 4999, '成功的仓库查询也要记录配额');
  await client.searchSkillsSh('pdf');
  assert.equal(lastRemaining(client), 77, '成功的 skills.sh 查询也要记录配额');
  await client.downloadTarball('a/b');
  assert.equal(lastRemaining(client), 4321, '成功的下载也要记录配额');
});

test('FIX-6 D-3：GET skills/github-auth 用 /rate_limit 取额度；失败时省略该字段、不报错', async () => {
  // ① 成功：数字形式的 remaining
  const ok = await buildModule({
    routes: [
      {
        match: (u) => u.includes('/rate_limit'),
        response: () => jsonResponse({ resources: { core: { limit: 5000, remaining: 4999, reset: 1800000000 } }, rate: { limit: 5000, remaining: 4999, reset: 1800000000 } }),
      },
    ],
  });
  const okResult = await call(ok.module as never, 'GET skills/github-auth', { query: {} });
  assert.equal(okResult.mode, 'anonymous');
  assert.equal(typeof okResult.rateLimitRemaining, 'number');
  assert.equal(okResult.rateLimitRemaining, 4999);
  assert.ok(ok.fake.calls.some((c) => c.url === 'https://api.github.com/rate_limit'), '应调用 /rate_limit（该端点不消耗配额）');

  // ② HTTP 失败 → 省略字段，不抛错
  const httpFail = await buildModule({ routes: [{ match: (u) => u.includes('/rate_limit'), response: () => new Response('nope', { status: 500 }) }] });
  const httpResult = await call(httpFail.module as never, 'GET skills/github-auth', { query: {} });
  assert.equal('rateLimitRemaining' in httpResult, false);
  assert.equal(httpResult.mode, 'anonymous');

  // ③ 网络错误 → 同样省略字段，不抛错
  const netFail = await buildModule({
    routes: [
      {
        match: (u) => u.includes('/rate_limit'),
        response: () => {
          throw new Error('模拟网络中断');
        },
      },
    ],
  });
  const netResult = await call(netFail.module as never, 'GET skills/github-auth', { query: {} });
  assert.equal('rateLimitRemaining' in netResult, false);
  assert.equal(JSON.stringify(netFail.sink).includes('模拟网络中断'), true, '失败只记日志、不报错');
});

test('FIX-6 D-3：检查更新的响应带数字形式的剩余配额（成功路径也会记录）', async () => {
  const userAgents = makeTempDir();
  const dir = path.join(userAgents, 'grilling');
  await writeTree(dir, { 'SKILL.md': '---\nname: grilling\ndescription: d\n---\n' });
  const archive = repoArchive(skillFixture('productivity', 'grilling'), { root: 'skills-main' });
  const env = await buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'grilling', path: dir, name: 'grilling' }],
    rootPaths: { 'user-agents': userAgents },
    routes: [
      { match: (u) => u.includes('/repos/'), response: () => jsonResponse({ default_branch: 'main' }, { headers: { 'x-ratelimit-remaining': '4998' } }) },
      { match: (u) => u.includes('codeload'), response: () => new Response(new Uint8Array(archive), { status: 200, headers: { 'x-ratelimit-remaining': '4997' } }) },
    ],
  });

  await call(env.module as never, 'POST skills/sources/register', {
    body: { skillId: 'user-agents:grilling', repo: 'mattpocock/skills', skillPath: 'skills/productivity/grilling/SKILL.md' },
  });
  const checked = await call(env.module as never, 'POST skills/updates/check', { body: {} });
  assert.equal(typeof checked.rateLimitRemaining, 'number', '成功路径的配额必须被记录并返回');
  assert.equal(checked.rateLimitRemaining, 4997);
});

test('FIX-6 D-3：/rate_limit 探测带上令牌，但令牌绝不出现在响应与日志里', async () => {
  const env = await buildModule({
    envToken: TOKEN,
    routes: [
      {
        match: (u) => u.includes('/rate_limit'),
        response: () => jsonResponse({ resources: { core: { limit: 5000, remaining: 1234, reset: 1800000000 } } }),
      },
    ],
  });
  const result = await call(env.module as never, 'GET skills/github-auth', { query: {} });
  assert.equal(result.mode, 'env');
  assert.equal(result.rateLimitRemaining, 1234);
  assert.equal(JSON.stringify(result).includes(TOKEN), false, '响应里不得出现令牌');
  assert.equal(JSON.stringify(env.sink).includes(TOKEN), false, '日志里不得出现令牌');
  const probe = env.fake.calls.find((c) => c.url.includes('/rate_limit'));
  assert.equal(probe?.headers['authorization'], 'Bearer ' + TOKEN, '探测请求应带上令牌（证明凭据链生效）');
});

/* =========================== D-4 =========================== */

test('FIX-6 D-4：GitHub 保留路径（sponsors / orgs / topics …）不会被当成候选仓库', async () => {
  const userAgents = makeTempDir();
  const dir = path.join(userAgents, 'lyco');
  const reservedLines = RESERVED_OWNERS.map((owner) => '- https://github.com/' + owner + '/probe-target');
  await writeTree(dir, {
    'SKILL.md': '---\nname: lyco\ndescription: d\n---\n',
    'notes.md': [...reservedLines, '- 真正的来源：https://github.com/lilyco-42/lyco-skill', '- 另一个：https://raw.githubusercontent.com/lilyco-42/lyco-skill/main/logo.png'].join('\n') + '\n',
  });
  const env = await buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'lyco', path: dir, name: 'lyco' }],
    rootPaths: { 'user-agents': userAgents },
  });

  const result = await call(env.module as never, 'POST skills/sources/discover', { body: {} });
  const candidates = result.candidates as { repo: string }[];
  const repos = candidates.map((c) => c.repo.toLowerCase());
  for (const owner of RESERVED_OWNERS) {
    assert.equal(
      repos.some((r) => r.startsWith(owner + '/')),
      false,
      '保留路径 ' + owner + ' 被当成了候选仓库：' + JSON.stringify(repos)
    );
  }
  assert.ok(repos.includes('lilyco-42/lyco-skill'), '正常仓库链接仍应给出候选');
});
