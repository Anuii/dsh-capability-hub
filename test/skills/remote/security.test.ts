/**
 * FIX-5 安全回归：tar 解包路径穿越 + writeDirectoryFiles 的「先校验、后写盘」。
 *
 * 覆盖要求 A–G：反斜杠穿越文件名、"." / ".." 段、绝对路径与盘符、Windows 保留名、
 * pax path 越界、技能目录名穿越、符号链接条目不落盘、正常仓库照常安装。
 *
 * 红线（PLAN §4）：全程只用 os.tmpdir() 下的临时目录，不碰任何真实用户目录；
 * 「越界零写入」用「临时目录递归指纹比对 + 直接检查逃逸候选路径不存在」两项断言固定。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

import { createSkillsRemoteModule } from '../../../src/skills/remote/module.ts';
import { lockFilePath } from '../../../src/skills/remote/lockstore.ts';
import { filesUnderDirectory, readTarEntries } from '../../../src/skills/remote/tar.ts';
import { writeDirectoryFiles } from '../../../src/skills/remote/fsx.ts';
import {
  describeUnsafePath,
  isSafeRelativePath,
  isSafeSegmentName,
} from '../../../src/skills/remote/safepath.ts';
import { buildTar, buildTarWithPax, octal, skillFixture, type FixtureEntry } from './tarfixture.ts';
import {
  jsonResponse,
  makeCtx,
  makeFakeApi,
  makeFakeFetch,
  makeLogger,
  makeTempDir,
  tarGzOf,
  withRootPaths,
  writeTree,
} from './helpers.ts';

/* ---------- 本地夹具 ---------- */

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 临时目录的递归指纹：类型 + 相对路径 + 内容 SHA-256（符号链接记目标）。 */
async function fingerprint(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(current: string, prefix: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        out.push('d ' + rel);
        await visit(abs, rel);
      } else if (entry.isSymbolicLink()) {
        out.push('l ' + rel + ' -> ' + (await fs.readlink(abs)));
      } else {
        out.push('f ' + rel + ' ' + createHash('sha256').update(await fs.readFile(abs)).digest('hex'));
      }
    }
  }
  await visit(dir, '');
  return out;
}

/** 装技能的沙箱：base = 临时目录（指纹比对范围），技能根在 base/agents/skills 下。 */
async function makeSandbox(label: string): Promise<{ base: string; userAgents: string; before: string[] }> {
  const base = makeTempDir('cap-hub-fix5-' + label + '-');
  const userAgents = path.join(base, 'agents', 'skills');
  return { base, userAgents, before: await fingerprint(base) };
}

type BuildOptions = {
  skills?: NonNullable<Parameters<typeof makeFakeApi>[0]>['skills'];
  rootPaths?: Record<string, string>;
  routes?: Parameters<typeof makeFakeFetch>[0];
  home?: string;
  hubHome?: string;
};

function buildModule(options: BuildOptions = {}) {
  const home = options.home ?? makeTempDir();
  const hubHome = options.hubHome ?? makeTempDir();
  const { logger } = makeLogger([]);
  const ctx = makeCtx({ homeDir: home, hubHome, logger, profileName: 'capability-hub-dev' });
  const skills = makeFakeApi({ skills: options.skills ?? [] });
  if (options.rootPaths) withRootPaths(skills, options.rootPaths);
  const fake = makeFakeFetch(options.routes ?? []);
  const module = createSkillsRemoteModule(ctx, { skills }, {
    fetchImpl: fake.fetch,
    envTokenProvider: () => undefined,
    ghTokenProvider: async () => undefined,
    cacheAuth: false,
  });
  return { home, hubHome, ctx, skills, fake, module };
}

function call(
  module: { routes: Record<string, (r: never) => Promise<unknown>> },
  key: string,
  req: { query?: Record<string, string>; body?: unknown } = {}
): Promise<Record<string, unknown>> {
  const handler = module.routes[key];
  if (!handler) throw new Error('路由不存在：' + key);
  return handler({ query: req.query ?? {}, body: req.body, signal: new AbortController().signal } as never) as Promise<
    Record<string, unknown>
  >;
}

/** 标准的假 GitHub 路由：默认分支 + tar.gz 内容。 */
function tarRoutes(gz: Buffer): Parameters<typeof makeFakeFetch>[0] {
  return [
    { match: (u: string) => u.includes('/repos/'), response: () => jsonResponse({ default_branch: 'main' }) },
    { match: (u: string) => u.includes('/tar.gz/'), response: () => new Response(new Uint8Array(gz), { status: 200 }) },
  ];
}

