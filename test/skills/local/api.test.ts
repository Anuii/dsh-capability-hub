import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSkillsLocalImpl } from '../../../src/skills/local/api.ts';
import { createSkillsLocalModule } from '../../../src/skills/local/module.ts';
import {
  agentsRoot,
  dshSkillsRoot,
  exists,
  makeCtx,
  makeLockStashStub,
  makeTempArea,
  readBytes,
  skillMd,
  writeSkill,
  type TempArea,
} from './fixtures.ts';

async function withArea(label: string, fn: (area: TempArea) => Promise<void>): Promise<void> {
  const area = await makeTempArea(label);
  try {
    await fn(area);
  } finally {
    await area.cleanup();
  }
}

test('list：只读根 / 不存在根 / .system 跳过 / 优先级与跨根遮蔽', async () => {
  await withArea('list', async (area) => {
    await fs.mkdir(agentsRoot(area), { recursive: true });
    await writeSkill(agentsRoot(area), 'alpha', skillMd('alpha', '来自 user-agents'));
    await writeSkill(agentsRoot(area), 'beta', skillMd('beta', 'user-agents 的 beta'));
    await writeSkill(dshSkillsRoot(area), 'beta', skillMd('beta', 'user-dsh 的 beta'));
    await writeSkill(dshSkillsRoot(area), '.system', skillMd('system-skill', '内置'));
    await fs.mkdir(path.join(agentsRoot(area), '.hidden-cache'), { recursive: true });
    await fs.writeFile(path.join(agentsRoot(area), '.hidden-cache', 'notes.txt'), '不是技能');

    const customDir = path.join(area.root, 'custom-skills');
    await writeSkill(customDir, 'gamma', skillMd('gamma', '只读根'));
    const bundled = path.join(area.root, 'bundled-skills');
    await writeSkill(bundled, 'delta', skillMd('delta', '内置技能'));

    const ctx = makeCtx(area, { customSkillDirs: [customDir], bundledSkillDir: bundled });
    const impl = createSkillsLocalImpl(ctx);
    const result = await impl.list({ workspace: area.workspace });

    const byId = new Map(result.skills.map((s) => [s.id, s]));
    assert.equal(byId.has('user-agents:alpha'), true);
    assert.equal(byId.has('user-dsh:.system'), false, '.system 必须跳过');
    assert.equal(byId.has('user-agents:.hidden-cache'), false, '没有 SKILL.md 的目录不列出');
    assert.equal(byId.has('user-dsh:beta'), true);
    assert.equal(byId.has('user-agents:beta'), true);

    const winner = byId.get('user-dsh:beta');
    const loser = byId.get('user-agents:beta');
    assert.equal(winner?.shadowedBy, undefined);
    assert.equal(winner?.modelVisible, true);
    assert.equal(loser?.shadowedBy, 'user-dsh:beta');
    assert.equal(loser?.modelVisible, false);
    assert.equal(loser?.diagnostics.some((d) => d.code === 'SHADOWED_BY_HIGHER_PRIORITY'), true);

    const gamma = byId.get('custom-0:gamma');
    assert.equal(gamma?.writable, false);
    assert.equal(byId.get('bundled:delta')?.writable, false);

    const roots = new Map(result.roots.map((r) => [r.rootId, r]));
    assert.equal(roots.get('user-agents')?.exists, true);
    assert.equal(roots.get('user-dsh')?.exists, true);
    assert.equal(roots.get('bundled')?.exists, true);
    assert.equal(roots.get('bundled')?.writable, false);
    assert.equal(roots.get('custom-0')?.writable, false);
    assert.equal(roots.get('custom-0')?.precedence, 300);
    assert.equal(roots.get('user-agents')?.precedence, 500);
  });
});

test('list：根不存在不报错；未提供 workspace 时没有项目级根', async () => {
  await withArea('noroots', async (area) => {
    const impl = createSkillsLocalImpl(makeCtx(area));
    const result = await impl.list({});
    assert.equal(result.skills.length, 0);
    const ids = result.roots.map((r) => r.rootId);
    assert.deepEqual(ids, ['user-dsh', 'user-agents']);
    assert.equal(result.roots.every((r) => r.exists === false), true);
    assert.equal(Array.isArray(result.warnings), true);
  });
});

