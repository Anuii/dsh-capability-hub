/**
 * FIX-9：\`GET mcp/runtime\` 的 \`servers[].cache.tools\`。
 *
 * 界面规范（docs/UI-DESIGN.md §5）要求 MCP 详情抽屉的「工具」一节列出**缓存的工具名**，
 * 客户端按可选字段 \`cache.tools[].name\` 已经实现好展示（src/mcp/client/model.ts 的 cachedToolNames），
 * 缺的只是宿主数据。清单必须与 search 看到的是**同一份**：同一套 includeTools / excludeTools 读侧过滤。
 *
 * 覆盖：过滤（include / exclude / 两者叠加 / 限定名）、按名称排序、description 只取第一行并截断、
 * 无缓存时没有 tools 字段、以及「这仍然是只读缓存路径，不起任何进程」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipToolDescription } from '../../../src/mcp/runtime/runtime.ts';
import { MetadataCache, computeConfigHash } from '../../../src/mcp/runtime/atoms/metadata-cache.ts';
import { createMcpRuntimeModule } from '../../../src/mcp/runtime/module.ts';
import { CACHE_TOOL_DESCRIPTION_MAX_CHARS } from '../../../src/mcp/runtime/constants.ts';
import { FakeConfigSource, makeContext, makeHarness, makeServer, makeTempHome } from './helpers.ts';
import { FakeMcpRegistry, createFakeSdk } from './fakes/fake-sdk.ts';
import { FakeClock } from './fakes/fake-clock.ts';
import type { CacheEntry, CachedTool } from '../../../src/mcp/runtime/atoms/metadata-cache.ts';
import type { EffectiveServer, RuntimeStatus } from '../../../src/mcp/runtime/contract.ts';
import type { RouteRequest } from '../../../src/platform/contract/host.ts';

const ALPHA = makeServer({ serverName: 'alpha', command: 'node', args: ['srv.js'] });

/** 一个缓存条目里的工具（inputSchema 是刻意留着的：运行态**绝不能**把它带出去）。 */
function tool(name: string, description = ''): CachedTool {
  return { name, description, inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };
}

/** 直接落一份 cache.json（不通过连接）—— 与 actions-readonly.test.ts 的 seed 同一手法。 */
async function seedCache(hubHome: string, now: number, servers: EffectiveServer[], tools: Record<string, CachedTool[]>): Promise<void> {
  const cache = new MetadataCache(hubHome, new FakeClock(now));
  const entries: Record<string, CacheEntry> = {};
  for (const server of servers) {
    entries[server.serverName] = { configHash: computeConfigHash(server), updatedAt: now, tools: tools[server.serverName] ?? [] };
  }
  await cache.write(entries);
}

function serverWith(overrides: Partial<EffectiveServer>): EffectiveServer {
  return makeServer({ serverName: 'alpha', command: 'node', args: ['srv.js'], ...overrides });
}

/** 起一个只读的运行态（autoStart:false ⇒ 没有启动探测，缓存内容完全由测试决定）。 */
async function statusHarness(overrides: Partial<EffectiveServer> = {}) {
  const server = serverWith(overrides);
  const h = await makeHarness({ servers: [server], autoStart: false });
  await seedCache(h.home.hubHome, h.clock.now(), [server], {
    alpha: [tool('read_file', '读一个文件。'), tool('ping', 'Ping alpha.'), tool('list', '列出全部。')],
  });
  return { h, server };
}

function req(body: unknown): RouteRequest {
  return { query: {}, body, signal: new AbortController().signal };
}

