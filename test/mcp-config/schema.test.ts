/**
 * schema.ts：白名单、类型/枚举/边界、条件必填、envFrom 静态校验、默认值归一化。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_ENV_FROM_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  parseServerInput,
  parseSettingsInput,
  effectiveSettings,
  setFieldsOf,
  toEffectiveServer,
} from '../../src/host/mcp-config/schema.ts';

const stdio = { serverName: 'demo', transport: 'stdio', command: 'node' };

function errorsOf(input: unknown, existingNames: string[] = []): { path: string; message: string }[] {
  return parseServerInput(input, { existingNames }).errors;
}

function paths(input: unknown, existingNames: string[] = []): string[] {
  return errorsOf(input, existingNames).map((e) => e.path);
}

describe('schema: 未知字段', () => {
  it('拒绝未知字段与拼写错误', () => {
    assert.deepEqual(paths({ ...stdio, commnad: 'node' }), ['server.commnad']);
    assert.deepEqual(paths({ ...stdio, transfer: 'stdio' }), ['server.transfer']);
    assert.deepEqual(paths({ ...stdio, envs: {} }), ['server.envs']);
  });

  it('对官方客户端插件的字段给出专门说明', () => {
    // directTools 归属 dsh-mcp-lazy（D-D9：不做工具提升），文案与另外三个区分开。
    const errors = errorsOf({ ...stdio, directTools: ['x'] });
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /这是 dsh-mcp-lazy 的工具提升字段，本插件不支持（D-D9）/);
    for (const field of ['freezeDirectTools', 'reconnect', 'failOnStartupError']) {
      const one = errorsOf({ ...stdio, [field]: true });
      assert.equal(one.length, 1, field + ' 应被拒绝');
      assert.match(one[0].message, /官方 dsh-mcp-client 的字段，本插件不支持/);
    }
  });

  it('白名单覆盖 19 个字段 + meta，且全部字段被接受', () => {
    const full = {
      serverName: 'full-1',
      transport: 'stdio',
      command: 'node',
      args: ['-e', 'x'],
      env: { A: '1' },
      envFrom: { B: 'echo b' },
      allowEmpty: ['B'],
      envFromTimeoutMs: 5000,
      cwd: 'C:/tmp',
      toolCallTimeoutMs: 1234,
      lifecycle: 'keep-alive',
      idleTimeout: 3,
      includeTools: ['a'],
      excludeTools: ['b'],
      searchKeywords: { a: ['kw'] },
      disabled: true,
      debug: true,
      meta: { description: 'd', tags: ['t'], homepage: 'https://example.com' },
    };
    assert.deepEqual(errorsOf(full), []);
  });
});

describe('schema: serverName / transport', () => {
  it('名称正则与唯一性', () => {
    assert.deepEqual(paths({ ...stdio, serverName: '' }), ['server.serverName']);
    assert.deepEqual(paths({ ...stdio, serverName: 'a'.repeat(33) }), ['server.serverName']);
    assert.deepEqual(paths({ ...stdio, serverName: '有中文' }), ['server.serverName']);
    assert.deepEqual(paths({ ...stdio, serverName: 'ok_name-1' }), []);
    assert.deepEqual(paths(stdio, ['demo']), ['server.serverName']);
    assert.deepEqual(paths(stdio, ['other']), []);
    assert.deepEqual(parseServerInput(stdio, { existingNames: ['demo'], originalName: 'demo' }).errors, []);
  });

  it('transport 枚举', () => {
    assert.deepEqual(paths({ serverName: 'x' }), ['server.transport']);
    assert.deepEqual(paths({ serverName: 'x', transport: 'sse' }), ['server.transport']);
    assert.deepEqual(paths({ serverName: 'x', transport: 'Streamable-HTTP' }), ['server.transport']);
    assert.deepEqual(paths({ serverName: 'x', transport: 'streamable-http', url: 'https://example.com/mcp' }), []);
  });
});

describe('schema: 类型与边界', () => {
  it('args 必须是字符串数组', () => {
    assert.deepEqual(paths({ ...stdio, args: 'node' }), ['server.args']);
    assert.deepEqual(paths({ ...stdio, args: [1] }), ['server.args[0]']);
    assert.deepEqual(paths({ ...stdio, args: [] }), []);
  });

  it('env / headers / envFrom 必须是字符串映射', () => {
    assert.deepEqual(paths({ ...stdio, env: ['A'] }), ['server.env']);
    assert.deepEqual(paths({ ...stdio, env: { A: 1 } }), ['server.env.A']);
    assert.deepEqual(paths({ ...stdio, headers: { Authorization: 1 } }), ['server.headers.Authorization']);
    assert.deepEqual(paths({ ...stdio, envFrom: { A: 1 } }), ['server.envFrom.A']);
  });

  it('envFrom 的变量名必须合法', () => {
    assert.deepEqual(paths({ ...stdio, envFrom: { '1BAD': 'echo' } }), ['server.envFrom.1BAD']);
    assert.deepEqual(paths({ ...stdio, envFrom: { 'A-B': 'echo' } }), ['server.envFrom.A-B']);
    assert.deepEqual(paths({ ...stdio, envFrom: { GOOD_1: 'echo' } }), []);
  });

  it('envFromTimeoutMs 为自然数', () => {
    assert.deepEqual(paths({ ...stdio, envFromTimeoutMs: -1 }), ['server.envFromTimeoutMs']);
    assert.deepEqual(paths({ ...stdio, envFromTimeoutMs: 1.5 }), ['server.envFromTimeoutMs']);
    assert.equal(parseServerInput({ ...stdio, envFromTimeoutMs: 0 }).errors.length, 0);
  });

  it('toolCallTimeoutMs 为数字，≤0 表示不设超时', () => {
    assert.deepEqual(paths({ ...stdio, toolCallTimeoutMs: '60000' }), ['server.toolCallTimeoutMs']);
    assert.deepEqual(paths({ ...stdio, toolCallTimeoutMs: -1 }), []);
    assert.deepEqual(paths({ ...stdio, toolCallTimeoutMs: 0 }), []);
    assert.equal(parseServerInput({ ...stdio, toolCallTimeoutMs: 0 }).server.toolCallTimeoutMs, 0);
    assert.equal(parseServerInput({ ...stdio, toolCallTimeoutMs: -1000 }).server.toolCallTimeoutMs, -1000);
  });

  it('lifecycle 枚举，idleTimeout 为自然数', () => {
    assert.deepEqual(paths({ ...stdio, lifecycle: 'forever' }), ['server.lifecycle']);
    for (const value of ['lazy', 'lazy-keep-alive', 'eager', 'keep-alive']) {
      assert.deepEqual(paths({ ...stdio, lifecycle: value }), [], value);
    }
    assert.deepEqual(paths({ ...stdio, idleTimeout: -1 }), ['server.idleTimeout']);
    assert.deepEqual(paths({ ...stdio, idleTimeout: 0 }), []);
  });

  it('disabled / debug 必须是布尔', () => {
    assert.deepEqual(paths({ ...stdio, disabled: 'true' }), ['server.disabled']);
    assert.deepEqual(paths({ ...stdio, debug: 1 }), ['server.debug']);
    assert.deepEqual(paths({ ...stdio, disabled: true, debug: false }), []);
  });

  it('meta 只接受 description / tags / homepage', () => {
    assert.deepEqual(paths({ ...stdio, meta: { extra: 1 } }), ['server.meta.extra']);
    assert.deepEqual(paths({ ...stdio, meta: { tags: [1] } }), ['server.meta.tags']);
    assert.deepEqual(paths({ ...stdio, meta: { tags: ['a'], description: 'd', homepage: 'h' } }), []);
  });

  it('searchKeywords 是「工具名 → 字符串数组」', () => {
    assert.deepEqual(paths({ ...stdio, searchKeywords: { a: 'kw' } }), ['server.searchKeywords.a']);
    assert.deepEqual(paths({ ...stdio, searchKeywords: { a: ['kw'] } }), []);
  });
});

describe('schema: 条件必填', () => {
  it('stdio 必须有非空 command', () => {
    assert.deepEqual(paths({ serverName: 'x', transport: 'stdio' }), ['server.command']);
    assert.deepEqual(paths({ serverName: 'x', transport: 'stdio', command: '   ' }), ['server.command']);
  });

  it('streamable-http 必须有合法 url', () => {
    assert.deepEqual(paths({ serverName: 'x', transport: 'streamable-http' }), ['server.url']);
    assert.deepEqual(paths({ serverName: 'x', transport: 'streamable-http', url: 'ftp://x/y' }), ['server.url']);
    assert.deepEqual(paths({ serverName: 'x', transport: 'streamable-http', url: '不是地址' }), ['server.url']);
    assert.deepEqual(paths({ serverName: 'x', transport: 'streamable-http', url: 'http://127.0.0.1:3000/mcp' }), []);
  });
});

describe('schema: envFrom 静态校验（4 条）', () => {
  it('envFrom 不能用于非 stdio', () => {
    const errors = errorsOf({
      serverName: 'x',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      envFrom: { A: 'echo a' },
    });
    assert.deepEqual(errors.map((e) => e.path), ['server.envFrom']);
    assert.match(errors[0].message, /只能用于 stdio/);
  });

  it('同名变量不能同时出现在 env 与 envFrom', () => {
    const errors = errorsOf({ ...stdio, env: { A: '1' }, envFrom: { A: 'echo a' } });
    assert.deepEqual(errors.map((e) => e.path), ['server.envFrom.A']);
    assert.match(errors[0].message, /同时出现在 env 与 envFrom/);
  });

  it('envFrom 的命令不能是空字符串', () => {
    const errors = errorsOf({ ...stdio, envFrom: { A: '' } });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'server.envFrom.A');
  });

  it('allowEmpty 里的名字必须在 envFrom 中声明', () => {
    const errors = errorsOf({ ...stdio, envFrom: { A: 'echo a' }, allowEmpty: ['B'] });
    assert.deepEqual(errors.map((e) => e.path), ['server.allowEmpty']);
    assert.match(errors[0].message, /没有在 envFrom 中声明/);
    assert.deepEqual(errorsOf({ ...stdio, envFrom: { A: 'echo a' }, allowEmpty: ['A'] }), []);
    assert.deepEqual(paths({ ...stdio, allowEmpty: ['A'] }), ['server.allowEmpty']);
    assert.deepEqual(paths({ ...stdio, allowEmpty: ['1BAD'] }), ['server.allowEmpty']);
  });
});

describe('schema: 默认值不落盘', () => {
  it('归一化结果只保留非默认字段', () => {
    const parsed = parseServerInput({
      serverName: 'demo',
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      envFrom: {},
      allowEmpty: [],
      envFromTimeoutMs: DEFAULT_ENV_FROM_TIMEOUT_MS,
      headers: {},
      toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
      lifecycle: 'lazy',
      searchKeywords: {},
      disabled: false,
      debug: false,
      meta: {},
    });
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.server, { serverName: 'demo', transport: 'stdio', command: 'node' });
    assert.deepEqual(setFieldsOf(parsed.server).sort(), ['command', 'serverName', 'transport']);
  });

  it('显式设置的 idleTimeout=0 会落盘（0 是有效值，不等于「未设置」）', () => {
    const parsed = parseServerInput({ ...stdio, idleTimeout: 0 });
    assert.equal(parsed.server.idleTimeout, 0);
    assert.equal(setFieldsOf(parsed.server).includes('idleTimeout'), true);
  });

  it('生效值补齐默认', () => {
    const effective = toEffectiveServer({ serverName: 'demo', transport: 'stdio', command: 'node' }, 10);
    assert.deepEqual(effective.args, []);
    assert.deepEqual(effective.env, {});
    assert.equal(effective.envFromTimeoutMs, DEFAULT_ENV_FROM_TIMEOUT_MS);
    assert.equal(effective.toolCallTimeoutMs, DEFAULT_TOOL_CALL_TIMEOUT_MS);
    assert.equal(effective.lifecycle, 'lazy');
    assert.equal(effective.disabled, false);
    assert.equal(effective.debug, false);
    assert.equal(effective.idleTimeoutMin, 10);
    assert.deepEqual(effective.searchKeywords, {});
  });

  it('服务器 idleTimeout 覆盖全局', () => {
    const effective = toEffectiveServer({ serverName: 'demo', transport: 'stdio', command: 'node', idleTimeout: 2 }, 10);
    assert.equal(effective.idleTimeoutMin, 2);
  });
});

describe('schema: 全局设置', () => {
  it('默认值', () => {
    assert.deepEqual(effectiveSettings({}), {
      idleTimeoutMin: 10,
      outputGuard: { enabled: true, maxBytes: 51200, maxLines: 2000 },
      failureBackoffMs: 60000,
    });
  });

  it('outputGuard 的三种写法', () => {
    assert.deepEqual(effectiveSettings({ outputGuard: true }).outputGuard, { enabled: true, maxBytes: 51200, maxLines: 2000 });
    assert.deepEqual(effectiveSettings({ outputGuard: false }).outputGuard, { enabled: false, maxBytes: 51200, maxLines: 2000 });
    assert.deepEqual(effectiveSettings({ outputGuard: { maxBytes: 100 } }).outputGuard, {
      enabled: true,
      maxBytes: 100,
      maxLines: 2000,
    });
  });

  it('只保留非默认项', () => {
    assert.deepEqual(parseSettingsInput({ idleTimeout: 10, failureBackoffMs: 60000, outputGuard: true }).settings, {});
    assert.deepEqual(parseSettingsInput({ idleTimeout: 0 }).settings, { idleTimeout: 0 });
    assert.deepEqual(parseSettingsInput({ failureBackoffMs: 1000 }).settings, { failureBackoffMs: 1000 });
    assert.deepEqual(parseSettingsInput({ outputGuard: false }).settings, { outputGuard: false });
    assert.deepEqual(parseSettingsInput({ outputGuard: { maxLines: 10 } }).settings, { outputGuard: { maxLines: 10 } });
  });

  it('拒绝未知设置项与非法值', () => {
    assert.deepEqual(parseSettingsInput({ idleTimeOut: 5 }).errors.map((e) => e.path), ['settings.idleTimeOut']);
    assert.deepEqual(parseSettingsInput({ idleTimeout: -1 }).errors.map((e) => e.path), ['settings.idleTimeout']);
    assert.deepEqual(parseSettingsInput({ failureBackoffMs: -1 }).errors.map((e) => e.path), ['settings.failureBackoffMs']);
    assert.deepEqual(parseSettingsInput({ outputGuard: { maxBytes: 0 } }).errors.map((e) => e.path), [
      'settings.outputGuard.maxBytes',
    ]);
    assert.deepEqual(parseSettingsInput({ outputGuard: { nope: 1 } }).errors.map((e) => e.path), ['settings.outputGuard.nope']);
  });
});
