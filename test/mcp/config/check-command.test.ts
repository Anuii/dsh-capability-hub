/**
 * check-command.ts：只查不执行；临时目录里造假可执行文件 + 自定义 PATH/PATHEXT。
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { checkCommand } from '../../../src/mcp/config/check-command.ts';
import { makeTempDir } from './helpers.ts';

describe('check-command', () => {
  it('按 PATH × PATHEXT 找到可执行文件', async () => {
    const dir = await makeTempDir();
    try {
      const bin = join(dir.path, 'bin');
      await fs.mkdir(bin, { recursive: true });
      const exe = join(bin, 'faketool.CMD');
      await fs.writeFile(exe, '@echo off\r\n', 'utf8');
      const result = await checkCommand('faketool', { pathEnv: bin, pathExt: '.COM;.EXE;.BAT;.CMD', platform: 'win32' });
      assert.equal(result.found, true);
      assert.equal(result.resolvedPath, exe);
    } finally {
      await dir.cleanup();
    }
  });

  it('找不到时返回 found:false', async () => {
    const dir = await makeTempDir();
    try {
      const result = await checkCommand('definitely-not-here-xyz', { pathEnv: join(dir.path, 'bin'), pathExt: '.CMD', platform: 'win32' });
      assert.deepEqual(result, { found: false });
    } finally {
      await dir.cleanup();
    }
  });

  it('PATH 中多个目录时返回第一个命中项', async () => {
    const dir = await makeTempDir();
    try {
      const one = join(dir.path, 'one');
      const two = join(dir.path, 'two');
      await fs.mkdir(one, { recursive: true });
      await fs.mkdir(two, { recursive: true });
      await fs.writeFile(join(two, 'tool.exe'), 'x', 'utf8');
      const result = await checkCommand('tool', { pathEnv: [one, two].join(';'), pathExt: '.EXE', platform: 'win32' });
      // Windows 文件系统大小写不敏感：返回的是按 PATHEXT 拼出的候选路径
      assert.equal(result.found, true);
      assert.equal(result.resolvedPath?.toLowerCase(), join(two, 'tool.exe').toLowerCase());
    } finally {
      await dir.cleanup();
    }
  });

  it('带路径分隔符时按 cwd 解析并按原样检查存在性', async () => {
    const dir = await makeTempDir();
    try {
      const bin = join(dir.path, 'sub');
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(join(bin, 'run.cmd'), 'x', 'utf8');
      const relative = await checkCommand('./sub/run.cmd', { cwd: dir.path, pathEnv: '', platform: 'win32' });
      assert.equal(relative.found, true);
      assert.equal(relative.resolvedPath, join(bin, 'run.cmd'));

      const absolute = await checkCommand(join(bin, 'run.cmd'), { cwd: dir.path, pathEnv: '', platform: 'win32' });
      assert.equal(absolute.found, true);

      const missing = await checkCommand('./sub/nope.cmd', { cwd: dir.path, pathEnv: '', platform: 'win32' });
      assert.deepEqual(missing, { found: false });
    } finally {
      await dir.cleanup();
    }
  });

  it('不执行命令：命令内容不会被运行', async () => {
    const dir = await makeTempDir();
    try {
      const bin = join(dir.path, 'bin');
      await fs.mkdir(bin, { recursive: true });
      const marker = join(dir.path, 'SHOULD-NOT-EXIST');
      // 造一个会写文件的「命令」，但名字不在 PATH 上 —— 只查 PATH，不执行
      await fs.writeFile(join(bin, 'evil.cmd'), 'echo x > "' + marker + '"', 'utf8');
      const result = await checkCommand('something-else', { pathEnv: bin, pathExt: '.CMD', platform: 'win32' });
      assert.deepEqual(result, { found: false });
      await assert.rejects(async () => await fs.stat(marker));
    } finally {
      await dir.cleanup();
    }
  });
});
