import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoRef, skillDirOf, skillMdPathOf } from '../../../src/skills/remote/sourceurl.ts';
import { assertRepoShape } from '../../../src/skills/remote/repos.ts';

test('裸 owner/name', () => {
  assert.deepEqual(parseRepoRef('anthropics/skills'), { repo: 'anthropics/skills' });
  assert.deepEqual(parseRepoRef('  mattpocock/skills  '), { repo: 'mattpocock/skills' });
  assert.deepEqual(parseRepoRef('JimLiu/baoyu-skills'), { repo: 'JimLiu/baoyu-skills' });
});

test('完整 GitHub URL（含 .git 后缀）', () => {
  assert.deepEqual(parseRepoRef('https://github.com/anthropics/skills'), { repo: 'anthropics/skills' });
  assert.deepEqual(parseRepoRef('https://github.com/anthropics/skills.git'), { repo: 'anthropics/skills' });
  assert.deepEqual(parseRepoRef('https://www.github.com/a/b'), { repo: 'a/b' });
  assert.deepEqual(parseRepoRef('http://github.com/a/b'), { repo: 'a/b' });
  assert.deepEqual(parseRepoRef('https://github.com/vercel-labs/skills/releases'), { repo: 'vercel-labs/skills' });
});

test('/tree/<ref>/<path> 形式解析出 ref 与子路径', () => {
  assert.deepEqual(parseRepoRef('https://github.com/mattpocock/skills/tree/main/skills/engineering'), {
    repo: 'mattpocock/skills',
    ref: 'main',
    subPath: 'skills/engineering',
  });
  assert.deepEqual(parseRepoRef('https://github.com/a/b/tree/feature%2Fbranch'), {
    repo: 'a/b',
    ref: 'feature/branch',
  });
  assert.deepEqual(parseRepoRef('https://github.com/a/b/blob/main/skills/x/SKILL.md'), {
    repo: 'a/b',
    ref: 'main',
    subPath: 'skills/x',
  });
});

test('非法输入被拒（中文报错、VALIDATION）', () => {
  for (const bad of ['', '   ', 'just-one-part', 'a/b/c', 'https://gitlab.com/a/b', 'https://github.com/a', 'git@github.com:a/b.git']) {
    assert.throws(() => parseRepoRef(bad), /[一-龥]/, `应拒绝：${bad}`);
  }
  assert.throws(() => parseRepoRef('https://github.com/a/b/tree'), /分支/);
  // /tree/<分支> 只给分支不给子路径是合法输入（等价于整仓）
  assert.deepEqual(parseRepoRef('https://github.com/a/b/tree/main'), { repo: 'a/b', ref: 'main' });
});

test('assertRepoShape 校验 owner/name 形态', () => {
  assert.equal(assertRepoShape('anthropics/skills'), 'anthropics/skills');
  assert.equal(assertRepoShape('owner/repo.with.dots'), 'owner/repo.with.dots');
  assert.throws(() => assertRepoShape('-bad/repo'), /格式/);
  assert.throws(() => assertRepoShape('a/'), /格式/);
  assert.throws(() => assertRepoShape('a/b c'), /格式/);
});

test('FIX-5：仓库名 "." 与 ".." 被拒（会把 codeload / api 的 URL 路径改写）', () => {
  assert.throws(() => parseRepoRef('a/.'), /仓库名不能是/);
  assert.throws(() => parseRepoRef('a/..'), /仓库名不能是/);
  assert.throws(() => parseRepoRef('./b'), /[一-龥]/);
  assert.throws(() => parseRepoRef('../b'), /[一-龥]/);
  // URL 形态：new URL 会把 /a/.. 规范化掉，同样不可能解析出 ".." 仓库名
  assert.throws(() => parseRepoRef('https://github.com/a/..'), /[一-龥]/);
  // 正常的带点仓库名照常放行
  assert.equal(parseRepoRef('owner/repo.with.dots').repo, 'owner/repo.with.dots');
  // assertRepoShape（安装/登记端的入口）同样拒绝它们（既有实现按「不能以点开头」拦下）
  for (const bad of ['a/.', 'a/..']) assert.throws(() => assertRepoShape(bad), /[一-龥]/);
});

test('skillDirOf / skillMdPathOf 互逆', () => {
  assert.deepEqual(skillDirOf('skills/productivity/grilling/SKILL.md'), {
    dirPath: 'skills/productivity/grilling',
    dirName: 'grilling',
  });
  assert.deepEqual(skillDirOf('skills\\productivity\\grilling\\SKILL.md'), {
    dirPath: 'skills/productivity/grilling',
    dirName: 'grilling',
  });
  // 根级技能：整个仓库根就是技能目录
  assert.deepEqual(skillDirOf('SKILL.md'), { dirPath: '', dirName: '' });
  assert.equal(skillMdPathOf('skills/x/y'), 'skills/x/y/SKILL.md');
  assert.equal(skillMdPathOf(''), 'SKILL.md');
  assert.equal(skillMdPathOf(skillDirOf('a/b/SKILL.md').dirPath), 'a/b/SKILL.md');
});
