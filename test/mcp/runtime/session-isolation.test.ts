/** 会话隔离（D-D3）：两个会话各自实例、子代理独立、sessionEnded 只关自己的。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callCtx, makeHarness, makeServer } from './helpers.ts';

function behavior(tools: Array<{ name: string }> = [{ name: 'ping' }]) {
  return { key: 'node srv.js', tools };
}

test('两个会话各自一套实例，互不影响', async () => {
  const h = await makeHarness({ servers: [makeServer({ serverName: 'a', command: 'node', args: ['srv.js'] })], behaviors: [behavior()] });
  try {
    await h.runtime.execute({ connect: 'a' }, callCtx('main'));
    await h.runtime.execute({ connect: 'a' }, callCtx('other'));
    const status = await h.runtime.status();
    const bySession = new Map(status.sessions.map((session) => [session.sessionId, session.instances.length]));
    assert.equal(bySession.get('main'), 1, '主会话 1 个实例（探测用的伪会话已关闭）');
    assert.equal(bySession.get('other'), 1);
    assert.equal(h.registry.spawned.length >= 2, true, '两个会话应当是两条独立进程');
    const pids = h.registry.spawned.map((proc) => proc.pid);
    assert.equal(new Set(pids).size, pids.length);
  } finally {
    await h.dispose();
  }
});

test('子代理会话（有 parentSessionId）与主会话完全独立', async () => {
  const h = await makeHarness({ servers: [makeServer({ serverName: 'a', command: 'node', args: ['srv.js'] })], behaviors: [behavior()] });
  try {
    await h.runtime.execute({ tool: 'ping', args: {} }, callCtx('main'));
    await h.runtime.execute({ tool: 'ping', args: {} }, callCtx('sub', { parentSessionId: 'main' }));
    const mainInstances = h.registry.spawned.filter((proc) => proc.alive);
    assert.equal(mainInstances.length, 2, '主会话与子代理各持一条连接');
    const status = await h.runtime.status();
    const sub = status.sessions.find((session) => session.sessionId === 'sub');
    assert.ok(sub);
    assert.equal(sub.parentSessionId, 'main');
  } finally {
    await h.dispose();
  }
});

test('sessionEnded 只关自己的会话，别的会话不受影响', async () => {
  const h = await makeHarness({ servers: [makeServer({ serverName: 'a', command: 'node', args: ['srv.js'] })], behaviors: [behavior()] });
  try {
    await h.runtime.execute({ tool: 'ping', args: {} }, callCtx('main'));
    await h.runtime.execute({ tool: 'ping', args: {} }, callCtx('sub', { parentSessionId: 'main' }));
    const before = await h.runtime.status();
    assert.equal(before.sessions.length, 2);

    await h.runtime.sessionEnded('sub');
    const after = await h.runtime.status();
    assert.deepEqual(after.sessions.map((session) => session.sessionId), ['main']);
    assert.equal(h.registry.liveProcessCount(), 1, '子代理的进程必须已经终止');
  } finally {
    await h.dispose();
  }
});

test('dispose 关闭全部会话的全部实例', async () => {
  const h = await makeHarness({ servers: [makeServer({ serverName: 'a', command: 'node', args: ['srv.js'] })], behaviors: [behavior()] });
  await h.runtime.execute({ tool: 'ping', args: {} }, callCtx('main'));
  await h.runtime.execute({ tool: 'ping', args: {} }, callCtx('sub', { parentSessionId: 'main' }));
  await h.runtime.dispose();
  assert.equal(h.registry.liveProcessCount(), 0);
  assert.equal((await h.runtime.status()).sessions.length, 0);
  await h.home.cleanup();
});

test('同一会话不同服务器各持一条连接', async () => {
  const h = await makeHarness({
    servers: [
      makeServer({ serverName: 'a', command: 'node', args: ['srv.js'] }),
      makeServer({ serverName: 'b', command: 'node', args: ['srv.js'] }),
    ],
    behaviors: [behavior()],
  });
  try {
    // 两台服务器有同名工具，必须显式指定 server，否则会（正确地）返回歧义提示。
    await h.runtime.execute({ tool: 'ping', args: {}, server: 'a' }, callCtx('main'));
    await h.runtime.execute({ tool: 'ping', args: {}, server: 'b' }, callCtx('main'));
    const sessions = (await h.runtime.status()).sessions;
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].instances.length, 2);
    assert.deepEqual(sessions[0].instances.map((item) => item.server).sort(), ['a', 'b']);
  } finally {
    await h.dispose();
  }
});

test('会话结束会清掉该会话的会话元数据', async () => {
  const h = await makeHarness({ servers: [makeServer({ serverName: 'a', command: 'node', args: ['srv.js'] })], behaviors: [behavior()] });
  try {
    h.runtime.sessionStarted({ sessionId: 'main', title: '测试会话' });
    await h.runtime.execute({ tool: 'ping', args: {} }, callCtx('main'));
    await h.runtime.sessionEnded('main');
    await h.runtime.execute({ tool: 'ping', args: {} }, callCtx('other'));
    const status = await h.runtime.status();
    assert.equal(status.sessions[0].sessionId, 'other');
    assert.equal(status.sessions[0].title, undefined, '旧标题不该串到新会话');
  } finally {
    await h.dispose();
  }
});
