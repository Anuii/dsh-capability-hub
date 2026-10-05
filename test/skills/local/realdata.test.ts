import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkillsLocalImpl } from '../../../src/skills/local/api.ts';
import { makeCtx, makeTempArea, QUIET_LOGGER } from './fixtures.ts';
import type { SkillSummary } from '../../../src/skills/local/types.ts';

/**
 * 真实数据核对：把一份**技能目录快照**复制到临时目录（源目录只读），以副本作为 user-agents 根跑 list，
 * 核对解析结果：技能总数、模型可见数、CRLF 技能的启停只改一行、无 error/warning 级诊断。
 *
 * 快照不属于本仓库，默认位置是 <仓库根>/.dev/snapshots/agents-skills-20261004（.dev/ 不进版本库）；
 * 用 CAPABILITY_HUB_REAL_SKILLS_DIR 指向你自己的副本。计数写死是针对那份快照的：
 * 直接读活的 ~/.agents/skills 会因日常安装技能而漂移（环境变化，不是缺陷）。
 * 源目录不存在（例如换机器）时测试自动跳过，不做任何写入。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_SOURCE = process.env.CAPABILITY_HUB_REAL_SKILLS_DIR
  ?? path.resolve(HERE, '..', '..', '..', '.dev', 'snapshots', 'agents-skills-20261004');
void os;
const EXPECTED_TOTAL = 31;
const EXPECTED_MODEL_VISIBLE = 15;
const REAL_DATA_ENABLED = process.env.CAPABILITY_HUB_TEST_REAL_DATA !== '0';

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(from, to);
    else if (entry.isFile()) {
      await fs.copyFile(from, to);
      await fs.chmod(to, 0o666); // 快照源文件是只读的；Windows 上 copyFile 会带上只读属性，副本必须可写
    }
  }
}

test('真实数据只读核对：31 个技能 / 15 个模型可见 / 无诊断', async (t) => {
  if (!REAL_DATA_ENABLED) {
    t.skip('CAPABILITY_HUB_TEST_REAL_DATA=0');
    return;
  }
  try {
    await fs.stat(REAL_SOURCE);
  } catch {
    t.skip('本机没有 ' + REAL_SOURCE);
    return;
  }

  const area = await makeTempArea('realdata');
  const homeDir = area.homeDir;
  try {
    await fs.mkdir(path.join(homeDir, '.agents'), { recursive: true });
    await copyDir(REAL_SOURCE, path.join(homeDir, '.agents', 'skills'));

    const ctx = {
      homeDir,
      dshHome: path.join(homeDir, '.dsh'),
      hubHome: path.join(homeDir, '.dsh', 'storages', 'dsh-capability-hub'),
      profileName: 'test',
      logger: QUIET_LOGGER,
      customSkillDirs: [],
    };
    const impl = createSkillsLocalImpl(ctx);
    const result = await impl.list({});

    const skills: SkillSummary[] = result.skills;
    console.log('真实数据核对：技能总数 ' + String(skills.length) + '，模型可见 ' + String(skills.filter((s) => s.modelVisible).length));

    const errors = skills.flatMap((s) => s.diagnostics.filter((d) => d.level === 'error').map((d) => s.id + ' / ' + d.code + '：' + d.message));
    const warnings = skills.flatMap((s) => s.diagnostics.filter((d) => d.level === 'warning').map((d) => s.id + ' / ' + d.code + '：' + d.message));

    assert.equal(errors.length, 0, '不应有 error 级诊断：\n' + errors.join('\n'));
    assert.equal(warnings.length, 0, '不应有 warning 级诊断：\n' + warnings.join('\n'));
    assert.equal(skills.length, EXPECTED_TOTAL, '技能总数应为 ' + String(EXPECTED_TOTAL));
    assert.equal(skills.filter((s) => s.loadable).length, EXPECTED_TOTAL, '应全部可加载');

    const visible = skills.filter((s) => s.modelVisible).map((s) => s.name ?? s.dirName).sort();
    assert.equal(visible.length, EXPECTED_MODEL_VISIBLE, '模型可见数应为 ' + String(EXPECTED_MODEL_VISIBLE) + '：' + visible.join(', '));
    assert.deepEqual(visible, [
      'archify', 'code-review', 'codebase-design', 'diagnosing-bugs', 'domain-modeling', 'find-skills',
      'grilling', 'lyco', 'prototype', 'research', 'resolving-merge-conflicts', 'skill-creator',
      'tdd', 'wizard', 'writing-for-agents',
    ].sort());

    const hidden = skills.filter((s) => s.loadable && !s.modelVisible).map((s) => s.name ?? s.dirName).sort();
    assert.equal(hidden.length, EXPECTED_TOTAL - EXPECTED_MODEL_VISIBLE, '其余应因 disable-model-invocation 被隐藏');

    // 关键技能抽查：折叠块标量 / 嵌套 metadata / extraKeys / CRLF
    const lyco = skills.find((s) => s.id === 'user-agents:lyco');
    assert.equal(lyco?.description?.includes('lyco'), true, 'lyco 的折叠块 description 应能解析');
    assert.equal(lyco?.extraKeys.includes('agent_created'), true);
    const archify = skills.find((s) => s.id === 'user-agents:archify');
    assert.equal(archify?.modelInvocationDisabled, false);
    assert.equal(archify?.extraKeys.includes('metadata'), false, 'metadata 是 DSH 认识的键，不进 extraKeys');
    assert.equal(archify?.extraKeys.includes('license'), true);
    const handoff = skills.find((s) => s.id === 'user-agents:handoff');
    assert.equal(handoff?.extraKeys.includes('argument-hint'), true);
    assert.equal(handoff?.format.eol, 'crlf');
    const creator = skills.find((s) => s.id === 'user-agents:skill-creator');
    assert.equal(creator?.format.eol, 'crlf', 'skill-creator 是 CRLF 文件');
    assert.equal(creator?.format.safeToToggle, true, 'CRLF 文件必须可以安全启停');
    assert.equal(skills.every((s) => s.format.bom === false), true, '本机 31 个技能都没有 BOM');
    assert.equal(result.warnings.length, 0, '不应有外部接管警告：' + result.warnings.join(' / '));
  } finally {
    await area.cleanup();
  }
});

test('真实数据只读核对：启停 CRLF 技能只改一行（在副本上）', async (t) => {
  if (!REAL_DATA_ENABLED) {
    t.skip('CAPABILITY_HUB_TEST_REAL_DATA=0');
    return;
  }
  try {
    await fs.stat(REAL_SOURCE);
  } catch {
    t.skip('本机没有 ' + REAL_SOURCE);
    return;
  }
  const area = await makeTempArea('realtoggle');
  const homeDir = area.homeDir;
  try {
    await fs.mkdir(path.join(homeDir, '.agents'), { recursive: true });
    await copyDir(path.join(REAL_SOURCE, 'retro'), path.join(homeDir, '.agents', 'skills', 'retro'));
    const impl = createSkillsLocalImpl(makeCtx(area));
    const file = path.join(homeDir, '.agents', 'skills', 'retro', 'SKILL.md');
    const before = await fs.readFile(file);
    const skill = await impl.setEnabled('user-agents:retro', true, {});
    assert.equal(skill.modelInvocationDisabled, false);
    const after = await fs.readFile(file);
    // retro 原本是 disable-model-invocation: true（CRLF），改为 false 后只应有一个字符变化
    assert.equal(after.length, before.length + 1, 'true -> false 只多一个字符');
    let diffIndex = -1;
    for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
      if (before[i] !== after[i]) { diffIndex = i; break; }
    }
    assert.ok(diffIndex > 0, '应当恰好有一处差异');
    assert.equal(before.subarray(0, diffIndex).equals(after.subarray(0, diffIndex)), true);
    assert.equal(after.toString('utf8').includes('disable-model-invocation: false\r\n'), true, '必须保持 CRLF');
  } finally {
    await area.cleanup();
  }
});