test('list：projectRoot 向上找最近含 .git 的祖先', async () => {
  await withArea('projectroot', async (area) => {
    const projectRoot = path.join(area.root, 'repo');
    const nested = path.join(projectRoot, 'packages', 'app');
    await fs.mkdir(path.join(projectRoot, '.git'), { recursive: true });
    await fs.mkdir(nested, { recursive: true });
    await writeSkill(path.join(projectRoot, '.agents', 'skills'), 'proj', skillMd('proj', '项目级技能'));

    const impl = createSkillsLocalImpl(makeCtx(area));
    const result = await impl.list({ workspace: nested });
    const skill = result.skills.find((s) => s.id === 'project-agents:proj');
    assert.ok(skill !== undefined, '应能扫到项目级技能');
    assert.equal(skill?.path, path.join(projectRoot, '.agents', 'skills', 'proj'));
    assert.equal(impl.rootPath('project-agents', { workspace: nested }), path.join(projectRoot, '.agents', 'skills'));
  });
});

test('rootPath：同步返回各根路径', async () => {
  await withArea('rootpath', async (area) => {
    const customDir = path.join(area.root, 'custom-skills');
    const bundled = path.join(area.root, 'bundled-skills');
    const impl = createSkillsLocalImpl(makeCtx(area, { customSkillDirs: [customDir], bundledSkillDir: bundled }));
    assert.equal(impl.rootPath('user-agents', {}), agentsRoot(area));
    assert.equal(impl.rootPath('user-dsh', {}), dshSkillsRoot(area));
    assert.equal(impl.rootPath('custom-0', {}), customDir);
    assert.equal(impl.rootPath('custom-9', {}), undefined);
    assert.equal(impl.rootPath('bundled', {}), bundled);
    assert.equal(impl.rootPath('project-dsh', {}), undefined, '没有 workspace 时没有项目根');
    assert.equal(impl.rootPath('unknown', {}), undefined);
  });
});

test('get：非法 id / 不存在的 id', async () => {
  await withArea('get', async (area) => {
    await fs.mkdir(agentsRoot(area), { recursive: true });
    await writeSkill(agentsRoot(area), 'alpha', skillMd('alpha', 'x'));
    const impl = createSkillsLocalImpl(makeCtx(area));
    assert.equal((await impl.get('user-agents:alpha', {}))?.dirName, 'alpha');
    assert.equal(await impl.get('user-agents:nope', {}), undefined);
    assert.equal(await impl.get('nocolon', {}), undefined);
  });
});

test('setEnabled：CRLF 文件只改一行，其余字节逐字不变', async () => {
  await withArea('toggle-crlf', async (area) => {
    const root = agentsRoot(area);
    const original = '---\r\nname: demo\r\ndescription: 演示\r\n---\r\n\r\n# 正文\r\n';
    const dir = await writeSkill(root, 'demo', original);
    const file = path.join(dir, 'SKILL.md');
    const before = await readBytes(file);

    const impl = createSkillsLocalImpl(makeCtx(area));
    const disabled = await impl.setEnabled('user-agents:demo', false, {});
    assert.equal(disabled.modelInvocationDisabled, true);
    assert.equal(disabled.modelVisible, false);

    const after = await readBytes(file);
    const expected = Buffer.from('---\r\nname: demo\r\ndescription: 演示\r\ndisable-model-invocation: true\r\n---\r\n\r\n# 正文\r\n', 'utf8');
    assert.equal(after.equals(expected), true);
    // 把插入的那一行去掉后，必须与原文逐字节相同
    const withoutInserted = Buffer.concat([
      after.subarray(0, after.length - expected.length + before.length - Buffer.byteLength('---\r\n\r\n# 正文\r\n', 'utf8')),
      after.subarray(after.length - Buffer.byteLength('---\r\n\r\n# 正文\r\n', 'utf8')),
    ]);
    assert.equal(withoutInserted.equals(before), true, '除新增行外必须逐字节相同');

    const enabled = await impl.setEnabled('user-agents:demo', true, {});
    assert.equal(enabled.modelInvocationDisabled, false);
    const back = await readBytes(file);
    assert.equal(back.equals(expected), false);
    assert.equal(back.toString('utf8'), '---\r\nname: demo\r\ndescription: 演示\r\ndisable-model-invocation: false\r\n---\r\n\r\n# 正文\r\n');
  });
});

test('setEnabled：已有键就地替换，只有该行变化', async () => {
  await withArea('toggle-inplace', async (area) => {
    const root = agentsRoot(area);
    const original = '---\nname: demo\ndescription: d\nlicense: MIT\ndisable-model-invocation: true\n---\n\n# body\n';
    const dir = await writeSkill(root, 'demo', original);
    const file = path.join(dir, 'SKILL.md');
    const impl = createSkillsLocalImpl(makeCtx(area));
    await impl.setEnabled('user-agents:demo', true, {});
    const after = await readBytes(file);
    const lines = after.toString('utf8').split('\n');
    assert.equal(lines[4], 'disable-model-invocation: false');
    assert.equal(lines[3], 'license: MIT');
    assert.equal(after.length, Buffer.byteLength(original) + 1);
  });
});