/** 造带 codeload 风格根前缀的 pax 归档（buildTarWithPax 不提供根前缀包装）。 */
function paxArchive(entries: FixtureEntry[], root = 'demo-main'): Buffer {
  const prefixed: FixtureEntry[] = [
    { path: root + '/', type: 'dir' },
    ...entries.map((entry) => ({ ...entry, path: root + '/' + entry.path.replace(/^\/+/, '') })),
  ];
  return gzipSync(buildTarWithPax(prefixed));
}

/** 一条符号链接的 tar 头（tarfixture 的 FixtureEntry 不支持 symlink）。 */
function symlinkBlock(name: string, target: string): Buffer {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'latin1');
  block.write('0000000\0', 108, 8, 'latin1');
  block.write('0000000\0', 116, 8, 'latin1');
  octal(0, 12).copy(block, 124);
  block.write('00000000000\0', 136, 12, 'latin1');
  block.write('        ', 148, 8, 'latin1'); // 校验和占位（读取端不校验）
  block.write('2', 156, 1, 'latin1'); // symlink
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  block.write(target, 157, 100, 'utf8'); // linkname
  return block;
}

/** 造 codeload 形态归档，并在末尾（零块之前）插入一条符号链接条目。 */
function archiveWithSymlink(entries: FixtureEntry[], link: { path: string; target: string }, root = 'demo-main'): Buffer {
  const prefixed: FixtureEntry[] = [
    { path: root + '/', type: 'dir' },
    ...entries.map((entry) => ({ ...entry, path: root + '/' + entry.path.replace(/^\/+/, '') })),
  ];
  const tar = buildTar(prefixed); // 末尾固定 1024 字节零块
  return gzipSync(Buffer.concat([tar.subarray(0, tar.length - 1024), symlinkBlock(root + '/' + link.path, link.target), Buffer.alloc(1024, 0)]));
}

const SKILL_MD = '---\nname: grilling\ndescription: d\n---\n\n# grilling\n';

/* ---------- A：路径判据（单元） ---------- */

test('FIX-5 单元：路径安全判据 —— 正常的相对路径放行', () => {
  for (const good of ['SKILL.md', 'agents/openai.yaml', 'a/b/c.txt', 'name.with.dots.md', '..foo', '.hidden', 'x-y_z', 'sub dir/file.txt']) {
    assert.equal(describeUnsafePath(good), undefined, '必须放行：' + good);
    assert.equal(isSafeRelativePath(good), true);
  }
  assert.equal(isSafeSegmentName('..foo'), true, '以 ".." 开头但不是 ".." 的名字是安全的（包含性检查不能误伤它）');
  assert.equal(isSafeSegmentName('grilling'), true);
  assert.equal(isSafeSegmentName('a/b'), false, '单段名不允许含 /');
});

test('FIX-5 单元：路径安全判据 —— 穿越形态 / 绝对路径 / 保留名一律拒绝', () => {
  const bad = [
    'a\\..\\..\\evil.txt',
    '../evil.txt',
    'a/../../b',
    '..',
    '.',
    'a//b',
    'a/./b',
    '/abs/x',
    'C:/x',
    '\\\\srv\\share',
    'CON',
    'con',
    'nul.txt',
    'COM1',
    'lpt9.md',
    'aux',
    'trailing.',
    'trailing ',
    'a\tb',
    'evil\u0000.txt',
    '',
  ];
  for (const item of bad) {
    const reason = describeUnsafePath(item);
    assert.ok(reason !== undefined, '必须拒绝：' + JSON.stringify(item));
    assert.match(String(reason), /[一-龥]/, '拒绝原因必须是中文：' + JSON.stringify(item));
    assert.equal(isSafeRelativePath(item), false);
  }
});

/* ---------- B：tar 条目层 ---------- */

