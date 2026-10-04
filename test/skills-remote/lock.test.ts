import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSourceStore, lockFilePath, sourcesFilePath } from '../../src/host/skills-remote/lockstore.ts';
import { makeCtx, makeTempDir, writeTree } from './helpers.ts';

const SAMPLE_LOCK = {
  version: 3,
  skills: {
    grilling: {
      source: 'mattpocock/skills',
      sourceType: 'github',
      sourceUrl: 'https://github.com/mattpocock/skills.git',
      skillPath: 'skills/productivity/grilling/SKILL.md',
      skillFolderHash: '4fa026e5979770347b3357ff5139e1e41d21c3a9f7335e9cd2811cb5b8d32f2f',
      pluginName: 'mattpocock-skills',
      installedAt: '2026-09-22T01:17:31.905Z',
      updatedAt: '2026-09-22T01:17:31.905Z',
    },
    retro: {
      source: 'mattpocock/skills',
      sourceType: 'github',
      sourceUrl: 'https://github.com/mattpocock/skills.git',
      skillPath: 'skills/in-progress/retro/SKILL.md',
      skillFolderHash: 'e63bb774fba4e601edfffc56bbd5c938d76c8faa2dff49456dff3b1e679cd3b6',
      installedAt: '2026-09-22T01:17:31.901Z',
      updatedAt: '2026-09-22T01:17:31.901Z',
    },
  },
  dismissed: { findSkillsPrompt: true },
  lastSelectedAgents: ['dsh'],
  futureField: { nested: [1, 2, 3] },
};

async function setup(lock: unknown = SAMPLE_LOCK) {
  const home = makeTempDir();
  const hubHome = makeTempDir();
  await writeTree(home, { '.agents/.skill-lock.json': JSON.stringify(lock, null, 2) });
  const ctx = makeCtx({ homeDir: home, hubHome });
  return { home, hubHome, ctx, sources: createSourceStore(ctx) };
}

test('读-改-写：只动被修改的条目，其余条目与未知字段逐字节语义不变', async () => {
  const { home, ctx, sources } = await setup();
  const before = JSON.parse(await fs.readFile(path.join(home, '.agents', '.skill-lock.json'), 'utf8'));

  await sources.upsert(
    { rootId: 'user-agents', dirName: 'grilling', path: '/tmp/grilling' },
    {
      skillId: 'user-agents:grilling',
      repo: 'mattpocock/skills',
      skillPath: 'skills/productivity/grilling/SKILL.md',
      store: 'skill-lock',
      skillFolderHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      updatedAt: '2026-10-04T00:00:00.000Z',
    },
    'grilling'
  );

  const after = JSON.parse(await fs.readFile(lockFilePath(ctx), 'utf8'));
  assert.equal(after.version, 3, 'version 必须保持原值');
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), '顶层键集合不变');
  assert.deepEqual(after.dismissed, before.dismissed);
  assert.deepEqual(after.lastSelectedAgents, before.lastSelectedAgents);
  assert.deepEqual(after.futureField, before.futureField, '未知顶层字段必须原样保留');
  assert.deepEqual(after.skills.retro, before.skills.retro, '其他条目必须逐字段不变');

  const updated = after.skills.grilling;
  assert.equal(updated.skillFolderHash, 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
  assert.equal(updated.updatedAt, '2026-10-04T00:00:00.000Z', 'updatedAt 用新的 ISO 字符串');
  assert.equal(updated.installedAt, before.skills.grilling.installedAt, 'installedAt 必须保持不变');
  assert.equal(updated.pluginName, 'mattpocock-skills', 'pluginName 等未知条目字段必须保留');
  assert.equal(updated.sourceUrl, 'https://github.com/mattpocock/skills.git', '已有 sourceUrl 原样保留');
  assert.equal(updated.source, 'mattpocock/skills');
  assert.equal(updated.sourceType, 'github');
});