test('setEnabled：启用且键不存在时完全不动文件', async () => {
  await withArea('toggle-noop', async (area) => {
    const dir = await writeSkill(agentsRoot(area), 'demo', skillMd('demo', 'd'));
    const file = path.join(dir, 'SKILL.md');
    const before = await readBytes(file);
    const impl = createSkillsLocalImpl(makeCtx(area));
    const skill = await impl.setEnabled('user-agents:demo', true, {});
    assert.equal(skill.modelInvocationDisabled, false);
    assert.equal((await readBytes(file)).equals(before), true);
  });
});

test('setEnabled：BOM 技能 -> CONFLICT(409)，且文件字节不变', async () => {
  await withArea('toggle-bom', async (area) => {
    const dir = await writeSkill(agentsRoot(area), 'demo', '\uFEFF---\nname: demo\ndescription: d\n---\n');
    const file = path.join(dir, 'SKILL.md');
    const before = await readBytes(file);
    const impl = createSkillsLocalImpl(makeCtx(area));
    await assert.rejects(
      () => impl.setEnabled('user-agents:demo', false, {}),
      (error: { status: number; code: string; message: string }) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'CONFLICT');
        assert.equal(error.message.includes('BOM'), true);
        return true;
      },
    );
    assert.equal((await readBytes(file)).equals(before), true);
  });
});

test('setEnabled：只读根 -> READ_ONLY(403)', async () => {
  await withArea('toggle-readonly', async (area) => {
    const customDir = path.join(area.root, 'custom-skills');
    const dir = await writeSkill(customDir, 'demo', skillMd('demo', 'd'));
    const file = path.join(dir, 'SKILL.md');
    const before = await readBytes(file);
    const impl = createSkillsLocalImpl(makeCtx(area, { customSkillDirs: [customDir] }));
    await assert.rejects(
      () => impl.setEnabled('custom-0:demo', false, {}),
      (error: { status: number; code: string }) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, 'READ_ONLY');
        return true;
      },
    );
    assert.equal((await readBytes(file)).equals(before), true);

    const bundled = path.join(area.root, 'bundled-skills');
    await writeSkill(bundled, 'b1', skillMd('b1', 'd'));
    const impl2 = createSkillsLocalImpl(makeCtx(area, { bundledSkillDir: bundled }));
    await assert.rejects(
      () => impl2.setEnabled('bundled:b1', false, {}),
      (error: { status: number; code: string }) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, 'READ_ONLY');
        return true;
      },
    );
  });
});

test('setEnabled：L2 结构 -> CONFLICT(409) 且说明原因', async () => {
  await withArea('toggle-l2', async (area) => {
    const dir = await writeSkill(agentsRoot(area), 'demo', '---\nname: demo\ndescription: d\ntags: [a, b]\n---\n');
    const file = path.join(dir, 'SKILL.md');
    const before = await readBytes(file);
    const impl = createSkillsLocalImpl(makeCtx(area));
    await assert.rejects(
      () => impl.setEnabled('user-agents:demo', false, {}),
      (error: { status: number; code: string; message: string }) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'CONFLICT');
        assert.equal(error.message.includes('高级 YAML 特性'), true);
        return true;
      },
    );
    assert.equal((await readBytes(file)).equals(before), true);
  });
});

test('setEnabled：非法布尔 -> CONFLICT，绝不改写', async () => {
  await withArea('toggle-badbool', async (area) => {
    const dir = await writeSkill(agentsRoot(area), 'demo', '---\nname: demo\ndescription: d\ndisable-model-invocation: maybe\n---\n');
    const file = path.join(dir, 'SKILL.md');
    const before = await readBytes(file);
    const impl = createSkillsLocalImpl(makeCtx(area));
    await assert.rejects(
      () => impl.setEnabled('user-agents:demo', true, {}),
      (error: { status: number; code: string }) => {
        assert.equal(error.status, 409);
        return true;
      },
    );
    assert.equal((await readBytes(file)).equals(before), true);
  });
});

