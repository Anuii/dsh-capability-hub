/**
 * mask.ts：遮罩、合并保留原值、reveal 之外不出现明文。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HIDDEN, containsHidden, isHidden, maskEffectiveServer, maskRawServer, mergeHiddenSecrets, redact } from '../../../src/mcp/config/mask.ts';
import { toEffectiveServer } from '../../../src/mcp/config/schema.ts';

describe('mask: 遮罩', () => {
  it('raw 服务器的 env / headers 值被替换', () => {
    const raw = { serverName: 'a', transport: 'stdio' as const, command: 'node', env: { TOKEN: 'sk-123' }, headers: { Authorization: 'Bearer x' } };
    const masked = maskRawServer(raw);
    assert.deepEqual(masked?.env, { TOKEN: HIDDEN });
    assert.deepEqual(masked?.headers, { Authorization: HIDDEN });
    assert.equal(JSON.stringify(masked).includes('sk-123'), false);
    assert.equal(JSON.stringify(masked).includes('Bearer x'), false);
    // 原对象不被改动
    assert.deepEqual(raw.env, { TOKEN: 'sk-123' });
  });

  it('生效服务器的 env / headers 值被替换，键名保留', () => {
    const effective = toEffectiveServer(
      { serverName: 'a', transport: 'stdio', command: 'node', env: { A: '1', B: '2' }, headers: { H: 'v' } },
      10,
    );
    const masked = maskEffectiveServer(effective);
    assert.deepEqual(Object.keys(masked.env), ['A', 'B']);
    assert.deepEqual(masked.env, { A: HIDDEN, B: HIDDEN });
    assert.deepEqual(masked.headers, { H: HIDDEN });
  });

  it('isHidden / containsHidden', () => {
    assert.equal(isHidden(HIDDEN), true);
    assert.equal(isHidden('x'), false);
    assert.equal(containsHidden({ env: { A: HIDDEN } }), true);
    assert.equal(containsHidden({ env: { A: 'x' } }), false);
  });
});

describe('mask: 合并', () => {
  it('提交值为占位符时保留原值', () => {
    const merged = mergeHiddenSecrets({ A: HIDDEN, B: 'new' }, { A: 'old-a', B: 'old-b' });
    assert.deepEqual(merged, { A: 'old-a', B: 'new' });
  });

  it('原值不存在时丢弃占位符（不把 "***hidden***" 当真实值落盘）', () => {
    assert.deepEqual(mergeHiddenSecrets({ A: HIDDEN }, {}), {});
    assert.deepEqual(mergeHiddenSecrets({ A: HIDDEN }, undefined), {});
  });

  it('未提交该字段时返回 undefined（表示保持原样）', () => {
    assert.equal(mergeHiddenSecrets(undefined, { A: 'x' }), undefined);
  });
});

describe('mask: 日志安全', () => {
  it('redact 把敏感值替换成占位符', () => {
    const redacted = redact({ name: 'a', env: { TOKEN: 'sk-1' }, headers: { H: 'v' }, nested: { env: { X: 'y' } } }) as Record<string, unknown>;
    assert.deepEqual(redacted.env, { TOKEN: HIDDEN });
    assert.deepEqual(redacted.headers, { H: HIDDEN });
    assert.deepEqual((redacted.nested as Record<string, unknown>).env, { X: HIDDEN });
    assert.equal(JSON.stringify(redacted).includes('sk-1'), false);
  });
});
