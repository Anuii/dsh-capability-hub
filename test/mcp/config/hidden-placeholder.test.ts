/**
 * FIX-3：遮罩占位符 "***hidden***" 不是真实值。
 *
 * T4b-1 发现：POST mcp/servers/upsert 只在带 originalName（编辑已有服务器）时才把占位符合并回
 * 原值；**新建服务器**时提交这个占位符会被当成真实值保存（env / headers 的值字面就是 ***hidden***）。
 *
 * FIX-3 的规则（与 FIX-2 无关，独立的一部分）：
 *   - 新建服务器（没有 originalName，或 originalName 指向的服务器不存在）→ VALIDATION(422)，
 *     details 的 path 指向具体键（server.env.API_KEY）。
 *   - 编辑已有服务器：键名存在于原配置 → 行为不变（保留原值）；原配置里没有的新键 → 同样拒绝。
 *   - mcp/validate 给出同样的错误（它按设计返回 errors 数组，不抛错）。
 *   - import/apply 走服务端原值，不受影响。
 *
 * 全部落盘都在 os.tmpdir() 的临时目录（PLAN §4）。
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createMcpConfigModule } from '../../../src/mcp/config/module.ts';
import { HIDDEN, findHiddenPlaceholders } from '../../../src/mcp/config/mask.ts';
import { callRoute, expectRejection, makeContext, makeTempDir, readJson, recordingLogger, type RecordingLogger } from './helpers.ts';

const SECRET_ENV = 'sk-live-SECRET-ENV-0001';
const SECRET_HEADER = 'Bearer SECRET-HEADER-0002';
/** 契约要求的中文说明（逐字，故在测试里独立写一遍） */
const MESSAGE = '这是遮罩占位符，不是真实值。新建服务器时请填写实际的值。';