test('view：返回 SKILL.md 原文与目录清单（跳过 node_modules/.git，最多 500 项）', async () => {
  await withArea('view', async (area) => {
    const original = '---\nname: demo\ndescription: 描述\n---\n\n正文\n';
    const extras: Record<string, string> = { 'references/a.md': 'a', 'scripts/run.sh': 'echo' };
    for (let i = 0; i < 20; i += 1) extras['assets/f' + i + '.txt'] = 'x';
    extras['node_modules/pkg/index.js'] = 'nope';
    extras['.git/config'] = 'nope';
    await writeSkill(agentsRoot(area), 'demo', original, extras);
    const impl = createSkillsLocalImpl(makeCtx(area));
    const view = await impl.view('user-agents:demo', {});
    assert.equal(view.content, original, '必须是原文，不做 trim');
    assert.equal(view.skill.id, 'user-agents:demo');
    const paths = view.files.map((f) => f.path);
    assert.equal(paths.includes('SKILL.md'), true);
    assert.equal(paths.includes('references/a.md'), true);
    assert.equal(paths.includes('scripts/run.sh'), true);
    assert.equal(paths.some((p) => p.includes('node_modules')), false);
    assert.equal(paths.some((p) => p.startsWith('.git')), false);
    const dirEntry = view.files.find((f) => f.path === 'references');
    assert.equal(dirEntry?.isDir, true);
    assert.equal(view.files.length <= 500, true);
    const skillMdEntry = view.files.find((f) => f.path === 'SKILL.md');
    assert.equal(skillMdEntry?.size, Buffer.byteLength(original));
  });
});

test('view：超过 500 项时截断', async () => {
  await withArea('view-cap', async (area) => {
    const extras: Record<string, string> = {};
    for (let i = 0; i < 520; i += 1) extras['assets/f' + String(i).padStart(4, '0') + '.txt'] = 'x';
    await writeSkill(agentsRoot(area), 'demo', skillMd('demo', 'd'), extras);
    const impl = createSkillsLocalImpl(makeCtx(area));
    const view = await impl.view('user-agents:demo', {});
    assert.equal(view.files.length, 500);
  });
});

test('delete：整目录移入回收站，LockStash.take 被调用，条目存入 meta', async () => {
  await withArea('trash-delete', async (area) => {
    const dir = await writeSkill(agentsRoot(area), 'demo', skillMd('demo', 'd'), { 'references/a.md': 'x' });
    const impl = createSkillsLocalImpl(makeCtx(area));
    const stash = makeLockStashStub({ 'user-agents:demo': { source: 'owner/repo', skillPath: 'x/SKILL.md' } });
    impl.bindLockStash(stash);

    const item = await impl.moveToTrash('user-agents:demo', { reason: 'delete' });
    assert.equal(item.skillId, 'user-agents:demo');
    assert.equal(item.reason, 'delete');
    assert.equal(item.hasLockEntry, true);
    assert.equal(item.originalPath, dir);
    assert.equal(stash.calls.length, 1);
    assert.equal(stash.calls[0].op, 'take');
    assert.equal(stash.calls[0].dirName, 'demo');
    assert.equal(stash.entries.size, 0, 'take 必须把它从 lock 里移除');

    assert.equal(await exists(dir), false);
    const payload = path.join(area.hubHome, 'skills', 'trash', item.trashId, 'payload');
    assert.equal(await exists(path.join(payload, 'SKILL.md')), true);
    assert.equal(await exists(path.join(payload, 'references', 'a.md')), true, '整个目录都要进回收站');
    const metaRaw = JSON.parse(await fs.readFile(path.join(area.hubHome, 'skills', 'trash', item.trashId, 'meta.json'), 'utf8'));
    assert.equal(metaRaw.lockEntry.source, 'owner/repo');
    assert.equal(metaRaw.kind, 'dir');

    const items = await impl.trashList();
    assert.equal(items.length, 1);
    assert.equal((await impl.list({})).skills.length, 0);
  });
});

test('delete：没有 lock 条目时不写 hasLockEntry，take 仍被调用', async () => {
  await withArea('trash-nolock', async (area) => {
    await writeSkill(agentsRoot(area), 'demo', skillMd('demo', 'd'));
    const impl = createSkillsLocalImpl(makeCtx(area));
    const stash = makeLockStashStub();
    impl.bindLockStash(stash);
    const item = await impl.moveToTrash('user-agents:demo', { reason: 'delete' });
    assert.equal(item.hasLockEntry, false);
    assert.equal(stash.calls.length, 1);
    const metaRaw = JSON.parse(await fs.readFile(path.join(area.hubHome, 'skills', 'trash', item.trashId, 'meta.json'), 'utf8'));
    assert.equal(Object.hasOwn(metaRaw, 'lockEntry'), false);
  });
});

test('delete：未绑定 LockStash 也能工作', async () => {
  await withArea('trash-nostash', async (area) => {
    await writeSkill(agentsRoot(area), 'demo', skillMd('demo', 'd'));
    const impl = createSkillsLocalImpl(makeCtx(area));
    const item = await impl.moveToTrash('user-agents:demo', { reason: 'delete' });
    assert.equal(item.hasLockEntry, false);
  });
});

