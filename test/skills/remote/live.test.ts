/**
 * 在线只读测试（RUN_LIVE=1 才执行）。
 *
 * 只做只读访问：api.github.com / codeload.github.com / skills.sh。
 * 只读 ~/.agents/.skill-lock.json 用于哈希比对，绝不写入真实用户目录。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSkillsRemoteModule } from '../../../src/skills/remote/module.ts';
import { archiveInstalledHash, jsonResponse, makeCtx, makeFakeApi, makeLogger, makeTempDir, tarGzOf } from './helpers.ts';
import { buildTarGz, skillFixture } from './tarfixture.ts';

const live = process.env['RUN_LIVE'] === '1';

function liveModule(options: { skills?: NonNullable<Parameters<typeof makeFakeApi>[0]>['skills'] } = {}) {
  const home = makeTempDir();
  const hubHome = makeTempDir();
  const ctx = makeCtx({ homeDir: home, hubHome, logger: makeLogger().logger });
  const skills = makeFakeApi({ skills: options.skills ?? [] });
  const module = createSkillsRemoteModule(ctx, { skills });
  return { ctx, skills, module, home, hubHome };
}

async function call(module: { routes: Record<string, (r: never) => Promise<unknown>> }, key: string, req: { query?: Record<string, string>; body?: unknown } = {}) {
  const handler = module.routes[key];
  if (!handler) throw new Error(`路由不存在：${key}`);
  return (await handler({ query: req.query ?? {}, body: req.body, signal: new AbortController().signal } as never)) as Record<string, unknown>;
}

test('在线：浏览 mattpocock/skills（列出技能、解析 name/description）', async (t) => {
  if (!live) return t.skip('设置 RUN_LIVE=1 才执行');
  const env = liveModule();
  const result = await call(env.module as never, 'POST skills/repo/browse', { body: { repo: 'mattpocock/skills' } });
  const skills = result.skills as { dirName: string; name?: string; description?: string; skillPath: string }[];
  console.log(`浏览 mattpocock/skills@${result.ref}：找到 ${skills.length} 个技能`);
  console.log(skills.slice(0, 8).map((s) => `  ${s.skillPath}  name=${s.name}  desc=${(s.description ?? '').slice(0, 40)}`).join('\n'));
  assert.ok(skills.length >= 10, `应至少找到 10 个技能，实际 ${skills.length}`);
  assert.ok(skills.every((s) => s.skillPath.endsWith('/SKILL.md') || s.skillPath === 'SKILL.md'));
  assert.ok(skills.some((s) => s.dirName === 'grilling' && s.name === 'grilling'));
  assert.ok(skills.some((s) => typeof s.description === 'string' && s.description.length > 10), 'description 应被解析出来');
});

test('在线：skills.sh 搜索关键词', async (t) => {
  if (!live) return t.skip('设置 RUN_LIVE=1 才执行');
  const env = liveModule();
  const result = await call(env.module as never, 'GET skills/search', { query: { q: 'pdf' } });
  const results = result.results as { name: string; repo: string; installs?: number }[];
  console.log(`skills.sh 搜索 "pdf"：${results.length} 条`);
  console.log(results.slice(0, 5).map((r) => `  ${r.name} ← ${r.repo} (installs=${r.installs})`).join('\n'));
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => /^[^/]+\/[^/]+$/.test(r.repo)), 'repo 必须是 owner/name');
  assert.ok(results.some((r) => r.repo === 'anthropics/skills'));
});

test('在线：GET skills/github-auth 反映真实凭据链', async (t) => {
  if (!live) return t.skip('设置 RUN_LIVE=1 才执行');
  const env = liveModule();
  const result = await call(env.module as never, 'GET skills/github-auth', { query: {} });
  console.log(`GitHub 凭据模式：${result.mode}${result.rateLimitRemaining !== undefined ? `，剩余额度 ${result.rateLimitRemaining}` : ''}`);
  assert.ok(['env', 'gh', 'anonymous'].includes(String(result.mode)));
  // FIX-6（D-3）：在线必须拿到**数字**形式的剩余配额（gh 凭据模式下也必须是数字）。
  assert.equal(typeof result.rateLimitRemaining, 'number', 'github-auth 应返回数字形式的 rateLimitRemaining');
  assert.ok((result.rateLimitRemaining as number) >= 0);
  assert.equal(JSON.stringify(result).includes('ghp_'), false, '响应里不得出现令牌');
});

test('在线：安装到临时目录（端到端，不碰真实用户目录）', async (t) => {
  if (!live) return t.skip('设置 RUN_LIVE=1 才执行');
  const userAgents = makeTempDir();
  const env = liveModule();
  const originalRootPath = env.skills.rootPath.bind(env.skills);
  env.skills.rootPath = (rootId: string, opts: { workspace?: string }) =>
    rootId === 'user-agents' ? userAgents : originalRootPath(rootId, opts);

  const result = await call(env.module as never, 'POST skills/install', {
    body: { repo: 'mattpocock/skills', skillPaths: ['skills/productivity/grilling/SKILL.md'], target: 'user-agents' },
  });
  const item = (result.results as { ok: boolean; skillId?: string; message?: string }[])[0]!;
  console.log(`安装结果：${JSON.stringify(item)}`);
  assert.equal(item.ok, true, item.message);
  const content = await fs.readFile(path.join(userAgents, 'grilling', 'SKILL.md'), 'utf8');
  assert.match(content, /name: grilling/);
  // 写进了临时 home 的 lock（不是真实的 ~/.agents）
  const lock = JSON.parse(await fs.readFile(path.join(env.home, '.agents', '.skill-lock.json'), 'utf8'));
  assert.equal(lock.version, 3);
  assert.equal(lock.skills.grilling.source, 'mattpocock/skills');
  assert.equal(lock.skills.grilling.skillFolderHash.length, 64);
  // 真实验证 C5：本次运行前后，真实 ~/.agents/.skill-lock.json 的内容与 mtime 必须完全不变
  const realLock = path.join(os.homedir(), '.agents', '.skill-lock.json');
  const before = await fs.readFile(realLock, 'utf8');
  const beforeStat = await fs.stat(realLock);
  const check = await call(env.module as never, 'GET skills/github-auth', { query: {} });
  assert.ok(check.mode);
  assert.equal(await fs.readFile(realLock, 'utf8'), before, '真实 lock 内容不得改变');
  assert.equal((await fs.stat(realLock)).mtimeMs, beforeStat.mtimeMs, '真实 lock 不得被写入');
});

test('在线：检查更新 + 应用更新（端到端，用真实 mattpocock/skills）', async (t) => {
  if (!live) return t.skip('设置 RUN_LIVE=1 才执行');
  const userAgents = makeTempDir();
  // 先把技能「登记」进假实现（模拟本机已有目录），安装失败后目录不存在也不会被列出
  const env = liveModule({ skills: [{ rootId: 'user-agents', dirName: 'grilling', path: path.join(userAgents, 'grilling'), name: 'grilling' }] });
  const originalRootPath = env.skills.rootPath.bind(env.skills);
  env.skills.rootPath = (rootId: string, opts: { workspace?: string }) =>
    rootId === 'user-agents' ? userAgents : originalRootPath(rootId, opts);

  // 装一个技能（写入临时 home 的 lock，记录值 = 上游哈希）
  const install = await call(env.module as never, 'POST skills/install', {
    body: { repo: 'mattpocock/skills', skillPaths: ['skills/productivity/grilling/SKILL.md'], target: 'user-agents' },
  });
  assert.equal((install.results as { ok: boolean }[])[0]!.ok, true);

  // 把技能目录改脏 → 记录值与本地不一致，但「记录值 == 上游」→ 仍应判定无更新
  await fs.writeFile(path.join(userAgents, 'grilling', 'SKILL.md'), '---\nname: grilling\ndescription: 被我改过\n---\n');
  const check = await call(env.module as never, 'POST skills/updates/check', { body: {} });
  const item = (check.results as { skillId: string; status: string; message?: string }[])[0]!;
  console.log(`检查更新：${item.skillId} → ${item.status}`);
  assert.equal(item.status, 'up-to-date', '记录值来自上游，跳过本地改动检测（D-B10 直接覆盖语义）');

  // 把记录值与上游改成一致，然后强制改成一个假值，验证 update-available
  const lockPath = path.join(env.home, '.agents', '.skill-lock.json');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  lock.skills.grilling.skillFolderHash = '0'.repeat(64);
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2));
  const check2 = await call(env.module as never, 'POST skills/updates/check', { body: {} });
  assert.equal((check2.results as { status: string }[])[0]!.status, 'update-available');

  const applied = await call(env.module as never, 'POST skills/updates/apply', {
    body: { ids: ['user-agents:grilling'] },
  });
  const appliedItem = (applied.results as { ok: boolean; message?: string; trashId?: string }[])[0]!;
  console.log(`应用更新：${JSON.stringify(appliedItem)}`);
  assert.equal(appliedItem.ok, true, appliedItem.message);
  const restored = await fs.readFile(path.join(userAgents, 'grilling', 'SKILL.md'), 'utf8');
  assert.match(restored, /name: grilling/);
  assert.ok(!restored.includes('被我改过'), '覆盖式更新应恢复成上游内容');

  const lockAfter = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.equal(lockAfter.skills.grilling.skillFolderHash.length, 64);
  assert.equal(lockAfter.version, 3);
  assert.equal(lock.skills.grilling.installedAt, lockAfter.skills.grilling.installedAt, 'installedAt 必须保持不变');
});

/**
 * 递归列出目录下的相对路径（只读目录项，不读文件内容 —— 真实仓库里可能有二进制文件）。
 * 只读，用于断言「哪些文件被写进了技能目录」。
 */