test('GET mcp/runtime：cache.tools 给出工具名清单（按名称排序、无 inputSchema、toolCount 与 length 恒等）', async () => {
  const home = await makeTempHome('cache-tools-route');
  const module = createMcpRuntimeModule(makeContext(home.hubHome, home.dir), {
    config: new FakeConfigSource([ALPHA]),
    sdk: createFakeSdk(new FakeMcpRegistry()),
  });
  try {
    await seedCache(home.hubHome, Date.now(), [ALPHA], {
      alpha: [tool('read_file', '读一个文件。'), tool('ping', 'Ping alpha.'), tool('list', '列出全部。')],
    });
    const status = (await module.routes['GET mcp/runtime']!(req(undefined))) as RuntimeStatus;
    const cache = status.servers[0]!.cache;
    assert.ok(cache !== undefined, '有缓存时必须有 cache 字段');
    // 落盘顺序是 read_file / ping / list，返回必须是按名称排序的。
    assert.deepEqual(cache.tools.map((item) => item.name), ['list', 'ping', 'read_file']);
    assert.equal(cache.toolCount, cache.tools.length, 'toolCount 必须与 tools.length 一致');
    assert.equal(cache.toolCount, 3);
    // 只有 UI 需要的两个字段，绝不带 inputSchema（那是 describe 的职责，不该进每 5 秒一次的轮询）。
    assert.deepEqual(Object.keys(cache.tools[0]!).sort(), ['description', 'name']);
    assert.ok(!JSON.stringify(cache).includes('inputSchema'), '运行态里不能出现 inputSchema');
    assert.ok(!JSON.stringify(cache).includes('properties'), '运行态里不能出现 schema 片段');
  } finally {
    await module.dispose?.();
    await home.cleanup();
  }
});

test('includeTools 生效：只列命中的工具，且配置改了清单立刻跟着变（读侧过滤，不写缓存）', async () => {
  const { h } = await statusHarness({ includeTools: ['ping*'] });
  try {
    let cache = (await h.runtime.status()).servers[0]!.cache!;
    assert.deepEqual(cache.tools.map((item) => item.name), ['ping'], 'includeTools 之外的工具不得出现在运行态清单里');
    assert.equal(cache.toolCount, 1, 'toolCount 是过滤后的可见数（FIX-9 口径变化），不是缓存里的总数');

    // 换回不带过滤的配置：过滤只发生在读侧，缓存里的 3 个工具必须原样回来。
    h.config.setServers([serverWith({})]);
    cache = (await h.runtime.status()).servers[0]!.cache!;
    assert.deepEqual(cache.tools.map((item) => item.name), ['list', 'ping', 'read_file'], '拿掉 include 后过滤不能留痕');
  } finally {
    await h.dispose();
  }
});

test('excludeTools 生效：exclude 后赢，且认限定名', async () => {
  const { h } = await statusHarness({ includeTools: ['ping*', 'list*'], excludeTools: ['ping', 'alpha__list'] });
  try {
    const cache = (await h.runtime.status()).servers[0]!.cache!;
    // include 先查（ping / ping... / list...），exclude 后赢：ping 被原名排除、list 被限定名排除。
    assert.deepEqual(cache.tools.map((item) => item.name), []);
    assert.equal(cache.toolCount, 0);
  } finally {
    await h.dispose();
  }
});

test('excludeTools 只排除命中的那些（其余照常列出）', async () => {
  const { h } = await statusHarness({ excludeTools: ['read*'] });
  try {
    const cache = (await h.runtime.status()).servers[0]!.cache!;
    assert.deepEqual(cache.tools.map((item) => item.name), ['list', 'ping']);
    assert.equal(cache.toolCount, 2);
  } finally {
    await h.dispose();
  }
});

test('description 只取第一行并截断到 160 个字符；空描述不写这个键', async () => {
  const server = serverWith({});
  const h = await makeHarness({ servers: [server], autoStart: false });
  try {
    await seedCache(h.home.hubHome, h.clock.now(), [server], {
      alpha: [
        tool('multi', '第一行摘要\n\n第二行：详细用法与示例。'),
        tool('long', 'x'.repeat(300)),
        tool('crlf', 'CRLF 第一行\r\n第二行'),
        tool('blank', '   '),
      ],
    });
    const cache = (await h.runtime.status()).servers[0]!.cache!;
    const byName = new Map(cache.tools.map((item) => [item.name, item]));
    assert.equal(byName.get('multi')!.description, '第一行摘要');
    assert.equal(byName.get('crlf')!.description, 'CRLF 第一行');
    const long = byName.get('long')!.description!;
    assert.equal(long.length, CACHE_TOOL_DESCRIPTION_MAX_CHARS, '截断到正好 160 个字符');
    assert.equal(long, 'x'.repeat(CACHE_TOOL_DESCRIPTION_MAX_CHARS), '截断不追加省略号（上限就是上限）');
    assert.equal('description' in byName.get('blank')!, false, '空描述用「不写这个键」表示');
  } finally {
    await h.dispose();
  }
});