test('delete：reason 非法 / 只读根', async () => {
  await withArea('trash-guards', async (area) => {
    await writeSkill(agentsRoot(area), 'demo', skillMd('demo', 'd'));
    const impl = createSkillsLocalImpl(makeCtx(area));
    await assert.rejects(
      () => impl.moveToTrash('user-agents:demo', { reason: 'nope' as unknown as 'delete' }),
      (error: { status: number; code: string }) => {
        assert.equal(error.status, 400);
        return true;
      },
    );
    const customDir = path.join(area.root, 'custom-skills');
    await writeSkill(customDir, 'ro', skillMd('ro', 'd'));
    const impl2 = createSkillsLocalImpl(makeCtx(area, { customSkillDirs: [customDir] }));
    await assert.rejects(
      () => impl2.moveToTrash('custom-0:ro', { reason: 'delete' }),
      (error: { status: number; code: string }) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, 'READ_ONLY');
        return true;
      },
    );
    await assert.rejects(
      () => impl.moveToTrash('user-agents:missing', { reason: 'delete' }),
      (error: { status: number; code: string }) => {
        assert.equal(error.status, 404);
        return true;
      },
    );
  });
});

test('restore：原路径空闲 -> 直接恢复并放回 lock 条目', async () => {
  await withArea('restore-simple', async (area) => {
    await writeSkill(agentsRoot(area), 'demo', skillMd('demo', '恢复我'), { 'references/a.md': 'x' });
    const impl = createSkillsLocalImpl(makeCtx(area));
    const stash = makeLockStashStub({ 'user-agents:demo': { source: 'o/r' } });
    impl.bindLockStash(stash);
    const item = await impl.moveToTrash('user-agents:demo', { reason: 'delete' });

    const restored = await impl.restore(item.trashId, {});
    assert.equal(restored.id, 'user-agents:demo');
    assert.equal(restored.description, '恢复我');
    assert.equal(await exists(path.join(agentsRoot(area), 'demo', 'references', 'a.md')), true);
    assert.equal(stash.calls.filter((c) => c.op === 'put').length, 1);
    assert.equal((stash.entries.get('user-agents:demo') as { source?: string } | undefined)?.source, 'o/r');
    assert.equal((await impl.trashList()).length, 0, '恢复后回收站条目应删除');
  });
});

test('restore：原路径已存在且未指定 replace -> CONFLICT', async () => {
  await withArea('restore-conflict', async (area) => {
    await writeSkill(agentsRoot(area), 'demo', skillMd('demo', '旧'));
    const impl = createSkillsLocalImpl(makeCtx(area));
    const item = await impl.moveToTrash('user-agents:demo', { reason: 'delete' });
    await writeSkill(agentsRoot(area), 'demo', skillMd('demo', '新'));
    await assert.rejects(
      () => impl.restore(item.trashId, {}),
      (error: { status: number; code: string; message: string }) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'CONFLICT');
        assert.equal(error.message.includes('覆盖'), true);
        return true;
      },
    );
    assert.equal((await impl.get('user-agents:demo', {}))?.description, '新', '失败时不能动现有内容');
  });
});

test('restore：replace=true 时先把现有内容以 reason=replace 入回收站', async () => {
  await withArea('restore-replace', async (area) => {
    await writeSkill(agentsRoot(area), 'demo', skillMd('demo', '旧'));
    const impl = createSkillsLocalImpl(makeCtx(area));
    const item = await impl.moveToTrash('user-agents:demo', { reason: 'delete' });
    await writeSkill(agentsRoot(area), 'demo', skillMd('demo', '新'));

    const restored = await impl.restore(item.trashId, { replace: true });
    assert.equal(restored.description, '旧');
    const items = await impl.trashList();
    assert.equal(items.length, 1);
    assert.equal(items[0].reason, 'replace');
    assert.equal(items[0].skillId, 'user-agents:demo');
    const replacedPayload = path.join(area.hubHome, 'skills', 'trash', items[0].trashId, 'payload');
    assert.equal(await exists(path.join(replacedPayload, 'SKILL.md')), true);
    assert.equal((await fs.readFile(path.join(replacedPayload, 'SKILL.md'), 'utf8')).includes('新'), true);
  });
});

test('restore：恢复后启停状态保持（停用的技能恢复后仍是停用）', async () => {
  await withArea('restore-disabled', async (area) => {
    await writeSkill(agentsRoot(area), 'demo', skillMd('demo', 'd', ['disable-model-invocation: true']));
    const impl = createSkillsLocalImpl(makeCtx(area));
    const item = await impl.moveToTrash('user-agents:demo', { reason: 'delete' });
    const restored = await impl.restore(item.trashId, {});
    assert.equal(restored.modelInvocationDisabled, true);
    assert.equal(restored.modelVisible, false);
  });
});