interface Harness {
  hubHome: string;
  homeDir: string;
  module: ReturnType<typeof createMcpConfigModule>;
  logger: RecordingLogger;
  call(key: string, body?: unknown): Promise<unknown>;
  configPath(): string;
  cleanup(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const hubTemp = await makeTempDir('mcp-config-hub-');
  const homeTemp = await makeTempDir('mcp-config-home-');
  const logger = recordingLogger();
  const ctx = makeContext(hubTemp.path, homeTemp.path, logger);
  const module = createMcpConfigModule(ctx, { store: { pollIntervalMs: 0 } });
  await module.ready();
  return {
    hubHome: hubTemp.path,
    homeDir: homeTemp.path,
    module,
    logger,
    call: (key, body) => callRoute(module.routes, key, body),
    configPath: () => join(hubTemp.path, 'mcp', 'config.json'),
    async cleanup() {
      module.dispose();
      await hubTemp.cleanup();
      await homeTemp.cleanup();
    },
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('FIX-3 upsert：新建服务器提交占位符被拒（H1）', () => {
  it('env 里提交 "***hidden***" → 422 VALIDATION，path 指向具体键，且不落盘', async () => {
    const h = await harness();
    try {
      const error = await expectRejection(() =>
        h.call('POST mcp/servers/upsert', {
          server: { serverName: 'newbie', transport: 'stdio', command: 'node', env: { API_KEY: HIDDEN } },
        }),
      );
      assert.equal(error.status, 422);
      assert.equal(error.code, 'VALIDATION');
      assert.equal(error.message, MESSAGE);
      const details = error.details as { path: string; message: string }[];
      assert.deepEqual(details.map((d) => d.path), ['server.env.API_KEY']);
      assert.equal(details[0]!.message, MESSAGE);

      // 绝不落盘：配置文件根本没被创建，视图里也没有这个服务器
      assert.equal(await fileExists(h.configPath()), false, '被拒绝的提交不得写 config.json');
      const config = (await h.call('GET mcp/config')) as { servers: unknown[] };
      assert.deepEqual(config.servers, []);
      assert.equal(h.logger.text().includes(HIDDEN), false, '日志里不得出现占位符');
    } finally {
      await h.cleanup();
    }
  });

  it('headers 里多个键提交占位符 → 逐键报错（env 与 headers 都查）', async () => {
    const h = await harness();
    try {
      const error = await expectRejection(() =>
        h.call('POST mcp/servers/upsert', {
          server: {
            serverName: 'newbie',
            transport: 'streamable-http',
            url: 'https://example.com/mcp',
            env: { A: HIDDEN },
            headers: { Authorization: HIDDEN, 'X-Trace': HIDDEN },
          },
        }),
      );
      assert.equal(error.status, 422);
      assert.deepEqual((error.details as { path: string }[]).map((d) => d.path), [
        'server.env.A',
        'server.headers.Authorization',
        'server.headers.X-Trace',
      ]);
      assert.equal(await fileExists(h.configPath()), false);
    } finally {
      await h.cleanup();
    }
  });

  it('originalName 指向不存在的服务器 + 占位符 → 422（而不是 404），因为同样没有原值可回填', async () => {
    const h = await harness();
    try {
      const error = await expectRejection(() =>
        h.call('POST mcp/servers/upsert', {
          originalName: 'nope',
          server: { serverName: 'x', transport: 'stdio', command: 'node', env: { K: HIDDEN } },
        }),
      );
      assert.equal(error.status, 422);
      assert.equal(error.code, 'VALIDATION');
      assert.deepEqual((error.details as { path: string }[]).map((d) => d.path), ['server.env.K']);
      // 没有占位符时，原服务器不存在仍然是 404（原有行为不变）
      const notFound = await expectRejection(() =>
        h.call('POST mcp/servers/upsert', { originalName: 'nope', server: { serverName: 'x', transport: 'stdio', command: 'node' } }),
      );
      assert.equal(notFound.status, 404);
    } finally {
      await h.cleanup();
    }
  });

  it('值只是「包含」占位符字样（不是完整的占位符）照常保存', async () => {
    const h = await harness();
    try {
      const value = HIDDEN + '-suffix';
      await h.call('POST mcp/servers/upsert', {
        server: { serverName: 'literal', transport: 'stdio', command: 'node', env: { K: value } },
      });
      const revealed = (await h.call('POST mcp/servers/reveal', { name: 'literal' })) as { server: { env: Record<string, string> } };
      assert.deepEqual(revealed.server.env, { K: value });
    } finally {
      await h.cleanup();
    }
  });
});

describe('FIX-3 validate：给出同样的错误（H1）', () => {
  it('新建提交占位符 → errors 里逐键返回同样的 path 与文案，且不落盘', async () => {
    const h = await harness();
    try {
      const data = (await h.call('POST mcp/validate', {
        server: { serverName: 'newbie', transport: 'stdio', command: 'node', env: { API_KEY: HIDDEN } },
      })) as { errors: { path: string; message: string }[]; server: { env: Record<string, string> } };
      assert.deepEqual(data.errors, [{ path: 'server.env.API_KEY', message: MESSAGE }]);
      // 回显照常遮罩（validate 不是 reveal）
      assert.deepEqual(data.server.env, { API_KEY: HIDDEN });
      assert.equal(await fileExists(h.configPath()), false, 'validate 从不落盘');
    } finally {
      await h.cleanup();
    }
  });

  it('合法值不误伤：errors 为空', async () => {
    const h = await harness();
    try {
      const data = (await h.call('POST mcp/validate', {
        server: { serverName: 'ok', transport: 'stdio', command: 'node', env: { API_KEY: SECRET_ENV }, headers: { Authorization: SECRET_HEADER } },
      })) as { errors: unknown[] };
      assert.deepEqual(data.errors, []);
    } finally {
      await h.cleanup();
    }
  });

  it('编辑：原有键的占位符不报错，新键的占位符报错（H2）', async () => {
    const h = await harness();
    try {
      await h.call('POST mcp/servers/upsert', { server: { serverName: 'demo', transport: 'stdio', command: 'node', env: { TOKEN: SECRET_ENV } } });
      const ok = (await h.call('POST mcp/validate', {
        originalName: 'demo',
        server: { serverName: 'demo', transport: 'stdio', command: 'node', env: { TOKEN: HIDDEN } },
      })) as { errors: unknown[] };
      assert.deepEqual(ok.errors, [], '原有键的占位符是合法的（保留原值）');

      const bad = (await h.call('POST mcp/validate', {
        originalName: 'demo',
        server: { serverName: 'demo', transport: 'stdio', command: 'node', env: { TOKEN: HIDDEN, NEW: HIDDEN } },
      })) as { errors: { path: string }[] };
      assert.deepEqual(bad.errors.map((e) => e.path), ['server.env.NEW']);
    } finally {
      await h.cleanup();
    }
  });
});

describe('FIX-3 upsert 编辑：原有键保留原值，新键被拒（H2）', () => {
  it('原有键提交占位符照常保留原值（行为不变）', async () => {
    const h = await harness();
    try {
      await h.call('POST mcp/servers/upsert', {
        server: { serverName: 'demo', transport: 'stdio', command: 'node', env: { TOKEN: SECRET_ENV }, headers: { Authorization: SECRET_HEADER } },
      });
      await h.call('POST mcp/servers/upsert', {
        originalName: 'demo',
        server: { serverName: 'demo', transport: 'stdio', command: 'node', env: { TOKEN: HIDDEN }, headers: { Authorization: HIDDEN } },
      });
      const revealed = (await h.call('POST mcp/servers/reveal', { name: 'demo' })) as { server: { env: Record<string, string>; headers: Record<string, string> } };
      assert.deepEqual(revealed.server.env, { TOKEN: SECRET_ENV });
      assert.deepEqual(revealed.server.headers, { Authorization: SECRET_HEADER });
    } finally {
      await h.cleanup();
    }
  });

  it('新键提交占位符 → 422，原配置逐字节不变', async () => {
    const h = await harness();
    try {
      await h.call('POST mcp/servers/upsert', {
        server: { serverName: 'demo', transport: 'stdio', command: 'node', env: { TOKEN: SECRET_ENV } },
      });
      const before = await fs.readFile(h.configPath(), 'utf8');
      const error = await expectRejection(() =>
        h.call('POST mcp/servers/upsert', {
          originalName: 'demo',
          server: { serverName: 'demo', transport: 'stdio', command: 'node', env: { TOKEN: HIDDEN, NEW: HIDDEN } },
        }),
      );
      assert.equal(error.status, 422);
      assert.equal(error.message, MESSAGE);
      assert.deepEqual((error.details as { path: string }[]).map((d) => d.path), ['server.env.NEW']);
      assert.equal(await fs.readFile(h.configPath(), 'utf8'), before, '被拒绝的提交不得改动配置文件');
      const revealed = (await h.call('POST mcp/servers/reveal', { name: 'demo' })) as { server: { env: Record<string, string> } };
      assert.deepEqual(revealed.server.env, { TOKEN: SECRET_ENV });
    } finally {
      await h.cleanup();
    }
  });
});

describe('FIX-3 import/apply 不受影响（H3）', () => {
  it('导入写的是服务端原值（明文），不是占位符', async () => {
    const h = await harness();
    try {
      await fs.writeFile(
        join(h.homeDir, '.claude.json'),
        JSON.stringify({ mcpServers: { imported: { command: 'node', env: { TOKEN: SECRET_ENV }, headers: { Authorization: SECRET_HEADER } } } }),
        'utf8',
      );
      const data = (await h.call('POST mcp/import/apply', { sourceId: 'claude-code', names: ['imported'] })) as {
        imported: string[];
        skipped: { name: string; reason: string }[];
      };
      assert.deepEqual(data.imported, ['imported']);
      assert.deepEqual(data.skipped, []);
      const revealed = (await h.call('POST mcp/servers/reveal', { name: 'imported' })) as { server: { env: Record<string, string>; headers: Record<string, string> } };
      assert.deepEqual(revealed.server.env, { TOKEN: SECRET_ENV }, '导入必须落明文原值');
      assert.deepEqual(revealed.server.headers, { Authorization: SECRET_HEADER });
      const onDisk = JSON.stringify(await readJson(h.configPath()));
      assert.equal(onDisk.includes(SECRET_ENV), true, '落盘的就是真实值');
      assert.equal(onDisk.includes('***hidden***'), false, '落盘里不得出现占位符');
    } finally {
      await h.cleanup();
    }
  });

  it('导入后再用占位符编辑：原有键照常保留导入的原值', async () => {
    const h = await harness();
    try {
      await fs.writeFile(
        join(h.homeDir, '.claude.json'),
        JSON.stringify({ mcpServers: { imported: { command: 'node', env: { TOKEN: SECRET_ENV } } } }),
        'utf8',
      );
      await h.call('POST mcp/import/apply', { sourceId: 'claude-code', names: ['imported'] });
      await h.call('POST mcp/servers/upsert', {
        originalName: 'imported',
        server: { serverName: 'imported', transport: 'stdio', command: 'node', env: { TOKEN: HIDDEN } },
      });
      const revealed = (await h.call('POST mcp/servers/reveal', { name: 'imported' })) as { server: { env: Record<string, string> } };
      assert.deepEqual(revealed.server.env, { TOKEN: SECRET_ENV });
    } finally {
      await h.cleanup();
    }
  });
});

describe('FIX-3 findHiddenPlaceholders 单元', () => {
  it('原配置里有该键 → 不算问题；没有 → 逐键报出', () => {
    const existing = { env: { TOKEN: 'real' }, headers: {} } as never;
    assert.deepEqual(findHiddenPlaceholders({ env: { TOKEN: HIDDEN } }, existing), []);
    assert.deepEqual(findHiddenPlaceholders({ env: { TOKEN: HIDDEN, NEW: HIDDEN } }, existing).map((e) => e.path), ['server.env.NEW']);
    assert.deepEqual(findHiddenPlaceholders({ env: { A: HIDDEN } }, undefined).map((e) => e.path), ['server.env.A']);
    assert.deepEqual(findHiddenPlaceholders({ env: { A: 'x' } }, undefined), []);
    assert.deepEqual(findHiddenPlaceholders({ env: 'nope', headers: [1, 2] }, undefined), []);
    assert.deepEqual(findHiddenPlaceholders(undefined, undefined), []);
  });
});
