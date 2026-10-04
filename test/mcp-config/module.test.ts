/**
 * module.ts：PLAN §3.7「MCP·配置」全部路由 + 错误码 + 遮罩 + 导入。
 * 全部落在 os.tmpdir() 的临时目录；命令检查用临时 bin 目录 + 自定义 PATH。
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createMcpConfigModule } from '../../src/host/mcp-config/module.ts';
import type { CommandCheckOptions } from '../../src/host/mcp-config/types.ts';
import { callRoute, expectRejection, makeContext, makeTempDir, readJson, recordingLogger, type RecordingLogger } from './helpers.ts';

const SECRET_ENV = 'sk-live-SECRET-ENV-0001';
const SECRET_HEADER = 'Bearer SECRET-HEADER-0002';

interface Harness {
  hubHome: string;
  homeDir: string;
  module: ReturnType<typeof createMcpConfigModule>;
  logger: RecordingLogger;
  call(key: string, body?: unknown): Promise<unknown>;
  cleanup(): Promise<void>;
}

async function harness(opts: { commandCheck?: CommandCheckOptions } = {}): Promise<Harness> {
  const hubTemp = await makeTempDir('mcp-config-hub-');
  const homeTemp = await makeTempDir('mcp-config-home-');
  const logger = recordingLogger();
  const ctx = makeContext(hubTemp.path, homeTemp.path, logger);
  const module = createMcpConfigModule(ctx, { store: { pollIntervalMs: 0 }, commandCheck: opts.commandCheck });
  await module.ready();
  return {
    hubHome: hubTemp.path,
    homeDir: homeTemp.path,
    module,
    logger,
    call: (key, body) => callRoute(module.routes, key, body),
    async cleanup() {
      module.dispose();
      await hubTemp.cleanup();
      await homeTemp.cleanup();
    },
  };
}

const stdioServer = { serverName: 'demo', transport: 'stdio', command: 'node' };

describe('module: 路由表', () => {
  it('实现 PLAN §3.7 的全部 13 个 MCP·配置路由', async () => {
    const h = await harness();
    try {
      assert.deepEqual(Object.keys(h.module.routes).sort(), [
        'GET mcp/config',
        'GET mcp/import/sources',
        'GET mcp/presets',
        'POST mcp/check-command',
        'POST mcp/import/apply',
        'POST mcp/parse-json',
        'POST mcp/servers/delete',
        'POST mcp/servers/reorder',
        'POST mcp/servers/reveal',
        'POST mcp/servers/toggle',
        'POST mcp/servers/upsert',
        'POST mcp/settings/update',
        'POST mcp/validate',
      ]);
      assert.equal(typeof h.module.source.get, 'function');
      assert.equal(typeof h.module.source.onChange, 'function');
      assert.equal(typeof h.module.dispose, 'function');
    } finally {
      await h.cleanup();
    }
  });

  it('GET mcp/config 空配置形状', async () => {
    const h = await harness();
    try {
      const data = (await h.call('GET mcp/config')) as Record<string, unknown>;
      assert.deepEqual(data.settings, { idleTimeoutMin: 10, outputGuard: { enabled: true, maxBytes: 51200, maxLines: 2000 }, failureBackoffMs: 60000 });
      assert.deepEqual(data.settingsSet, []);
      assert.deepEqual(data.servers, []);
      assert.deepEqual(data.warnings, []);
    } finally {
      await h.cleanup();
    }
  });
});

describe('module: upsert', () => {
  it('新增服务器并返回视图（含 setFields 与默认值提示）', async () => {
    const h = await harness();
    try {
      const data = (await h.call('POST mcp/servers/upsert', { server: stdioServer })) as {
        server: { serverName: string; setFields: string[]; defaults: { lifecycle: string }; args: string[]; lifecycle: string };
      };
      assert.equal(data.server.serverName, 'demo');
      assert.deepEqual(data.server.setFields.sort(), ['command', 'serverName', 'transport']);
      assert.equal(data.server.defaults.lifecycle, 'lazy');
      assert.deepEqual(data.server.args, []);
      assert.equal(data.server.lifecycle, 'lazy');
      const onDisk = (await readJson(join(h.hubHome, 'mcp', 'config.json'))) as { servers: unknown[] };
      assert.deepEqual(onDisk.servers, [stdioServer]);
    } finally {
      await h.cleanup();
    }
  });

  it('VALIDATION 的 details 是 { path, message }[]', async () => {
    const h = await harness();
    try {
      const error = await expectRejection(() => h.call('POST mcp/servers/upsert', { server: { serverName: 'x', transport: 'stdio', recoonect: true } }));
      assert.equal(error.status, 422);
      assert.equal(error.code, 'VALIDATION');
      const details = error.details as { path: string; message: string }[];
      assert.equal(Array.isArray(details), true);
      assert.deepEqual(details.map((d) => d.path).sort(), ['server.command', 'server.recoonect']);
      const unknown = details.find((d) => d.path === 'server.recoonect');
      assert.ok(unknown);
      assert.match(unknown.message, /不支持的字段/);
      assert.match(error.message, /校验未通过/);
    } finally {
      await h.cleanup();
    }
  });

  it('重名返回 VALIDATION（带 server.serverName 路径）', async () => {
    const h = await harness();
    try {
      await h.call('POST mcp/servers/upsert', { server: stdioServer });
      const error = await expectRejection(() => h.call('POST mcp/servers/upsert', { server: { ...stdioServer, command: 'node2' } }));
      assert.equal(error.code, 'VALIDATION');
      assert.deepEqual((error.details as { path: string }[]).map((d) => d.path), ['server.serverName']);
    } finally {
      await h.cleanup();
    }
  });

  it('改名：originalName 指定原名，配置顺序保持不变', async () => {
    const h = await harness();
    try {
      await h.call('POST mcp/servers/upsert', { server: { serverName: 'a', transport: 'stdio', command: 'node' } });
      await h.call('POST mcp/servers/upsert', { server: { serverName: 'b', transport: 'stdio', command: 'node' } });
      await h.call('POST mcp/servers/upsert', { originalName: 'a', server: { ...stdioServer, serverName: 'renamed' } });
      const config = (await h.call('GET mcp/config')) as { servers: { serverName: string }[] };
      assert.deepEqual(config.servers.map((s) => s.serverName), ['renamed', 'b']);
    } finally {
      await h.cleanup();
    }
  });

  it('改名到已存在的名字被拒', async () => {
    const h = await harness();
    try {
      await h.call('POST mcp/servers/upsert', { server: { serverName: 'a', transport: 'stdio', command: 'node' } });
      await h.call('POST mcp/servers/upsert', { server: { serverName: 'b', transport: 'stdio', command: 'node' } });
      const error = await expectRejection(() => h.call('POST mcp/servers/upsert', { originalName: 'a', server: { serverName: 'b', transport: 'stdio', command: 'node' } }));
      assert.equal(error.code, 'VALIDATION');
    } finally {
      await h.cleanup();
    }
  });

  it('原服务器不存在时 NOT_FOUND', async () => {
    const h = await harness();
    try {
      const error = await expectRejection(() => h.call('POST mcp/servers/upsert', { originalName: 'nope', server: stdioServer }));
      assert.equal(error.status, 404);
      assert.equal(error.code, 'NOT_FOUND');
      // 名字没被占用时（没有 originalName）不该报 NOT_FOUND
      await h.call('POST mcp/servers/upsert', { server: stdioServer });
    } finally {
      await h.cleanup();
    }
  });

  it('命令不存在时照常保存，但返回警告并写日志', async () => {
    const h = await harness({ commandCheck: { pathEnv: '', pathExt: '.CMD', platform: 'win32' } });
    try {
      const data = (await h.call('POST mcp/servers/upsert', { server: { serverName: 'ghost', transport: 'stdio', command: 'no-such-command-xyz' } })) as {
        warnings: string[];
      };
      assert.equal(data.warnings.length, 1);
      assert.match(data.warnings[0], /没有找到启动命令/);
      assert.match(h.logger.text(), /找不到启动命令/);
    } finally {
      await h.cleanup();
    }
  });

  it('请求体不是对象时 BAD_REQUEST', async () => {
    const h = await harness();
    try {
      const error = await expectRejection(() => h.call('POST mcp/servers/upsert', 'nope'));
      assert.equal(error.status, 400);
      assert.equal(error.code, 'BAD_REQUEST');
      const missing = await expectRejection(() => h.call('POST mcp/servers/upsert', {}));
      assert.equal(missing.code, 'BAD_REQUEST');
      assert.match(missing.message, /缺少必填参数 server/);
    } finally {
      await h.cleanup();
    }
  });
});

describe('module: 遮罩与 reveal', () => {
  it('视图里 env / headers 的值被遮罩，reveal 返回明文', async () => {
    const h = await harness();
    try {
      await h.call('POST mcp/servers/upsert', {
        server: { ...stdioServer, env: { TOKEN: SECRET_ENV }, headers: { Authorization: SECRET_HEADER } },
      });
      const view = (await h.call('GET mcp/config')) as { servers: Record<string, unknown>[] };
      assert.deepEqual((view.servers[0] as { env: Record<string, string> }).env, { TOKEN: '***hidden***' });
      assert.deepEqual((view.servers[0] as { headers: Record<string, string> }).headers, { Authorization: '***hidden***' });
      assert.equal(JSON.stringify(view).includes(SECRET_ENV), false);
      assert.equal(JSON.stringify(view).includes(SECRET_HEADER), false);

      const revealed = (await h.call('POST mcp/servers/reveal', { name: 'demo' })) as { server: { env: Record<string, string>; headers: Record<string, string> } };
      assert.deepEqual(revealed.server.env, { TOKEN: SECRET_ENV });
      assert.deepEqual(revealed.server.headers, { Authorization: SECRET_HEADER });
      assert.equal(h.logger.text().includes(SECRET_ENV), false);
      assert.equal(h.logger.text().includes(SECRET_HEADER), false);
    } finally {
      await h.cleanup();
    }
  });

  it('upsert 提交遮罩占位时保留原值（含改名）', async () => {
    const h = await harness();
    try {
      await h.call('POST mcp/servers/upsert', { server: { ...stdioServer, env: { TOKEN: SECRET_ENV }, headers: { Authorization: SECRET_HEADER } } });
      const view = (await h.call('POST mcp/servers/upsert', {
        originalName: 'demo',
        server: { serverName: 'demo-2', transport: 'stdio', command: 'node', env: { TOKEN: '***hidden***' }, headers: { Authorization: '***hidden***' } },
      })) as { server: { serverName: string } };
      assert.equal(view.server.serverName, 'demo-2');
      const revealed = (await h.call('POST mcp/servers/reveal', { name: 'demo-2' })) as { server: { env: Record<string, string>; headers: Record<string, string> } };
      assert.deepEqual(revealed.server.env, { TOKEN: SECRET_ENV });
      assert.deepEqual(revealed.server.headers, { Authorization: SECRET_HEADER });
    } finally {
      await h.cleanup();
    }
  });

  it('改名时值用占位符但原服务器没有该键：拒绝（占位符绝不会被写成真实值）', async () => {
    const h = await harness();
    try {
      await h.call('POST mcp/servers/upsert', { server: stdioServer });
      // FIX-3 起：原配置里没有这个键 → 没有原值可回填 → VALIDATION。
      // （旧行为是静默丢弃该键并保存成功；本用例的意图不变 —— 占位符绝不落盘。）
      const error = await expectRejection(() =>
        h.call('POST mcp/servers/upsert', {
          originalName: 'demo',
          server: { serverName: 'demo', transport: 'stdio', command: 'node', env: { NEW: '***hidden***' } },
        }),
      );
      assert.equal(error.status, 422);
      assert.equal(error.code, 'VALIDATION');
      assert.deepEqual((error.details as { path: string }[]).map((d) => d.path), ['server.env.NEW']);
      const revealed = (await h.call('POST mcp/servers/reveal', { name: 'demo' })) as { server: { env: Record<string, string> } };
      assert.deepEqual(revealed.server.env, {}, '被拒绝的提交不得改动原服务器');
      assert.equal(JSON.stringify(revealed).includes('***hidden***'), false);
    } finally {
      await h.cleanup();
    }
  });

  it('reveal 不存在的服务器 NOT_FOUND', async () => {
    const h = await harness();
    try {
      const error = await expectRejection(() => h.call('POST mcp/servers/reveal', { name: 'nope' }));
      assert.equal(error.status, 404);
      assert.equal(error.code, 'NOT_FOUND');
    } finally {
      await h.cleanup();
    }
  });
});

describe('module: delete / toggle / reorder', () => {
  async function seed(h: Harness): Promise<void> {
    for (const name of ['a', 'b', 'c']) {
      await h.call('POST mcp/servers/upsert', { server: { serverName: name, transport: 'stdio', command: 'node' } });
    }
  }

  it('delete 删除并持久化', async () => {
    const h = await harness();
    try {
      await seed(h);
      assert.deepEqual(await h.call('POST mcp/servers/delete', { name: 'b' }), {});
      const onDisk = (await readJson(join(h.hubHome, 'mcp', 'config.json'))) as { servers: { serverName: string }[] };
      assert.deepEqual(onDisk.servers.map((s) => s.serverName), ['a', 'c']);
      const error = await expectRejection(() => h.call('POST mcp/servers/delete', { name: 'b' }));
      assert.equal(error.status, 404);
    } finally {
      await h.cleanup();
    }
  });

  it('toggle 写入/移除 disabled，且 disabled=false 不落盘', async () => {
    const h = await harness();
    try {
      await seed(h);
      const off = (await h.call('POST mcp/servers/toggle', { name: 'a', disabled: true })) as { server: { disabled: boolean } };
      assert.equal(off.server.disabled, true);
      let onDisk = (await readJson(join(h.hubHome, 'mcp', 'config.json'))) as { servers: Record<string, unknown>[] };
      assert.equal(onDisk.servers[0].disabled, true);
      const on = (await h.call('POST mcp/servers/toggle', { name: 'a', disabled: false })) as { server: { disabled: boolean } };
      assert.equal(on.server.disabled, false);
      onDisk = (await readJson(join(h.hubHome, 'mcp', 'config.json'))) as { servers: Record<string, unknown>[] };
      assert.equal('disabled' in onDisk.servers[0], false);
    } finally {
      await h.cleanup();
    }
  });

  it('toggle 参数类型错误 BAD_REQUEST；服务器不存在 NOT_FOUND', async () => {
    const h = await harness();
    try {
      assert.equal((await expectRejection(() => h.call('POST mcp/servers/toggle', { name: 'a', disabled: 'yes' }))).code, 'BAD_REQUEST');
      assert.equal((await expectRejection(() => h.call('POST mcp/servers/toggle', { name: 'a', disabled: true }))).code, 'NOT_FOUND');
    } finally {
      await h.cleanup();
    }
  });

  it('reorder 按 names 重排并持久化', async () => {
    const h = await harness();
    try {
      await seed(h);
      await h.call('POST mcp/servers/reorder', { names: ['c', 'a', 'b'] });
      const config = (await h.call('GET mcp/config')) as { servers: { serverName: string }[] };
      assert.deepEqual(config.servers.map((s) => s.serverName), ['c', 'a', 'b']);
      const onDisk = (await readJson(join(h.hubHome, 'mcp', 'config.json'))) as { servers: { serverName: string }[] };
      assert.deepEqual(onDisk.servers.map((s) => s.serverName), ['c', 'a', 'b']);
    } finally {
      await h.cleanup();
    }
  });

  it('reorder 缺项 / 多出 / 重复都拒绝', async () => {
    const h = await harness();
    try {
      await seed(h);
      for (const names of [['a', 'b'], ['a', 'b', 'c', 'd'], ['a', 'a', 'c']]) {
        const error = await expectRejection(() => h.call('POST mcp/servers/reorder', { names }));
        assert.equal(error.code, 'VALIDATION', JSON.stringify(names));
        assert.equal(Array.isArray(error.details), true);
      }
      const config = (await h.call('GET mcp/config')) as { servers: { serverName: string }[] };
      assert.deepEqual(config.servers.map((s) => s.serverName), ['a', 'b', 'c']);
    } finally {
      await h.cleanup();
    }
  });
});

describe('module: 设置 / 校验 / 解析 / 预设 / 检查', () => {
  it('settings/update 只落盘非默认项', async () => {
    const h = await harness();
    try {
      const data = (await h.call('POST mcp/settings/update', { settings: { idleTimeout: 5, outputGuard: { maxBytes: 1024 }, failureBackoffMs: 60000 } })) as {
        settings: { idleTimeoutMin: number; outputGuard: { maxBytes: number; maxLines: number }; failureBackoffMs: number };
        settingsSet: string[];
      };
      assert.equal(data.settings.idleTimeoutMin, 5);
      assert.deepEqual(data.settings.outputGuard, { enabled: true, maxBytes: 1024, maxLines: 2000 });
      assert.equal(data.settings.failureBackoffMs, 60000);
      assert.deepEqual(data.settingsSet.sort(), ['idleTimeout', 'outputGuard']);
      const onDisk = (await readJson(join(h.hubHome, 'mcp', 'config.json'))) as { settings: Record<string, unknown> };
      assert.deepEqual(onDisk.settings, { idleTimeout: 5, outputGuard: { maxBytes: 1024 } });
    } finally {
      await h.cleanup();
    }
  });

  it('settings/update 拒绝非法值', async () => {
    const h = await harness();
    try {
      const error = await expectRejection(() => h.call('POST mcp/settings/update', { settings: { idleTimeout: -3 } }));
      assert.equal(error.code, 'VALIDATION');
      assert.deepEqual((error.details as { path: string }[]).map((d) => d.path), ['settings.idleTimeout']);
    } finally {
      await h.cleanup();
    }
  });

  it('全局 idleTimeout 影响服务器的 idleTimeoutMin 解析', async () => {
    const h = await harness();
    try {
      await h.call('POST mcp/servers/upsert', { server: stdioServer });
      await h.call('POST mcp/settings/update', { settings: { idleTimeout: 2 } });
      const config = (await h.call('GET mcp/config')) as { servers: { idleTimeoutMin: number }[] };
      assert.equal(config.servers[0].idleTimeoutMin, 2);
      assert.equal(h.module.source.get().servers[0].idleTimeoutMin, 2);
    } finally {
      await h.cleanup();
    }
  });

  it('validate 只校验不落盘', async () => {
    const h = await harness();
    try {
      await h.call('POST mcp/servers/upsert', { server: stdioServer });
      const dup = (await h.call('POST mcp/validate', { server: stdioServer })) as { errors: { path: string }[] };
      assert.deepEqual(dup.errors.map((e) => e.path), ['server.serverName']);
      const ok = (await h.call('POST mcp/validate', { server: { serverName: 'other', transport: 'stdio', command: 'node' } })) as {
        errors: unknown[];
        server: { serverName: string };
      };
      assert.deepEqual(ok.errors, []);
      assert.equal(ok.server.serverName, 'other');
      const onDisk = (await readJson(join(h.hubHome, 'mcp', 'config.json'))) as { servers: unknown[] };
      assert.equal(onDisk.servers.length, 1);
    } finally {
      await h.cleanup();
    }
  });

  it('parse-json 识别并返回服务器', async () => {
    const h = await harness({ commandCheck: { pathEnv: '', pathExt: '.CMD', platform: 'win32' } });
    try {
      const data = (await h.call('POST mcp/parse-json', {
        text: JSON.stringify({ mcpServers: { a: { command: 'node' }, b: { type: 'sse', url: 'https://x/y' } } }),
      })) as { servers: { serverName: string; transport: string }[]; warnings: string[] };
      assert.deepEqual(data.servers.map((s) => s.serverName), ['a', 'b']);
      assert.equal(data.servers[1].transport, 'streamable-http');
      assert.equal(data.warnings.some((w) => w.includes('不支持 SSE')), true);
      assert.equal(data.warnings.some((w) => w.includes('没有找到')), true);
      const bad = await expectRejection(() => h.call('POST mcp/parse-json', { text: 123 }));
      assert.equal(bad.code, 'BAD_REQUEST');
    } finally {
      await h.cleanup();
    }
  });

  it('presets 返回 5 个模板并附带命令可用性', async () => {
    const h = await harness({ commandCheck: { pathEnv: '', pathExt: '.CMD', platform: 'win32' } });
    try {
      const data = (await h.call('GET mcp/presets')) as { presets: { id: string; commandFound: boolean; title: string; description: string }[] };
      assert.deepEqual(data.presets.map((p) => p.id), ['fetch', 'time', 'memory', 'sequential-thinking', 'context7']);
      for (const preset of data.presets) {
        assert.equal(preset.commandFound, false);
        assert.ok(preset.title.length > 0);
        assert.ok(preset.description.length > 0);
      }
    } finally {
      await h.cleanup();
    }
  });

  it('check-command 走注入的 PATH/PATHEXT', async () => {
    const binTemp = await makeTempDir('mcp-config-bin-');
    const h = await harness();
    try {
      const bin = join(binTemp.path, 'bin');
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(join(bin, 'mytool.cmd'), 'x', 'utf8');
      const ctxOpts = { pathEnv: bin, pathExt: '.CMD', platform: 'win32' as const };
      // 通过自定义 commandCheck 注入
      const custom = createMcpConfigModule(makeContext(h.hubHome, h.homeDir, h.logger), { store: { pollIntervalMs: 0 }, commandCheck: ctxOpts });
      await custom.ready();
      const found = (await callRoute(custom.routes, 'POST mcp/check-command', { command: 'mytool' })) as { found: boolean; resolvedPath?: string };
      assert.equal(found.found, true);
      assert.equal(found.resolvedPath?.toLowerCase(), join(bin, 'mytool.cmd').toLowerCase());
      const missing = (await callRoute(custom.routes, 'POST mcp/check-command', { command: 'nope' })) as { found: boolean };
      assert.equal(missing.found, false);
      const bad = await expectRejection(() => callRoute(custom.routes, 'POST mcp/check-command', {}));
      assert.equal(bad.code, 'BAD_REQUEST');
      custom.dispose();
    } finally {
      await h.cleanup();
      await binTemp.cleanup();
    }
  });
});

describe('module: 只读导入', () => {
  it('import/sources 返回两个来源且服务器已遮罩', async () => {
    const h = await harness();
    try {
      await fs.writeFile(
        join(h.homeDir, '.claude.json'),
        JSON.stringify({ mcpServers: { imported: { command: 'node', env: { TOKEN: SECRET_ENV } } } }),
        'utf8',
      );
      const data = (await h.call('GET mcp/import/sources')) as { sources: { id: string; found: boolean; servers: Record<string, unknown>[] }[] };
      assert.deepEqual(data.sources.map((s) => s.id), ['claude-code', 'codex']);
      assert.equal(data.sources[0].found, true);
      assert.equal(data.sources[1].found, false);
      assert.deepEqual((data.sources[0].servers[0] as { env: Record<string, string> }).env, { TOKEN: '***hidden***' });
      assert.equal(JSON.stringify(data).includes(SECRET_ENV), false);
    } finally {
      await h.cleanup();
    }
  });

  it('import/apply 落盘明文、同名跳过、可被后续 upsert 接受', async () => {
    const h = await harness();
    try {
      await fs.writeFile(
        join(h.homeDir, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            imported: { command: 'node', args: ['x'], env: { TOKEN: SECRET_ENV } },
            clash: { command: 'node' },
          },
        }),
        'utf8',
      );
      await h.call('POST mcp/servers/upsert', { server: { serverName: 'clash', transport: 'stdio', command: 'node-other' } });

      const data = (await h.call('POST mcp/import/apply', { sourceId: 'claude-code', names: ['imported', 'clash', 'absent'] })) as {
        imported: string[];
        skipped: { name: string; reason: string }[];
      };
      assert.deepEqual(data.imported, ['imported']);
      assert.deepEqual(data.skipped.map((s) => s.name), ['clash', 'absent']);
      assert.match(data.skipped[0].reason, /同名服务器已存在/);
      assert.equal(data.skipped[0].reason.includes(SECRET_ENV), false);

      const revealed = (await h.call('POST mcp/servers/reveal', { name: 'imported' })) as { server: { env: Record<string, string> } };
      assert.deepEqual(revealed.server.env, { TOKEN: SECRET_ENV });
      const onDisk = (await readJson(join(h.hubHome, 'mcp', 'config.json'))) as { servers: { serverName: string }[] };
      assert.deepEqual(onDisk.servers.map((s) => s.serverName), ['clash', 'imported']);
    } finally {
      await h.cleanup();
    }
  });

  it('import/apply 的 sourceId 非法或来源缺失时给出 4xx', async () => {
    const h = await harness();
    try {
      const bad = await expectRejection(() => h.call('POST mcp/import/apply', { sourceId: 'vscode', names: [] }));
      assert.equal(bad.status, 400);
      const noFile = await expectRejection(() => h.call('POST mcp/import/apply', { sourceId: 'codex', names: ['x'] }));
      assert.equal(noFile.status, 404);
      assert.match(noFile.message, /没有找到 Codex 的配置文件/);
    } finally {
      await h.cleanup();
    }
  });
});

describe('module: 敏感值不泄漏', () => {
  it('除 reveal 外的所有响应与日志都不含明文', async () => {
    const h = await harness({ commandCheck: { pathEnv: '', pathExt: '.CMD', platform: 'win32' } });
    try {
      await fs.writeFile(
        join(h.homeDir, '.claude.json'),
        JSON.stringify({ mcpServers: { fromclaude: { command: 'node', env: { TOKEN: SECRET_ENV }, headers: { Authorization: SECRET_HEADER } } } }),
        'utf8',
      );
      const responses: unknown[] = [];
      responses.push(await h.call('POST mcp/servers/upsert', { server: { ...stdioServer, env: { TOKEN: SECRET_ENV }, headers: { Authorization: SECRET_HEADER } } }));
      responses.push(await h.call('GET mcp/config'));
      responses.push(await h.call('POST mcp/servers/toggle', { name: 'demo', disabled: true }));
      responses.push(await h.call('POST mcp/servers/reorder', { names: ['demo'] }));
      responses.push(await h.call('POST mcp/settings/update', { settings: { idleTimeout: 1 } }));
      responses.push(await h.call('POST mcp/validate', { server: { ...stdioServer, env: { TOKEN: SECRET_ENV } } }));
      // parse-json 只回显「本次请求提交的文本」，不读取已存储的配置：
      // 这里故意粘贴一段无关 JSON，验证已存储的敏感值不会从这条路由漏出去。
      responses.push(await h.call('POST mcp/parse-json', { text: JSON.stringify({ mcpServers: { p: { command: 'node' } } }) }));
      responses.push(await h.call('GET mcp/presets'));
      responses.push(await h.call('GET mcp/import/sources'));
      responses.push(await h.call('POST mcp/import/apply', { sourceId: 'claude-code', names: ['fromclaude'] }));
      responses.push(await h.call('POST mcp/check-command', { command: 'node' }));
      responses.push(await h.call('POST mcp/servers/delete', { name: 'demo' }));

      for (const [index, response] of responses.entries()) {
        const text = JSON.stringify(response);
        assert.equal(text.includes(SECRET_ENV), false, '第 ' + index + ' 个响应泄漏了 env 明文');
        assert.equal(text.includes(SECRET_HEADER), false, '第 ' + index + ' 个响应泄漏了 headers 明文');
      }
      assert.equal(h.logger.text().includes(SECRET_ENV), false, '日志泄漏了 env 明文');
      assert.equal(h.logger.text().includes(SECRET_HEADER), false, '日志泄漏了 headers 明文');

      // 磁盘上必然是明文（这是配置本身），但只应存在于 config.json 里
      const onDisk = await fs.readFile(join(h.hubHome, 'mcp', 'config.json'), 'utf8');
      assert.equal(onDisk.includes(SECRET_ENV), true);
      const files: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else files.push(full);
        }
      };
      await walk(h.hubHome);
      assert.deepEqual(files.map((f) => f.slice(h.hubHome.length + 1)), [join('mcp', 'config.json')]);
    } finally {
      await h.cleanup();
    }
  });

  it('parse-json 只回显本次提交的内容，绝不带出已存储的敏感值', async () => {
    const h = await harness();
    try {
      await h.call('POST mcp/servers/upsert', { server: { ...stdioServer, env: { TOKEN: SECRET_ENV } } });
      const data = await h.call('POST mcp/parse-json', { text: JSON.stringify({ mcpServers: { other: { command: 'node' } } }) });
      assert.equal(JSON.stringify(data).includes(SECRET_ENV), false);
      assert.equal(h.logger.text().includes(SECRET_ENV), false);
    } finally {
      await h.cleanup();
    }
  });

  it('导入路径绝不写 Claude Code / Codex 文件与 homeDir', async () => {
    const h = await harness();
    try {
      const claudePath = join(h.homeDir, '.claude.json');
      const claudeText = JSON.stringify({ mcpServers: { imported: { command: 'node', env: { TOKEN: SECRET_ENV } } } });
      await fs.writeFile(claudePath, claudeText, 'utf8');
      const before = await fs.stat(claudePath);
      const homeBefore = (await fs.readdir(h.homeDir)).sort();

      await h.call('GET mcp/import/sources');
      await h.call('POST mcp/import/apply', { sourceId: 'claude-code', names: ['imported'] });
      await h.call('POST mcp/servers/upsert', { server: stdioServer });

      assert.equal(await fs.readFile(claudePath, 'utf8'), claudeText, '导入不得改写 Claude Code 配置');
      const after = await fs.stat(claudePath);
      assert.equal(after.mtimeMs, before.mtimeMs, '导入不得触碰 Claude Code 文件的 mtime');
      assert.deepEqual((await fs.readdir(h.homeDir)).sort(), homeBefore, 'homeDir 下不得新增任何文件');
      await assert.rejects(async () => await fs.stat(join(h.homeDir, '.codex')));
    } finally {
      await h.cleanup();
    }
  });
});

describe('module: onChange 接线', () => {
  it('route 写入后 source.onChange 收到 next/prev', async () => {
    const h = await harness();
    try {
      const events: { next: string[]; prev: string[] }[] = [];
      const off = h.module.source.onChange((next, prev) => {
        events.push({ next: next.servers.map((s) => s.serverName), prev: prev.servers.map((s) => s.serverName) });
      });
      await h.call('POST mcp/servers/upsert', { server: stdioServer });
      await h.call('POST mcp/servers/toggle', { name: 'demo', disabled: true });
      assert.deepEqual(events[0], { next: ['demo'], prev: [] });
      assert.deepEqual(events[1], { next: ['demo'], prev: ['demo'] });
      assert.equal(h.module.source.get().servers[0].disabled, true);
      off();
    } finally {
      await h.cleanup();
    }
  });
});