test('restore：trashId 非法 / 不存在', async () => {
  await withArea('restore-bad', async (area) => {
    const impl = createSkillsLocalImpl(makeCtx(area));
    await assert.rejects(
      () => impl.restore('../evil', {}),
      (error: { status: number; code: string }) => {
        assert.equal(error.status, 400);
        return true;
      },
    );
    await assert.rejects(
      () => impl.restore('nope', {}),
      (error: { status: number; code: string }) => {
        assert.equal(error.status, 404);
        return true;
      },
    );
  });
});

test('restore：只读根上的历史条目不能恢复 -> READ_ONLY', async () => {
  await withArea('restore-readonly', async (area) => {
    const customDir = path.join(area.root, 'custom-skills');
    await writeSkill(customDir, 'ro', skillMd('ro', 'd'));
    const impl = createSkillsLocalImpl(makeCtx(area, { customSkillDirs: [customDir] }));
    // 手工造一条指向只读根的回收站条目
    const trashId = 'manual-readonly';
    const trashDir = path.join(area.hubHome, 'skills', 'trash', trashId);
    await fs.mkdir(path.join(trashDir, 'payload'), { recursive: true });
    await fs.writeFile(path.join(trashDir, 'meta.json'), JSON.stringify({
      version: 1,
      trashId,
      skillId: 'custom-0:ro',
      rootId: 'custom-0',
      dirName: 'ro',
      originalPath: path.join(customDir, 'ro'),
      rootPath: customDir,
      reason: 'delete',
      deletedAt: new Date().toISOString(),
      hasLockEntry: false,
      kind: 'dir',
    }));
    await assert.rejects(
      () => impl.restore(trashId, {}),
      (error: { status: number; code: string }) => {
        assert.equal(error.status, 403);
        assert.equal(error.code, 'READ_ONLY');
        return true;
      },
    );
  });
});

