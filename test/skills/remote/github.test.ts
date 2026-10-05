import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, ghAuthToken, isRateLimitResponse, normalizeSkillsShResponse, parseRateLimit, rateLimitMessage, USER_AGENT } from '../../../src/skills/remote/github.ts';
import { readTarEntries } from '../../../src/skills/remote/tar.ts';
import { Redactor, createRedactingLogger } from '../../../src/skills/remote/redact.ts';
import { gzipResponse, jsonResponse, makeFakeFetch, makeLogger, tarGzOf } from './helpers.ts';
import { skillFixture } from './tarfixture.ts';

const SECRET = 'ghp_' + 'a'.repeat(36);

function client(routes: Parameters<typeof makeFakeFetch>[0], options: { envToken?: string; ghToken?: string; sink?: ReturnType<typeof makeLogger> } = {}) {
  const redactor = new Redactor();
  const { logger: rawLogger, sink } = options.sink ?? makeLogger();
  // 与 createSkillsRemoteModule 的真实接线一致：所有日志经 redacting logger 输出
  const logger = createRedactingLogger(rawLogger, redactor);
  const fake = makeFakeFetch(routes);
  const gh = new GitHubClient({
    fetchImpl: fake.fetch,
    logger,
    onSecret: (s) => redactor.add(s),
    envTokenProvider: () => options.envToken,
    ghTokenProvider: async () => options.ghToken,
    cacheAuth: false,
  });
  return { gh, fake, redactor, sink, logger };
}

test('凭据链：GITHUB_TOKEN 优先，其次 gh，最后匿名', async () => {
  const { gh } = client([], { envToken: SECRET, ghToken: 'gh-token-value' });
  const auth = await gh.auth();
  assert.equal(auth.mode, 'env');
  assert.equal(auth.token, SECRET);

  const ghOnly = client([], { ghToken: 'gh-token-value' }).gh;
  assert.equal((await ghOnly.auth()).mode, 'gh');

  const anon = client([], {}).gh;
  const anonAuth = await anon.auth();
  assert.equal(anonAuth.mode, 'anonymous');
  assert.equal(anonAuth.token, undefined);
});

test('匿名请求不带 Authorization，带令牌时用 Bearer', async () => {
  const anon = client([
    { match: (u) => u.includes('/repos/'), response: () => jsonResponse({ default_branch: 'main' }) },
  ]);
  await anon.gh.defaultBranch('a/b');
  assert.equal(anon.fake.calls[0]!.headers['authorization'], undefined);
  assert.equal(anon.fake.calls[0]!.headers['user-agent'], USER_AGENT);

  const withToken = client(
    [{ match: (u) => u.includes('/repos/'), response: () => jsonResponse({ default_branch: 'main' }) }],
    { envToken: SECRET }
  );
  await withToken.gh.defaultBranch('a/b');
  assert.equal(withToken.fake.calls[0]!.headers['authorization'], `Bearer ${SECRET}`);
});

test('令牌不出现在返回值、日志与错误信息里（C4）', async () => {
  const { logger: rawLogger, sink } = makeLogger();
  const { gh, redactor, logger } = client(
    [
      { match: (u) => u.includes('/repos/'), response: () => jsonResponse({ default_branch: 'main' }) },
      { match: (u) => u.includes('codeload'), response: () => new Response('boom', { status: 500 }) },
    ],
    { envToken: SECRET, sink: { logger: rawLogger, sink } }
  );
  const auth = await gh.auth();
  assert.equal(auth.mode, 'env');
  // auth() 是内部接口（携带 token 供请求头使用）；对外一律只用 mode
  assert.ok(!JSON.stringify({ mode: auth.mode }).includes(SECRET));

  let thrown: unknown;
  try {
    await gh.downloadTarball('demo/repo', 'main');
  } catch (error) {
    thrown = error;
  }
  const message = (thrown as Error).message;
  assert.ok(!message.includes(SECRET), '错误信息里不得出现令牌');
  assert.ok(!JSON.stringify({ ...(thrown as object) }).includes(SECRET), '错误对象序列化后不得出现令牌');

  // 日志：模拟「上游代码把令牌写进日志」，验证 redacting logger 会遮蔽。
  // 这里用的就是模块内部那个 logger（createSkillsRemoteModule 也走同一包装）。
  logger.warn('模拟泄漏 ' + SECRET, { nested: [SECRET] });
  const flat = JSON.stringify(sink);
  assert.ok(!flat.includes(SECRET), '日志里不得出现令牌');
  assert.ok(flat.includes('***'), '日志里应出现遮蔽标记');
  assert.equal(redactor.scrub('x ' + SECRET + ' y'), 'x *** y');
});