test('FIX-5 tar：反斜杠 / ".." 段 / 绝对路径 / 盘符 / 保留名条目 → filesUnderDirectory 抛 UPSTREAM', () => {
  const cases: { rel: string; why: RegExp }[] = [
    { rel: 'sub/a\\..\\..\\..\\evil.txt', why: /反斜杠/ },
    { rel: '../../../evil.txt', why: /\.\./ },
    { rel: '/abs/evil.txt', why: /绝对路径/ },
    { rel: 'C:/evil.txt', why: /盘符/ },
    { rel: 'sub/CON.txt', why: /保留设备名/ },
    { rel: 'sub/trailing. ', why: /结尾/ },
  ];
  for (const item of cases) {
    const entries = readTarEntries(
      buildTar([
        { path: 'r/', type: 'dir' },
        { path: 'r/skills/x/grilling/SKILL.md', data: 'fm' },
        { path: 'r/skills/x/grilling/' + item.rel, data: 'pwned' },
      ])
    );
    assert.throws(
      () => filesUnderDirectory(entries, 'skills/x/grilling'),
      (error: { status: number; code: string; message: string }) => {
        assert.equal(error.code, 'UPSTREAM');
        assert.equal(error.status, 502);
        assert.match(error.message, /不安全/);
        assert.match(error.message, item.why);
        return true;
      },
      '必须拒绝：' + item.rel
    );
  }
});

test('FIX-5 tar：pax path 记录里的越界条目被拒（解析层不静默清洗）', () => {
  const entries = readTarEntries(
    buildTarWithPax([
      { path: 'demo-main/', type: 'dir' },
      { path: 'demo-main/skills/x/grilling/SKILL.md', data: 'fm' },
      { path: 'demo-main/skills/x/grilling/a/../../../../pax-evil.txt', data: 'pwned' },
    ])
  );
  assert.ok(
    entries.some((e) => e.path.includes('..')),
    '夹具必须真的把 ".." 原样读进来（否则这条测试没有意义）'
  );
  assert.throws(() => filesUnderDirectory(entries, 'skills/x/grilling'), /不安全/);
});

/* ---------- D：writeDirectoryFiles 先校验后写盘（S3） ---------- */

test('FIX-5 写盘：混入一个坏条目时，一个文件都不写、一个目录都不建', async () => {
  const base = makeTempDir('cap-hub-fix5-write-');
  const target = path.join(base, 'dest');
  const files = [
    { rel: 'SKILL.md', data: Buffer.from('good') },
    { rel: 'agents/openai.yaml', data: Buffer.from('good') },
    { rel: 'sub/a\\..\\..\\outside.txt', data: Buffer.from('pwned') },
  ];
  await assert.rejects(
    () => writeDirectoryFiles(target, files),
    (error: { code: string; message: string }) => {
      assert.equal(error.code, 'UPSTREAM');
      assert.match(error.message, /不安全/);
      return true;
    }
  );
  assert.equal(await exists(target), false, '校验失败时目标目录本身也不能被创建');
  assert.deepEqual(await fingerprint(base), [], '两个好文件也不能被写出来（先校验、后写盘）');
});

/* ---------- G：端到端（安装） ---------- */

test('FIX-5 安装：反斜杠穿越文件名 → 拒绝、技能根内外零越界写入（指纹比对）', async () => {
  const sandbox = await makeSandbox('install-backslash');
  const insideName = 'fix5-inside-' + Math.random().toString(36).slice(2, 10) + '.txt';
  const outsideName = 'fix5-outside-' + Math.random().toString(36).slice(2, 10) + '.txt';
  const insideTmp = path.join(os.tmpdir(), outsideName);
  // rel1：从 技能根/grilling/sub/<seg> 往上 5 层 → 落到沙箱根（临时目录内、技能根外）
  // rel2：往上 6 层 → 落到 os.tmpdir()（临时目录之外）
  const gz = tarGzOf([
    { path: 'skills/x/grilling/SKILL.md', data: SKILL_MD },
    { path: 'skills/x/grilling/sub/a' + '\\..'.repeat(5) + '\\' + insideName, data: 'pwned' },
    { path: 'skills/x/grilling/sub/b' + '\\..'.repeat(6) + '\\' + outsideName, data: 'pwned' },
  ]);
  const env = buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'placeholder', path: path.join(sandbox.userAgents, 'placeholder') }],
    rootPaths: { 'user-agents': sandbox.userAgents },
    routes: tarRoutes(gz),
  });
  try {
    const result = await call(env.module as never, 'POST skills/install', {
      body: { repo: 'a/b', skillPaths: ['skills/x/grilling/SKILL.md'], target: 'user-agents' },
    });
    const item = (result.results as { ok: boolean; message?: string }[])[0]!;
    assert.equal(item.ok, false);
    assert.match(item.message!, /不安全/);
    assert.match(item.message!, /反斜杠/);
    assert.deepEqual(await fingerprint(sandbox.base), sandbox.before, '技能根内外都必须一个字节都没多');
    assert.equal(await exists(insideTmp), false, 'os.tmpdir() 下不能出现逃逸文件');
    assert.equal(await exists(path.join(sandbox.userAgents, 'grilling')), false, '被拒绝的技能不能留下目录');
  } finally {
    await fs.rm(insideTmp, { force: true }).catch(() => {});
  }
});

