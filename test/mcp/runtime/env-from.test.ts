/**
 * envFrom 各失败分支。用**真实 cmd.exe / node** 跑小命令（任务书要求），
 * 只读环境变量与内建命令，不碰任何用户数据。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEnvFrom, runEnvFromCommand } from '../../../src/mcp/runtime/atoms/env-from.ts';

const WIN = process.platform === 'win32';

test('成功取值：stdout 只去首尾空白', { skip: !WIN }, async () => {
  const result = await resolveEnvFrom({ envFrom: { MY_TOKEN: 'echo   abc-123   ' }, allowEmpty: [] });
  assert.deepEqual(result.failures, []);
  assert.equal(result.values.MY_TOKEN, 'abc-123');
});

test('非零退出被拒绝，诊断含退出码与 stderr', { skip: !WIN }, async () => {
  const result = await resolveEnvFrom({
    envFrom: { BAD: 'echo boom 1>&2 & exit /b 3' },
    allowEmpty: [],
  });
  assert.equal(result.values.BAD, undefined);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /退出码 3/);
  assert.match(result.failures[0].message, /boom/);
});

test('诊断绝不含 stdout', { skip: !WIN }, async () => {
  const result = await resolveEnvFrom({
    envFrom: { SECRET: 'echo SUPER-SECRET-VALUE & exit /b 1' },
    allowEmpty: [],
  });
  assert.equal(result.failures.length, 1);
  assert.ok(!result.failures[0].message.includes('SUPER-SECRET-VALUE'), '失败诊断里不能出现 stdout 内容');
});

test('空值默认被拒绝，除非在 allowEmpty 中', { skip: !WIN }, async () => {
  const denied = await resolveEnvFrom({ envFrom: { EMPTY: 'echo off & rem' }, allowEmpty: [] });
  assert.equal(denied.failures.length, 1);
  assert.match(denied.failures[0].message, /结果为空/);

  const allowed = await resolveEnvFrom({ envFrom: { EMPTY: 'echo off & rem' }, allowEmpty: ['EMPTY'] });
  assert.deepEqual(allowed.failures, []);
  assert.equal(allowed.values.EMPTY, '');
});

test('空命令被拒绝', { skip: !WIN }, async () => {
  const result = await resolveEnvFrom({ envFrom: { X: '   ' }, allowEmpty: [] });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /命令为空/);
});

test('超时被拒绝，并说明可调大 envFromTimeoutMs', async () => {
  // 用一个真实存在的解释器做"永不结束"的命令；跨平台都能跑。
  const command = process.platform === 'win32' ? 'ping -n 20 127.0.0.1' : 'sleep 20';
  const result = await resolveEnvFrom({ envFrom: { SLOW: command }, allowEmpty: [], timeoutMs: 300 });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /没有结束，已终止|未在|超时/);
  assert.match(result.failures[0].message, /envFromTimeoutMs/);
});

test('命令起不来被拒绝', async () => {
  const result = await resolveEnvFrom({
    envFrom: { X: 'definitely-not-a-real-command-xyz --flag' },
    allowEmpty: [],
    timeoutMs: 5000,
  });
  assert.equal(result.failures.length, 1);
  assert.ok(/无法执行|失败/.test(result.failures[0].message));
});

test('stdout 超过 64 KiB 被拒绝（不截断）', async () => {
  // 注意：这里刻意不用双引号包脚本 —— cmd.exe 会吃掉括号，命令会静默变成空输出。
  // 这也是 docs 里「envFrom 命令怎么写」的例子。
  const result = await resolveEnvFrom({
    envFrom: { BIG: 'node -e process.stdout.write(String.fromCharCode(97).repeat(70000))' },
    allowEmpty: [],
    timeoutMs: 30000,
  });
  assert.equal(result.values.BIG, undefined);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /超过 65536 字节上限/);
});

test('多个变量并发解析，全部结算后才返回', { skip: !WIN }, async () => {
  const result = await resolveEnvFrom({
    envFrom: { A: 'echo one', B: 'echo two', C: 'exit /b 1' },
    allowEmpty: [],
  });
  assert.equal(result.values.A, 'one');
  assert.equal(result.values.B, 'two');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].variable, 'C');
});

test('空 envFrom 直接返回空结果', async () => {
  const result = await resolveEnvFrom({ envFrom: {}, allowEmpty: [] });
  assert.deepEqual(result.values, {});
  assert.deepEqual(result.failures, []);
});

test('runner 抛错被转成失败而不是冒泡', async () => {
  const result = await resolveEnvFrom({
    envFrom: { X: 'whatever' },
    allowEmpty: [],
    runner: async () => {
      throw new Error('模拟崩溃');
    },
  });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /模拟崩溃/);
});

test('runEnvFromCommand 成功路径返回纯 stdout', { skip: !WIN }, async () => {
  const outcome = await runEnvFromCommand('V', 'echo value-here', 5000);
  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.value, 'value-here');
});