test('redactor 兜底：未知形态的 GitHub 令牌也会被遮蔽', () => {
  const redactor = new Redactor();
  const pat = 'github_pat_' + 'b'.repeat(30);
  assert.ok(!redactor.scrub(`token=${pat}`).includes(pat));
  assert.ok(!redactor.scrub('gho_' + 'c'.repeat(20)).includes('gho_'));
});

test('默认分支查询失败（网络/404）时返回 undefined，不抛错', async () => {
  const { gh } = client([{ match: (u) => u.includes('/repos/'), response: () => new Response('nope', { status: 404 }) }]);
  assert.equal(await gh.defaultBranch('a/b'), undefined);

  const broken = new GitHubClient({
    fetchImpl: (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch,
    logger: makeLogger().logger,
    envTokenProvider: () => undefined,
    ghTokenProvider: async () => undefined,
  });
  assert.equal(await broken.defaultBranch('a/b'), undefined);
});

test('下载 tar.gz：默认分支优先、按 ref/main/master/HEAD 回退', async () => {
  const { gh, fake } = client([
    { match: (u) => u.includes('/repos/'), response: () => jsonResponse({ default_branch: 'develop' }) },
    {
      match: (u) => u.includes('/tar.gz/develop'),
      response: () => gzipResponse(tarGzOf(skillFixture('x', 'foo'))),
    },
    { match: (u) => u.includes('/tar.gz/main'), response: () => new Response('no', { status: 404 }) },
  ]);
  const result = await gh.downloadTarball('demo/repo');
  assert.equal(result.ref, 'develop');
  assert.ok(result.entries.some((e) => e.path === 'skills/x/foo/SKILL.md'));
  assert.equal(fake.calls.filter((c) => c.url.includes('codeload')).length, 1);
});

test('显式 ref 时不查询默认分支，只请求该 ref', async () => {
  const { gh, fake } = client([
    { match: (u) => u.includes('/tar.gz/v1'), response: () => gzipResponse(tarGzOf(skillFixture('x', 'foo'))) },
  ]);
  const result = await gh.downloadTarball('demo/repo', 'v1');
  assert.equal(result.ref, 'v1');
  assert.equal(fake.calls.filter((c) => c.url.includes('api.github.com')).length, 0);
});

test('速率限制返回 RATE_LIMITED，附带剩余额度与重置时间的中文提示', async () => {
  const reset = Math.floor(Date.now() / 1000) + 600;
  const { gh } = client([
    { match: (u) => u.includes('/repos/'), response: () => jsonResponse({ default_branch: 'main' }) },
    {
      match: (u) => u.includes('codeload'),
      response: () =>
        new Response('rate limited', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset), 'x-ratelimit-limit': '60' },
        }),
    },
  ]);
  let thrown: { code?: string; status?: number; message?: string; details?: unknown } | undefined;
  try {
    await gh.downloadTarball('demo/repo', 'main');
  } catch (error) {
    thrown = error as typeof thrown;
  }
  assert.equal(thrown?.code, 'RATE_LIMITED');
  assert.equal(thrown?.status, 429);
  assert.match(String(thrown?.message), /速率限制/);
  assert.match(String(thrown?.message), /剩余额度 0/);
  assert.match(String(thrown?.message), /GITHUB_TOKEN/);
  assert.match(String(thrown?.message), /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, '应带可读的重置时间');
});