test('FIX-5 安装：pax path 里的 ".." 越界条目 → 拒绝且零写入', async () => {
  const sandbox = await makeSandbox('install-pax');
  const escapeName = 'fix5-pax-' + Math.random().toString(36).slice(2, 10) + '.txt';
  const escapePath = path.join(os.tmpdir(), escapeName);
  const gz = paxArchive([
    { path: 'skills/x/grilling/SKILL.md', data: SKILL_MD },
    { path: 'skills/x/grilling/a/../../../../../../' + escapeName, data: 'pwned' },
  ]);
  const env = buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'placeholder', path: path.join(sandbox.userAgents, 'placeholder') }],
    rootPaths: { 'user-agents': sandbox.userAgents },
    routes: tarRoutes(gz),
  });
  try {
    const result = await call(env.module as never, 'POST skills/install', {
      body: { repo: 'a/b', skillPaths: ['skills/x/grilling/SKILL.md'], target: 'user-agents' },
    });
    const item = (result.results as { ok: boolean; message?: string }[])[0]!;
    assert.equal(item.ok, false);
    assert.match(item.message!, /不安全/);
    assert.deepEqual(await fingerprint(sandbox.base), sandbox.before);
    assert.equal(await exists(escapePath), false, 'pax 越界路径不能被写出来');
  } finally {
    await fs.rm(escapePath, { force: true }).catch(() => {});
  }
});

test('FIX-5 安装：用户提交的 skillPath 含穿越形态 → BAD_REQUEST，且不发任何网络请求', async () => {
  const sandbox = await makeSandbox('install-userpath');
  const env = buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'placeholder', path: path.join(sandbox.userAgents, 'placeholder') }],
    rootPaths: { 'user-agents': sandbox.userAgents },
  });
  for (const bad of ['skills/x/evil\\..\\..\\pwned/SKILL.md', '../../evil/SKILL.md', '/abs/SKILL.md', 'C:/evil/SKILL.md']) {
    await assert.rejects(
      () =>
        call(env.module as never, 'POST skills/install', {
          body: { repo: 'a/b', skillPaths: [bad], target: 'user-agents' },
        }),
      (error: { status: number; code: string; message: string }) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'BAD_REQUEST');
        assert.match(error.message, /不安全/);
        return true;
      },
      '必须拒绝：' + bad
    );
  }
  assert.equal(env.fake.calls.length, 0, '坏输入不得产生任何网络请求');
  assert.deepEqual(await fingerprint(sandbox.base), sandbox.before);
});

test('FIX-5 安装：安全 skillPath 命中「祖先含 ".." 的上游目录」→ 拒绝且零写入', async () => {
  // 上游把技能放在 skills/a/../../../grilling/ 下、用户按常规路径请求 —— 目录名（grilling）本身
  // 是安全的，但上游目录路径里带 ".."：这是「目录名穿越」在真实输入下的可达形态。
  const sandbox = await makeSandbox('install-upstream-dir');
  const gz = tarGzOf([
    { path: 'skills/a/../../../grilling/SKILL.md', data: SKILL_MD },
    { path: 'skills/a/../../../grilling/agents/openai.yaml', data: 'name: grilling\n' },
  ]);
  const env = buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'placeholder', path: path.join(sandbox.userAgents, 'placeholder') }],
    rootPaths: { 'user-agents': sandbox.userAgents },
    routes: tarRoutes(gz),
  });
  const result = await call(env.module as never, 'POST skills/install', {
    body: { repo: 'a/b', skillPaths: ['skills/x/grilling/SKILL.md'], target: 'user-agents' },
  });
  const item = (result.results as { ok: boolean; message?: string }[])[0]!;
  assert.equal(item.ok, false);
  assert.match(item.message!, /不安全/);
  assert.deepEqual(await fingerprint(sandbox.base), sandbox.before, '拒绝时技能根内外都必须一个字节都没多');
  assert.equal(await exists(path.join(sandbox.userAgents, 'grilling')), false);
});

