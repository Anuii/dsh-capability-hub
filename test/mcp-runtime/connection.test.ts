/** 连接池：会话隔离、并发合流、inFlight 保护、进程树终止、关闭幂等。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionPool } from '../../src/host/mcp-runtime/atoms/connection.ts';
import { FakeClock, sleep } from './fakes/fake-clock.ts';
import { FakeMcpRegistry, createFakeSdk, createFakeSupervisor } from './fakes/fake-sdk.ts';
import { makeServer } from './helpers.ts';

function setup() {
  const registry = new FakeMcpRegistry();
  registry.register({ key: 'node srv.js', tools: [{ name: 'ping' }], stderrText: 'first line\nlast line' });
  registry.register({ key: 'node slow.js', tools: [{ name: 'ping' }], connectDelayMs: 30 });
  registry.register({ key: 'node dead.js', connectFailure: 'spawn 失败' });
  const clock = new FakeClock();
  const supervisor = createFakeSupervisor(registry);
  const sdk = createFakeSdk(registry);
  const pool = new ConnectionPool({ clock, supervisor, sdk });
  return { registry, clock, supervisor, pool };
}

test('实例键 = 会话 id + 服务器名；两个会话各持一套', () => {
  const { pool } = setup();
  const server = makeServer({ serverName: 'a', command: 'node', args: ['srv.js'] });
  const one = pool.acquire({ sessionId: 's1' }, server);
  const two = pool.acquire({ sessionId: 's2' }, server);
  const again = pool.acquire({ sessionId: 's1' }, server);
  assert.notEqual(one, two);
  assert.equal(one, again, '同一会话同一服务器复用同一个实例');
  assert.equal(pool.list({ sessionId: 's1' }).length, 1);
  assert.equal(pool.list({ sessionId: 's2' }).length, 1);
});

test('并发首次调用只建一个连接（共享同一个 promise）', async () => {
  const { pool, registry } = setup();
  const server = makeServer({ serverName: 'slow', command: 'node', args: ['slow.js'] });
  const instance = pool.acquire({ sessionId: 's1' }, server);
  await Promise.all([instance.ensureConnected(), instance.ensureConnected(), instance.ensureConnected()]);
  assert.equal(registry.connectCalls, 1, '三次并发只应连一次');
  assert.equal(registry.liveProcessCount(), 1);
});

test('连接失败进入 failed，再调用会重建', async () => {
  const { pool, registry } = setup();
  const server = makeServer({ serverName: 'dead', command: 'node', args: ['dead.js'] });
  const instance = pool.acquire({ sessionId: 's1' }, server);
  await assert.rejects(() => instance.ensureConnected(), /spawn 失败/);
  assert.equal(instance.state, 'failed');
  const replacement = pool.acquire({ sessionId: 's1' }, server);
  assert.notEqual(replacement, instance, '失败实例不应被复用');
  assert.equal(registry.connectCalls, 1);
});

test('失败连接的诊断带上 stderr 尾部', async () => {
  const registry = new FakeMcpRegistry();
  registry.register({ key: 'node bad.js', connectFailure: 'boom', stderrText: 'warning one\nwarning two\nwarning three' });
  const clock = new FakeClock();
  const pool = new ConnectionPool({ clock, supervisor: createFakeSupervisor(registry), sdk: createFakeSdk(registry) });
  const server = makeServer({ serverName: 'bad', command: 'node', args: ['bad.js'] });
  const instance = pool.acquire({ sessionId: 's1' }, server);
  await assert.rejects(() => instance.ensureConnected(), (err: Error) => {
    assert.match(err.message, /boom/);
    assert.match(err.message, /stderr: warning one — warning two — warning three/);
    return true;
  });
});

test('callTool 期间 inFlight > 0，空闲判定跳过（绝不回收正在调用的连接）', async () => {
  const { pool, clock } = setup();
  const server = makeServer({ serverName: 'a', command: 'node', args: ['srv.js'] });
  const instance = pool.acquire({ sessionId: 's1' }, server);
  await instance.ensureConnected();
  const call = instance.callTool('ping', {});
  assert.equal(instance.inFlight, 1);
  assert.equal(instance.isIdle(clock.now() + 10 * 60_000, 60_000), false, 'inFlight>0 时绝不回收');
  await call;
  assert.equal(instance.inFlight, 0);
});

test('空闲判定：窗口为 0 永不回收；未超窗不回收', async () => {
  const { pool, clock } = setup();
  const server = makeServer({ serverName: 'a', command: 'node', args: ['srv.js'] });
  const instance = pool.acquire({ sessionId: 's1' }, server);
  await instance.ensureConnected();
  assert.equal(instance.isIdle(clock.now() + 10 * 60_000, 60_000), true);
  assert.equal(instance.isIdle(clock.now() + 1000, 60_000), false);
  assert.equal(instance.isIdle(clock.now() + 10 * 60_000, 0), false);
});

test('sweep 回收空闲实例，且关掉整棵进程树', async () => {
  const { pool, registry, clock, supervisor } = setup();
  const server = makeServer({ serverName: 'a', command: 'node', args: ['srv.js'] });
  const instance = pool.acquire({ sessionId: 's1' }, server);
  await instance.ensureConnected();
  const pid = instance.pid as number;
  // 模拟 npx 场景：真正的 node 服务器是 cmd.exe/npx 的孙进程（进程表里必须能查到它，才谈得上回收）。
  const child = registry.startProcess(registry.behaviors.get('node srv.js')!, { command: 'node', args: ['srv.js'], env: {} });
  registry.processes.get(pid)!.children.push(child);

  const reaped = await pool.sweep(clock.now() + 11 * 60_000, () => 10 * 60_000);
  assert.equal(reaped, 1);
  assert.equal(pool.list().length, 0);
  assert.ok(supervisor.killedPids.includes(pid), '必须调用进程树终止');
  assert.equal(registry.processes.get(pid)!.alive, false);
  assert.equal(child.alive, false, '孙进程也必须被回收');
});

test('closeSession 只关自己会话的实例', async () => {
  const { pool, registry } = setup();
  const server = makeServer({ serverName: 'a', command: 'node', args: ['srv.js'] });
  const one = pool.acquire({ sessionId: 's1' }, server);
  const two = pool.acquire({ sessionId: 's2' }, server);
  const three = pool.acquire({ sessionId: 's1' }, { ...server, serverName: 'b' });
  await Promise.all([one.ensureConnected(), two.ensureConnected(), three.ensureConnected()]);
  const closed = await pool.closeSession('s1');
  assert.equal(closed, 2);
  assert.equal(pool.list({ sessionId: 's1' }).length, 0);
  assert.equal(pool.list({ sessionId: 's2' }).length, 1);
  assert.equal(two.state, 'ready');
  assert.equal(registry.liveProcessCount(), 1);
});

test('closeServer(serverName) 关掉所有会话里的该服务器', async () => {
  const { pool } = setup();
  const server = makeServer({ serverName: 'a', command: 'node', args: ['srv.js'] });
  const one = pool.acquire({ sessionId: 's1' }, server);
  const two = pool.acquire({ sessionId: 's2' }, server);
  await Promise.all([one.ensureConnected(), two.ensureConnected()]);
  assert.equal(await pool.closeServer('a'), 2);
  assert.equal(pool.list().length, 0);
});

test('close 是幂等的，且关闭超时时仍会终止进程树', async () => {
  const registry = new FakeMcpRegistry();
  registry.register({ key: 'node hang.js', tools: [], hangOnClose: true });
  const clock = new FakeClock();
  const supervisor = createFakeSupervisor(registry);
  const pool = new ConnectionPool({ clock, supervisor, sdk: createFakeSdk(registry) });
  const server = makeServer({ serverName: 'hang', command: 'node', args: ['hang.js'] });
  const instance = pool.acquire({ sessionId: 's1' }, server);
  await instance.ensureConnected();
  const pid = instance.pid as number;

  const closing = instance.close();
  await clock.advance(6000); // 超过 CLOSE_TIMEOUT_MS
  await closing;
  assert.equal(instance.state, 'closed');
  assert.ok(supervisor.killedPids.includes(pid));
  await instance.close();
  assert.equal(supervisor.killedPids.filter((item) => item === pid).length, 1, 'pid 只应记录一次');
});

test('取消（abort）不算失败：连接会以 AbortError 结束', async () => {
  const { pool } = setup();
  const server = makeServer({ serverName: 'slow', command: 'node', args: ['slow.js'] });
  const instance = pool.acquire({ sessionId: 's1' }, server);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => instance.ensureConnected(controller.signal), /取消/);
  assert.equal(instance.state, 'failed');
});

test('意外断开触发 onUnexpectedClose 并从池里移除', async () => {
  const registry = new FakeMcpRegistry();
  registry.register({ key: 'node crash.js', tools: [{ name: 'ping' }], crashOnCall: true });
  const clock = new FakeClock();
  const seen: string[] = [];
  const pool = new ConnectionPool({
    clock,
    supervisor: createFakeSupervisor(registry),
    sdk: createFakeSdk(registry),
    onUnexpectedClose: (instance) => seen.push(instance.serverName),
  });
  const server = makeServer({ serverName: 'crash', command: 'node', args: ['crash.js'] });
  const instance = pool.acquire({ sessionId: 's1' }, server);
  await instance.ensureConnected();
  await assert.rejects(() => instance.callTool('ping', {}));
  // onclose 是同步回调，但池的移除经由 onUnexpectedClose 立刻发生；这里只是让事件循环转一圈。
  await sleep(10);
  assert.deepEqual(seen, ['crash']);
  assert.equal(pool.list().length, 0, '崩溃实例必须从池里移除');
});

test('重新 acquire 会复用仍在 connecting 的实例（避免双进程）', async () => {
  const { pool, registry } = setup();
  const server = makeServer({ serverName: 'slow', command: 'node', args: ['slow.js'] });
  const first = pool.acquire({ sessionId: 's1' }, server);
  const connecting = first.ensureConnected();
  const second = pool.acquire({ sessionId: 's1' }, server);
  assert.equal(first, second);
  await connecting;
  assert.equal(registry.connectCalls, 1);
});