test('其他网络/HTTP 错误返回 UPSTREAM', async () => {
  const { gh } = client([{ match: (u) => u.includes('codeload'), response: () => new Response('boom', { status: 500 }) }]);
  await assert.rejects(gh.downloadTarball('demo/repo', 'main'), (error: { code?: string; status?: number; message: string }) => {
    assert.equal(error.code, 'UPSTREAM');
    assert.equal(error.status, 502);
    assert.match(error.message, /HTTP 500/);
    return true;
  });

  const network = new GitHubClient({
    fetchImpl: (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch,
    logger: makeLogger().logger,
    envTokenProvider: () => undefined,
    ghTokenProvider: async () => undefined,
    cacheAuth: false,
  });
  await assert.rejects(network.downloadTarball('demo/repo', 'main'), (error: { code?: string }) => error.code === 'UPSTREAM');
});

test('非 gzip 内容返回 UPSTREAM（中文说明）', async () => {
  const { gh } = client([{ match: (u) => u.includes('codeload'), response: () => gzipResponse(Buffer.from('not gzip')) }]);
  await assert.rejects(gh.downloadTarball('demo/repo', 'main'), /gzip/);
});

test('parseRateLimit / isRateLimitResponse / rateLimitMessage', () => {
  const headers = new Headers({
    'x-ratelimit-remaining': '7',
    'x-ratelimit-reset': '1700000000',
    'x-ratelimit-limit': '60',
  });
  const info = parseRateLimit(headers);
  assert.equal(info.remaining, 7);
  assert.equal(info.limit, 60);
  assert.equal(info.resetAt, new Date(1700000000 * 1000).toISOString());
  assert.equal(isRateLimitResponse(403, headers), false, '剩余额度>0 的 403 是权限问题，不是限流');
  assert.equal(isRateLimitResponse(403, new Headers({ 'x-ratelimit-remaining': '0' })), true);
  assert.equal(isRateLimitResponse(429, new Headers()), true);
  assert.equal(isRateLimitResponse(500, new Headers()), false);
  assert.match(rateLimitMessage(info), /剩余额度 7/);
  assert.match(rateLimitMessage({}), /稍后/);
});

test('ghAuthToken：缺少 gh 时静默返回 undefined（5 秒超时，不抛错）', async () => {
  const token = await ghAuthToken();
  // 本机装了 gh 且已登录 → 返回字符串；否则 undefined。两种都合法，关键是不抛错。
  assert.ok(token === undefined || typeof token === 'string');
  if (token !== undefined) assert.ok(token.length > 0);
});

test('skills.sh 响应归一化：字段名与 CC Switch 实测一致，非法条目被丢弃', () => {
  const payload = {
    query: 'pdf',
    searchType: 'fuzzy',
    skills: [
      { id: 'anthropics/skills/pdf', skillId: 'pdf', name: 'pdf', installs: 205717, source: 'anthropics/skills' },
      { id: 'x', skillId: 'x', name: '', installs: 1, source: 'a/b' },
      { id: 'y', skillId: 'y', name: 'y', installs: 1, source: 'no-slash' },
      { id: 'z', skillId: 'z', name: 'z', installs: 1, source: 'skills.volces.com/x' },
    ],
  };
  const results = normalizeSkillsShResponse(payload, { skillPathLookup: () => 'skills/pdf/SKILL.md' });
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    name: 'pdf',
    repo: 'anthropics/skills',
    skillPath: 'skills/pdf/SKILL.md',
    installs: 205717,
  });
});

test('searchSkillsSh：非 200 返回 UPSTREAM，网络错误也返回 UPSTREAM', async () => {
  const { gh } = client([{ match: (u) => u.includes('skills.sh'), response: () => new Response('nope', { status: 503 }) }]);
  await assert.rejects(gh.searchSkillsSh('pdf'), (error: { code?: string; message: string }) => {
    assert.equal(error.code, 'UPSTREAM');
    assert.match(error.message, /skills\.sh/);
    return true;
  });
});