test('clipToolDescription 的边界：恰好 160 不动、161 变 160、代理对不切半、只取第一行', () => {
  assert.equal(clipToolDescription('x'.repeat(160)).length, 160, '恰好到上限不动');
  assert.equal(clipToolDescription('x'.repeat(161)), 'x'.repeat(160));
  assert.equal(clipToolDescription('  前后空白  '), '前后空白');
  assert.equal(clipToolDescription('a\nb'), 'a');
  assert.equal(clipToolDescription('a\r\nb'), 'a');
  assert.equal(clipToolDescription('a\rb'), 'a');
  assert.equal(clipToolDescription(''), '');
  // 159 个 ASCII + 一个需要用两个码元的 emoji：按 UTF-16 切会正好切在代理对中间，必须整字丢掉。
  const withEmoji = 'a'.repeat(159) + '\u{1F600}';
  const clipped = clipToolDescription(withEmoji);
  assert.equal(clipped, 'a'.repeat(159), '不能吐半个代理对给前端');
  assert.equal(clipped.length, 159);
  assert.ok(!/[\uD800-\uDFFF]/.test(clipped), '结果里不能有落单的代理码元');
  assert.equal(clipToolDescription('a'.repeat(158) + '\u{1F600}').length, 160, '刚好放得下就保留');
});

test('没有缓存时：servers[].cache 整块缺席（自然也没有 tools 字段），不报错', async () => {
  const h = await makeHarness({ servers: [ALPHA], autoStart: false });
  try {
    const status = await h.runtime.status();
    const view = status.servers[0]!;
    assert.equal(view.name, 'alpha');
    assert.equal(view.cache, undefined);
    assert.equal('cache' in view, false, '没有缓存就不该有 cache 字段');
    assert.equal('tools' in view, false);
  } finally {
    await h.dispose();
  }
});

test('有缓存但被过滤光了：tools 是空数组、toolCount 为 0（字段仍在，UI 才知道「有缓存但没可见工具」）', async () => {
  const { h } = await statusHarness({ includeTools: ['nope-*'] });
  try {
    const cache = (await h.runtime.status()).servers[0]!.cache;
    assert.ok(cache !== undefined, '有缓存就仍然要有 cache 字段');
    assert.deepEqual(cache.tools, []);
    assert.equal(cache.toolCount, 0);
  } finally {
    await h.dispose();
  }
});

test('停用的服务器照样给工具名（运行态本来就返回它的 cache），过滤规则一视同仁', async () => {
  // 语义定在这里：运行态是「缓存面板」，停用只影响 search/自动探测，不影响「这台服务器缓存了什么」。
  // UI 的开关自己会显示停用状态，把工具名藏起来反而让人看不懂「明明缓存过 4 个工具」。
  const { h } = await statusHarness({ disabled: true, excludeTools: ['read*'] });
  try {
    const cache = (await h.runtime.status()).servers[0]!.cache!;
    assert.deepEqual(cache.tools.map((item) => item.name), ['list', 'ping'], '停用不影响清单，但 include/exclude 照旧生效');
    assert.equal(cache.toolCount, 2);
  } finally {
    await h.dispose();
  }
});

test('status 仍是只读缓存路径：不起进程、不连接（D-D2）', async () => {
  const { h } = await statusHarness({});
  try {
    const spawnsBefore = h.registry.spawned.length;
    const connectsBefore = h.registry.connectCalls;
    const cache = (await h.runtime.status()).servers[0]!.cache!;
    assert.equal(cache.toolCount, 3);
    assert.equal(h.registry.spawned.length, spawnsBefore, 'status 不得产生任何进程');
    assert.equal(h.registry.connectCalls, connectsBefore, 'status 不得建立任何连接');
  } finally {
    await h.dispose();
  }
});