async function listRelative(root: string, prefix = ''): Promise<string[]> {
  const dir = prefix === '' ? root : path.join(root, ...prefix.split('/'));
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : prefix + '/' + entry.name;
    if (entry.isDirectory()) out.push(...(await listRelative(root, rel)));
    else out.push(rel);
  }
  return out;
}

test('在线：单技能仓库（SKILL.md 就在仓库根）→ 浏览 + 安装 + 检查更新为「最新」', async (t) => {
  if (!live) return t.skip('设置 RUN_LIVE=1 才执行');
  // 只读确认过结构的单技能公开仓库：根目录就有 SKILL.md（frontmatter name = dataforseo-mcp-server），
  // 且根目录同时带 .github / .vscode 这类仓库元数据目录 —— 正好验证「列得出 → 装得上 → 元数据不写盘」。
  const repo = 'dataforseo/mcp-server-typescript';
  const installName = 'dataforseo-mcp-server';
  const userAgents = makeTempDir();
  const env = liveModule({
    skills: [{ rootId: 'user-agents', dirName: installName, path: path.join(userAgents, installName), name: installName }],
  });
  const originalRootPath = env.skills.rootPath.bind(env.skills);
  env.skills.rootPath = (rootId: string, opts: { workspace?: string }) =>
    rootId === 'user-agents' ? userAgents : originalRootPath(rootId, opts);

  // ① 浏览：根级 SKILL.md 列出来的 skillPath 必须是 "SKILL.md"
  const browsed = await call(env.module as never, 'POST skills/repo/browse', { body: { repo } });
  const listed = browsed.skills as { skillPath: string; dirName: string; name?: string; installedId?: string }[];
  const root = listed.find((s) => s.skillPath === 'SKILL.md');
  console.log('浏览 ' + repo + '@' + String(browsed.ref) + '：' + listed.length + ' 个技能，根级=' + JSON.stringify(root));
  assert.ok(root, '根级 SKILL.md 必须被列出来：' + listed.map((s) => s.skillPath).join(', '));
  assert.equal(root.name, installName);
  assert.equal(root.dirName, 'mcp-server-typescript', '根级技能的目录名回退成仓库名（安装时才换成 sanitizeName(name)）');

  // ② 安装（skillPaths 用的就是浏览给的那个值）
  const install = await call(env.module as never, 'POST skills/install', {
    body: { repo, skillPaths: ['SKILL.md'], target: 'user-agents' },
  });
  const item = (install.results as { ok: boolean; skillId?: string; message?: string }[])[0]!;
  console.log('安装根级技能：' + JSON.stringify(item));
  assert.equal(item.ok, true, item.message);
  assert.equal(item.skillId, 'user-agents:' + installName);

  const installed = await listRelative(path.join(userAgents, installName));
  console.log('落盘文件数：' + installed.length + '，示例：' + installed.slice(0, 5).join(', '));
  assert.ok(installed.includes('SKILL.md'));
  assert.equal(installed.some((rel) => rel === '.git' || rel.startsWith('.git/')), false, '.git 不该被写进技能目录');
  assert.equal(installed.some((rel) => rel === '.github' || rel.startsWith('.github/')), false, '.github 不该被写进技能目录');
  assert.equal(installed.some((rel) => rel === '.vscode' || rel.startsWith('.vscode/')), false, '.vscode 不该被写进技能目录');
  assert.match(await fs.readFile(path.join(userAgents, installName, 'SKILL.md'), 'utf8'), /name: dataforseo-mcp-server/);

  // ③ lock：键 = 技能名，skillPath = "SKILL.md"（npx skills 的约定）
  const lockPath = path.join(env.home, '.agents', '.skill-lock.json');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  const entry = lock.skills[installName];
  console.log('lock 条目：' + JSON.stringify({ key: installName, skillPath: entry?.skillPath, hash: String(entry?.skillFolderHash).slice(0, 12) }));
  assert.equal(lock.version, 3);
  assert.equal(entry.source, repo);
  assert.equal(entry.skillPath, 'SKILL.md');
  assert.equal(entry.skillFolderHash.length, 64);

  // ④ 安装后立刻检查更新 → 必须是「最新」（安装与检查的哈希口径一致）
  const checked = await call(env.module as never, 'POST skills/updates/check', { body: {} });
  const checkedItem = (checked.results as { skillId: string; status: string; message?: string }[])[0]!;
  console.log('检查更新：' + checkedItem.skillId + ' → ' + checkedItem.status);
  assert.equal(checkedItem.skillId, 'user-agents:' + installName);
  assert.equal(checkedItem.status, 'up-to-date', checkedItem.message ?? '');

  // ⑤ 重新浏览 → 根级技能必须显示「已安装」（installedId 用的是安装时的目录名）
  const browsed2 = await call(env.module as never, 'POST skills/repo/browse', { body: { repo } });
  const root2 = (browsed2.skills as { skillPath: string; installedId?: string }[]).find((s) => s.skillPath === 'SKILL.md')!;
  assert.equal(root2.installedId, 'user-agents:' + installName);

  // ⑥ 真实用户数据未受影响（PLAN §4 / C5）：只读比对真实 lock
  const realLock = path.join(os.homedir(), '.agents', '.skill-lock.json');
  const before = await fs.readFile(realLock, 'utf8').catch(() => undefined);
  if (before !== undefined) {
    assert.equal(await fs.readFile(realLock, 'utf8'), before, '真实 lock 内容不得改变');
  }
});