test('purge：单条与全部；列出按时间倒序', async () => {
  await withArea('purge', async (area) => {
    await writeSkill(agentsRoot(area), 'one', skillMd('one', 'd'));
    await writeSkill(agentsRoot(area), 'two', skillMd('two', 'd'));
    await writeSkill(agentsRoot(area), 'three', skillMd('three', 'd'));
    const impl = createSkillsLocalImpl(makeCtx(area));
    const a = await impl.moveToTrash('user-agents:one', { reason: 'delete' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await impl.moveToTrash('user-agents:two', { reason: 'delete' });
    await new Promise((r) => setTimeout(r, 5));
    const c = await impl.moveToTrash('user-agents:three', { reason: 'delete' });

    const items = await impl.trashList();
    assert.deepEqual(items.map((i) => i.trashId), [c.trashId, b.trashId, a.trashId], '必须按时间倒序');

    assert.equal(await impl.purge(b.trashId), 1);
    assert.equal((await impl.trashList()).length, 2);
    assert.equal(await exists(path.join(area.hubHome, 'skills', 'trash', b.trashId)), false);

    assert.equal(await impl.purge(), 2);
    assert.equal((await impl.trashList()).length, 0);

    await assert.rejects(
      () => impl.purge('missing'),
      (error: { status: number; code: string }) => {
        assert.equal(error.status, 404);
        return true;
      },
    );
    await assert.rejects(
      () => impl.purge('bad/id'),
      (error: { status: number; code: string }) => {
        assert.equal(error.status, 400);
        return true;
      },
    );
  });
});

test('warnings：检测 CC Switch 统一存储位置与符号链接技能', async () => {
  await withArea('warnings', async (area) => {
    await fs.mkdir(agentsRoot(area), { recursive: true });
    await writeSkill(agentsRoot(area), 'demo', skillMd('demo', 'd'));

    const impl = createSkillsLocalImpl(makeCtx(area));
    let list = await impl.list({});
    assert.deepEqual(list.warnings, [], '没有外部工具特征时不能误报');

    await fs.mkdir(path.join(area.homeDir, '.cc-switch'), { recursive: true });
    await fs.writeFile(
      path.join(area.homeDir, '.cc-switch', 'settings.json'),
      JSON.stringify({ skillStorageLocation: 'unified', skillSyncMethod: 'symlink' }),
    );
    list = await impl.list({});
    assert.equal(list.warnings.length, 1);
    assert.equal(list.warnings[0].includes('CC Switch'), true);
    assert.equal(list.warnings[0].includes('软链接'), true, '同步方式为 symlink 时应写软链接');
    assert.equal(list.warnings[0].includes('互相覆盖'), true, '要说清风险');

    // 切到 cc-switch 自己的存储位置 -> 不再对 user-agents 报警
    await fs.writeFile(
      path.join(area.homeDir, '.cc-switch', 'settings.json'),
      JSON.stringify({ skillStorageLocation: 'cc-switch', skillSyncMethod: 'copy' }),
    );
    list = await impl.list({});
    assert.deepEqual(list.warnings, []);
  });
});

test('warnings：技能目录是符号链接时提示（Windows 上目录联接可能不可用，跳过）', async () => {
  await withArea('warnings-link', async (area) => {
    const realDir = path.join(area.root, 'real-skill');
    await fs.mkdir(realDir, { recursive: true });
    await fs.writeFile(path.join(realDir, 'SKILL.md'), skillMd('linked', 'd'));
    await fs.mkdir(agentsRoot(area), { recursive: true });
    try {
      await fs.symlink(realDir, path.join(agentsRoot(area), 'linked'), 'junction');
    } catch {
      return; // 无权限时跳过（Windows 未开启开发者模式）
    }
    const impl = createSkillsLocalImpl(makeCtx(area));
    const list = await impl.list({});
    const skill = list.skills.find((s) => s.id === 'user-agents:linked');
    assert.ok(skill !== undefined);
    assert.equal(skill?.diagnostics.some((d) => d.code === 'SYMLINKED_SKILL'), true);
    assert.equal(list.warnings.some((w) => w.includes('符号链接')), true);
  });
});

test('module 工厂：7 个路由 + api + bindLockStash 都存在', () => {
  const module = createSkillsLocalModule({
    homeDir: 'C:/nope',
    dshHome: 'C:/nope/.dsh',
    hubHome: 'C:/nope/.dsh/storages/dsh-capability-hub',
    profileName: 'test',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    customSkillDirs: [],
  });
  assert.deepEqual(Object.keys(module.routes).sort(), [
    'GET skills/list',
    'GET skills/trash',
    'GET skills/view',
    'POST skills/delete',
    'POST skills/set-enabled',
    'POST skills/trash/purge',
    'POST skills/trash/restore',
  ]);
  assert.equal(typeof module.api.list, 'function');
  assert.equal(typeof module.api.rootPath, 'function');
  assert.equal(typeof module.bindLockStash, 'function');
  assert.equal(module.bindLockStash(({}) as never), undefined);
});


/* ---------------- 回归：正文里的同名行不能影响启停（端到端） ---------------- */

function splitDoc(text: string): { head: string; body: string } {
  const m = /^(---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))([\s\S]*)$/.exec(text);
  assert.ok(m !== null, '测试数据必须有 frontmatter');
  return { head: m[1], body: m[2] };
}

test('回归（端到端）：正文含 disable-model-invocation 示例行时，LF 文件启停只动 frontmatter', async () => {
  await withArea('regress-body-lf', async (area) => {
    const doc = [
      '---',
      'name: demo',
      'description: d',
      '---',
      '# Demo',
      '',
      '```yaml',
      'disable-model-invocation: true',
      '```',
      '',
      '正文里的 disable-model-invocation: false 只是示例。',
      '',
    ].join('\n');
    const dir = await writeSkill(agentsRoot(area), 'demo', doc);
    const file = path.join(dir, 'SKILL.md');
    const before = await readBytes(file);
    const beforeParts = splitDoc(doc);

    const impl = createSkillsLocalImpl(makeCtx(area));
    const after = await readBytes(file);
    assert.equal(after.equals(before), true, 'list 不应改文件');
    assert.equal((await impl.get('user-agents:demo', {}))?.modelInvocationDisabled, false);

    const disabled = await impl.setEnabled('user-agents:demo', false, {});
    assert.equal(disabled.modelInvocationDisabled, true, '停用必须真的写入 frontmatter');
    const written = (await readBytes(file)).toString('utf8');
    const parts = splitDoc(written);
    assert.equal(parts.body, beforeParts.body, '正文字节必须完全不变');
    assert.equal(parts.head, '---\nname: demo\ndescription: d\ndisable-model-invocation: true\n---\n');

    const enabled = await impl.setEnabled('user-agents:demo', true, {});
    assert.equal(enabled.modelInvocationDisabled, false);
    const restored = (await readBytes(file)).toString('utf8');
    assert.equal(splitDoc(restored).body, beforeParts.body, '正文字节必须完全不变');
    // 「只改一行」语义：不改写、不删除键，只把值改回 false
    assert.equal(splitDoc(restored).head, '---\nname: demo\ndescription: d\ndisable-model-invocation: false\n---\n');
    assert.equal(splitDoc(restored).head.split('\n').length, beforeParts.head.split('\n').length + 1, '整个过程只应多出这一行');
  });
});

test('回归（端到端）：CRLF 文件正文里已有该行时，启用改的是 frontmatter 那一行', async () => {
  await withArea('regress-body-crlf', async (area) => {
    const doc = [
      '---',
      'name: demo',
      'description: d',
      'disable-model-invocation: true',
      '---',
      '# Demo',
      '',
      'disable-model-invocation: false',
      '',
    ].join('\r\n');
    const dir = await writeSkill(agentsRoot(area), 'demo', doc);
    const file = path.join(dir, 'SKILL.md');
    const before = await readBytes(file);
    const beforeParts = splitDoc(doc);

    const impl = createSkillsLocalImpl(makeCtx(area));
    assert.equal((await impl.get('user-agents:demo', {}))?.modelInvocationDisabled, true);

    const enabled = await impl.setEnabled('user-agents:demo', true, {});
    assert.equal(enabled.modelInvocationDisabled, false);
    const after = await readBytes(file);
    assert.equal(after.length, before.length + 1, 'true -> false 只多一个字符');
    const text = after.toString('utf8');
    const parts = splitDoc(text);
    assert.equal(parts.body, beforeParts.body, '正文字节必须完全不变');
    assert.equal(parts.body.includes('disable-model-invocation: false'), true, '正文里的那行必须原样保留');
    assert.equal(parts.head, beforeParts.head.replace('disable-model-invocation: true', 'disable-model-invocation: false'));
    assert.equal(text.includes('\r\n'), true, '必须保持 CRLF');

    // 反向：停用后 frontmatter 回到 true，正文仍然不动
    await impl.setEnabled('user-agents:demo', false, {});
    const roundTrip = (await readBytes(file)).toString('utf8');
    assert.equal(splitDoc(roundTrip).head, beforeParts.head);
    assert.equal(splitDoc(roundTrip).body, beforeParts.body);
  });
});


/* ---------------- 回归：行尾注释（端到端，与官方 yaml 一致） ---------------- */

test('回归（端到端）：带行尾注释的 frontmatter 可以正常体检与启停（LF）', async () => {
  await withArea('comment-lf', async (area) => {
    const doc = [
      '---',
      'name: demo # 名字',
      'description: d # 说明',
      'disable-model-invocation: true # 停用',
      '---',
      '',
      '# Demo',
      '',
    ].join('\n');
    const dir = await writeSkill(agentsRoot(area), 'demo', doc);
    const file = path.join(dir, 'SKILL.md');
    const before = await readBytes(file);
    const impl = createSkillsLocalImpl(makeCtx(area));

    const found = await impl.get('user-agents:demo', {});
    assert.equal(found?.loadable, true, '行尾注释不是缺陷，必须可加载');
    assert.equal(found?.name, 'demo', 'name 不能被注释污染');
    assert.equal(found?.modelInvocationDisabled, true);
    assert.equal(found?.format.safeToToggle, true);

    const on = await impl.setEnabled('user-agents:demo', true, {});
    assert.equal(on.modelInvocationDisabled, false);
    const after = (await readBytes(file)).toString('utf8');
    assert.equal(after, doc.replace('disable-model-invocation: true # 停用', 'disable-model-invocation: false # 停用'), '只改该行的取值，注释与其余字节不动');

    await impl.setEnabled('user-agents:demo', false, {});
    assert.equal((await readBytes(file)).equals(before), true, '往返后逐字节回到原样');
  });
});

test('回归（端到端）：CRLF + 行尾注释的启停往返逐字节相同', async () => {
  await withArea('comment-crlf', async (area) => {
    const doc = [
      '---',
      'name: demo',
      'description: d',
      'disable-model-invocation: false # 已启用',
      '---',
      '',
      '# Demo',
      '',
    ].join('\r\n');
    const dir = await writeSkill(agentsRoot(area), 'demo', doc);
    const file = path.join(dir, 'SKILL.md');
    const before = await readBytes(file);
    const impl = createSkillsLocalImpl(makeCtx(area));

    const off = await impl.setEnabled('user-agents:demo', false, {});
    assert.equal(off.modelInvocationDisabled, true);
    const after = (await readBytes(file)).toString('utf8');
    assert.equal(after, doc.replace('disable-model-invocation: false # 已启用', 'disable-model-invocation: true # 已启用'));

    await impl.setEnabled('user-agents:demo', true, {});
    assert.equal((await readBytes(file)).equals(before), true);
  });
});