test('除被修改条目外的 JSON 语义完全一致（逐深层比对）', async () => {
  const { home, ctx, sources } = await setup();
  const before = JSON.parse(await fs.readFile(path.join(home, '.agents', '.skill-lock.json'), 'utf8'));
  await sources.upsert(
    { rootId: 'user-agents', dirName: 'grilling', path: '/tmp/grilling' },
    { skillId: 'user-agents:grilling', repo: 'mattpocock/skills', skillPath: 'x/SKILL.md', store: 'skill-lock', skillFolderHash: 'a'.repeat(64) },
    'grilling'
  );
  const after = JSON.parse(await fs.readFile(lockFilePath(ctx), 'utf8'));
  delete after.skills.grilling;
  const expected = JSON.parse(JSON.stringify(before));
  delete expected.skills.grilling;
  assert.deepEqual(after, expected);
});

test('缺 version 时补 3；version 保持原值不被改写', async () => {
  const { ctx, sources } = await setup({ skills: {} });
  await sources.upsert(
    { rootId: 'user-agents', dirName: 'x', path: '/tmp/x' },
    { skillId: 'x', repo: 'a/b', skillPath: 'SKILL.md', store: 'skill-lock' },
    'x'
  );
  const lock = JSON.parse(await fs.readFile(lockFilePath(ctx), 'utf8'));
  assert.equal(lock.version, 3);

  await sources.upsert({ rootId: 'user-agents', dirName: 'y', path: '/tmp/y' }, { skillId: 'y', repo: 'a/b', skillPath: 'SKILL.md', store: 'skill-lock' }, 'y');
  const again = JSON.parse(await fs.readFile(lockFilePath(ctx), 'utf8'));
  assert.equal(again.version, 3);
});

test('写盘是原子写：不留下临时文件', async () => {
  const { home, ctx, sources } = await setup();
  await sources.upsert({ rootId: 'user-agents', dirName: 'grilling', path: '/tmp/g' }, { skillId: 'g', repo: 'a/b', skillPath: 'SKILL.md', store: 'skill-lock' }, 'grilling');
  const entries = await fs.readdir(path.join(home, '.agents'));
  assert.deepEqual(entries.filter((e) => e.includes('.tmp')), []);
  assert.ok(entries.includes('.skill-lock.json'));
});

test('其他根写 hubHome/skills/sources.json（不碰 .agents）', async () => {
  const { home, hubHome, ctx, sources } = await setup({ version: 3, skills: {} });
  await sources.upsert(
    { rootId: 'user-dsh', dirName: 'localtool', path: '/tmp/localtool' },
    { skillId: 'user-dsh:localtool', repo: 'me/tools', skillPath: 'SKILL.md', store: 'hub', skillFolderHash: 'c'.repeat(64) },
    'localtool'
  );
  const file = JSON.parse(await fs.readFile(sourcesFilePath(ctx), 'utf8'));
  assert.equal(file.entries['user-dsh/localtool'].repo, 'me/tools');
  assert.equal(file.entries['user-dsh/localtool'].rootId, 'user-dsh');
  const lock = JSON.parse(await fs.readFile(path.join(home, '.agents', '.skill-lock.json'), 'utf8'));
  assert.deepEqual(lock.skills, {}, 'lock 不应被其他根的登记污染');
  assert.ok(hubHome.length > 0);
});

test('LockStash take/put：取出后条目消失，放回后原样恢复', async () => {
  const { home, ctx, sources } = await setup();
  const entry = await sources.stash.take({ rootId: 'user-agents', dirName: 'grilling', path: '/tmp/grilling' });
  assert.ok(entry && typeof entry === 'object');
  assert.equal((entry as { source: string }).source, 'mattpocock/skills');

  let lock = JSON.parse(await fs.readFile(path.join(home, '.agents', '.skill-lock.json'), 'utf8'));
  assert.equal(lock.skills.grilling, undefined, 'take 后条目应被移除');
  assert.ok(lock.skills.retro, '其他条目不受影响');
  assert.equal(lock.version, 3);

  await sources.stash.put({ rootId: 'user-agents', dirName: 'grilling', path: '/tmp/grilling' }, entry);
  lock = JSON.parse(await fs.readFile(path.join(home, '.agents', '.skill-lock.json'), 'utf8'));
  assert.deepEqual(lock.skills.grilling, SAMPLE_LOCK.skills.grilling, 'put 后条目逐字段一致');
});