test('FIX-5 安装：正常仓库照常安装（对照）', async () => {
  const sandbox = await makeSandbox('install-ok');
  const env = buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'placeholder', path: path.join(sandbox.userAgents, 'placeholder') }],
    rootPaths: { 'user-agents': sandbox.userAgents },
    routes: tarRoutes(tarGzOf(skillFixture('productivity', 'grilling', { description: '对照' }))),
  });
  const result = await call(env.module as never, 'POST skills/install', {
    body: { repo: 'a/b', skillPaths: ['skills/productivity/grilling/SKILL.md'], target: 'user-agents' },
  });
  const item = (result.results as { ok: boolean; skillId?: string }[])[0]!;
  assert.equal(item.ok, true);
  assert.equal(item.skillId, 'user-agents:grilling');
  const dest = path.join(sandbox.userAgents, 'grilling');
  assert.deepEqual((await fs.readdir(dest)).sort(), ['SKILL.md', 'agents']);
  assert.match(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8'), /name: grilling/);
});

/* ---------- E：符号链接条目不落盘 ---------- */

test('FIX-5 符号链接：tar 里的 symlink 条目不会被写出', async () => {
  const sandbox = await makeSandbox('symlink');
  const linkName = 'fix5-link-' + Math.random().toString(36).slice(2, 10) + '.txt';
  const linkTarget = path.join(os.tmpdir(), linkName);
  const gz = archiveWithSymlink([{ path: 'skills/x/grilling/SKILL.md', data: SKILL_MD }], {
    path: 'skills/x/grilling/evil-link',
    target: linkTarget,
  });

  // 夹具自检：解析层确实读到了 1 条 symlink，而 filesUnderDirectory 只返回普通文件
  const entries = readTarEntries(gunzipSync(gz));
  assert.equal(entries.filter((e) => e.type === 'symlink').length, 1, '夹具必须真的产出符号链接条目');
  assert.deepEqual(
    filesUnderDirectory(entries, 'skills/x/grilling').map((f) => f.rel),
    ['SKILL.md']
  );

  const env = buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'placeholder', path: path.join(sandbox.userAgents, 'placeholder') }],
    rootPaths: { 'user-agents': sandbox.userAgents },
    routes: tarRoutes(gz),
  });
  const result = await call(env.module as never, 'POST skills/install', {
    body: { repo: 'a/b', skillPaths: ['skills/x/grilling/SKILL.md'], target: 'user-agents' },
  });
  assert.equal((result.results as { ok: boolean }[])[0]!.ok, true);
  const dest = path.join(sandbox.userAgents, 'grilling');
  assert.deepEqual(await fs.readdir(dest), ['SKILL.md'], '只写普通文件');
  await assert.rejects(fs.lstat(path.join(dest, 'evil-link')), /ENOENT/);
  assert.equal(await exists(linkTarget), false);
});

/* ---------- C：技能目录名穿越（更新链路，lock 里的历史/伪造 skillPath） ---------- */

test('FIX-5 更新：上游技能目录路径含 ".." → 该技能被拒、本地零改动（在移入回收站之前）', async () => {
  const sandbox = await makeSandbox('update-dirname');
  const local = path.join(sandbox.userAgents, 'pwned');
  await writeTree(local, { 'SKILL.md': '---\nname: pwned\ndescription: 本地\n---\n' });
  const before = await fingerprint(sandbox.base);

  const traverseSkillPath = 'skills/x/evil/../../../pwned/SKILL.md';
  const gz = tarGzOf([{ path: traverseSkillPath, data: '---\nname: pwned\ndescription: 上游\n---\n' }]);
  const env = buildModule({
    skills: [{ rootId: 'user-agents', dirName: 'pwned', path: local, name: 'pwned' }],
    rootPaths: { 'user-agents': sandbox.userAgents },
    routes: tarRoutes(gz),
  });
  await fs.mkdir(path.dirname(lockFilePath(env.ctx)), { recursive: true });
  await fs.writeFile(
    lockFilePath(env.ctx),
    JSON.stringify({
      version: 3,
      skills: {
        pwned: {
          source: 'a/b',
          sourceType: 'github',
          sourceUrl: 'https://github.com/a/b.git',
          skillPath: traverseSkillPath,
          skillFolderHash: 'a'.repeat(64),
          installedAt: '2026-09-01T00:00:00.000Z',
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    })
  );

  const result = await call(env.module as never, 'POST skills/updates/apply', { body: { ids: ['user-agents:pwned'] } });
  const item = (result.results as { ok: boolean; message?: string }[])[0]!;
  assert.equal(item.ok, false);
  assert.match(item.message!, /不安全/);
  assert.deepEqual(await fingerprint(sandbox.base), before, '被拒绝时本地技能目录必须一个字节都没动');
  assert.equal((env.skills as { moveToTrashCalls: unknown[] }).moveToTrashCalls.length, 0, '拒绝必须发生在移入回收站之前');
});