test('LockStash.take 对无条目技能返回 undefined，且不改动文件', async () => {
  const { home, ctx, sources } = await setup();
  const before = await fs.readFile(path.join(home, '.agents', '.skill-lock.json'), 'utf8');
  const entry = await sources.stash.take({ rootId: 'user-agents', dirName: 'not-there', path: '/tmp/none' });
  assert.equal(entry, undefined);
  assert.equal(await fs.readFile(path.join(home, '.agents', '.skill-lock.json'), 'utf8'), before);
});

test('LockStash 对其他根是空操作（条目本就在我们自己的文件里）', async () => {
  const { home, ctx, sources } = await setup();
  const before = await fs.readFile(path.join(home, '.agents', '.skill-lock.json'), 'utf8');
  assert.equal(await sources.stash.take({ rootId: 'user-dsh', dirName: 'x', path: '/tmp/x' }), undefined);
  await sources.stash.put({ rootId: 'user-dsh', dirName: 'x', path: '/tmp/x' }, { source: 'a/b' });
  assert.equal(await fs.readFile(path.join(home, '.agents', '.skill-lock.json'), 'utf8'), before);
});

test('lock 文件不存在时 take 返回 undefined 且不创建文件', async () => {
  const home = makeTempDir();
  const hubHome = makeTempDir();
  const ctx = makeCtx({ homeDir: home, hubHome });
  const sources = createSourceStore(ctx);
  assert.equal(await sources.stash.take({ rootId: 'user-agents', dirName: 'x', path: '/tmp/x' }), undefined);
  await assert.rejects(fs.stat(path.join(home, '.agents', '.skill-lock.json')));
});

test('remove 删除条目，list 汇总 lock 与 hub 两处', async () => {
  const { ctx, sources } = await setup();
  await sources.upsert({ rootId: 'user-dsh', dirName: 'tool', path: '/tmp/tool' }, { skillId: 'user-dsh:tool', repo: 'me/tool', skillPath: 'SKILL.md', store: 'hub' }, 'tool');
  const before = await sources.list();
  assert.deepEqual(before.map((e) => e.skillId).sort(), ['user-agents:grilling', 'user-agents:retro', 'user-dsh:tool']);

  assert.equal(await sources.remove({ rootId: 'user-agents', dirName: 'retro', path: '/tmp/retro' }, 'retro'), true);
  assert.equal(await sources.remove({ rootId: 'user-agents', dirName: 'retro', path: '/tmp/retro' }, 'retro'), false);
  const after = await sources.list();
  assert.deepEqual(after.map((e) => e.skillId).sort(), ['user-agents:grilling', 'user-dsh:tool']);
});

test('损坏的 JSON 不影响运行（当成空 lock）', async () => {
  const home = makeTempDir();
  const hubHome = makeTempDir();
  await writeTree(home, { '.agents/.skill-lock.json': '{ not json' });
  const ctx = makeCtx({ homeDir: home, hubHome });
  const sources = createSourceStore(ctx);
  assert.deepEqual(await sources.list(), []);
  await sources.upsert({ rootId: 'user-agents', dirName: 'n', path: '/tmp/n' }, { skillId: 'n', repo: 'a/b', skillPath: 'SKILL.md', store: 'skill-lock' }, 'n');
  const lock = JSON.parse(await fs.readFile(lockFilePath(ctx), 'utf8'));
  assert.equal(lock.version, 3);
  assert.ok(lock.skills.n);
});
