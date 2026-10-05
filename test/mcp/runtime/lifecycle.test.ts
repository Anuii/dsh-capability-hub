/** 四种生命周期 + 空闲回收 + inFlight 保护 + sessionStarted 不阻塞（D-D4/D-D5）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { callCtx, makeHarness, makeServer } from "./helpers.ts";
import { sleep, waitFor } from "./fakes/fake-clock.ts";

const BEHAVIOR = { key: "node srv.js", tools: [{ name: "ping" }] };

test("lazy：会话开始不启动，首次调用才启动", async () => {
  const h = await makeHarness({
    servers: [makeServer({ serverName: "a", command: "node", args: ["srv.js"], lifecycle: "lazy" })],
    behaviors: [BEHAVIOR],
  });
  try {
    const before = h.registry.connectCalls;
    h.runtime.sessionStarted({ sessionId: "main" });
    await sleep(20);
    assert.equal(h.registry.connectCalls, before, "lazy 在会话开始时不连接");
    await h.runtime.execute({ tool: "ping", args: {} }, callCtx("main"));
    assert.ok(h.registry.connectCalls > before, "首次使用才连");
  } finally {
    await h.dispose();
  }
});

test("lazy-keep-alive：首次调用才启动，空闲后不回收", async () => {
  const h = await makeHarness({
    servers: [makeServer({ serverName: "a", command: "node", args: ["srv.js"], lifecycle: "lazy-keep-alive" })],
    behaviors: [BEHAVIOR],
  });
  try {
    const before = h.registry.connectCalls;
    h.runtime.sessionStarted({ sessionId: "main" });
    await sleep(20);
    assert.equal(h.registry.connectCalls, before, "lazy-keep-alive 在会话开始时不连接");
    await h.runtime.execute({ tool: "ping", args: {} }, callCtx("main"));
    assert.ok(h.registry.connectCalls > before);
    assert.equal(await h.runtime.sweepOnce(), 0, "会话内常驻，巡检不该回收");
    // 推很久也不回收（只推时间，不触发定时器，避免把 24 小时的巡检真跑一遍）
    h.clock.jump(24 * 3600 * 1000);
    assert.equal(await h.runtime.sweepOnce(), 0);
    assert.equal(h.registry.liveProcessCount(), 1);
  } finally {
    await h.dispose();
  }
});

test("eager：会话开始时后台启动，空闲后回收", async () => {
  const h = await makeHarness({
    servers: [makeServer({ serverName: "a", command: "node", args: ["srv.js"], lifecycle: "eager" })],
    behaviors: [BEHAVIOR],
  });
  try {
    const before = h.registry.connectCalls;
    h.runtime.sessionStarted({ sessionId: "main" });
    await sleep(20);
    await h.runtime.waitForBackgroundWork();
    assert.equal(h.registry.connectCalls, before + 1, "eager 必须在会话开始时后台连接");
    h.clock.jump(11 * 60_000);
    assert.ok((await h.runtime.sweepOnce()) >= 1, "eager 空闲后要回收");
    assert.equal(h.registry.liveProcessCount(), 0);
  } finally {
    await h.dispose();
  }
});

test("keep-alive：会话开始时后台启动，会话内不回收", async () => {
  const h = await makeHarness({
    servers: [makeServer({ serverName: "a", command: "node", args: ["srv.js"], lifecycle: "keep-alive" })],
    behaviors: [BEHAVIOR],
  });
  try {
    const before = h.registry.connectCalls;
    h.runtime.sessionStarted({ sessionId: "main" });
    await sleep(20);
    assert.equal(h.registry.connectCalls, before + 1);
    await sleep(10);
    h.clock.jump(60 * 60_000);
    assert.equal(await h.runtime.sweepOnce(), 0, "不回收");
    assert.equal(h.registry.liveProcessCount(), 1);
  } finally {
    await h.dispose();
  }
});

test("keep-alive 遇到显式 idleTimeout 仍然按该值回收（二维取值的真实含义）", async () => {
  const h = await makeHarness({
    servers: [
      makeServer({ serverName: "a", command: "node", args: ["srv.js"], lifecycle: "keep-alive", idleTimeoutMin: 5 }),
    ],
    behaviors: [BEHAVIOR],
  });
  try {
    // start() 本身会做一次启动探测，所以用增量而不是绝对值（下同）。
    const before = h.registry.connectCalls;
    h.runtime.sessionStarted({ sessionId: "main" });
    await sleep(20);
    assert.equal(h.registry.connectCalls, before + 1, "keep-alive 必须在会话开始时后台连接");
    h.clock.jump(6 * 60_000);
    assert.ok((await h.runtime.sweepOnce()) >= 1, "显式 idleTimeout 生效后应当被回收");
    assert.equal(h.registry.liveProcessCount(), 0);
  } finally {
    await h.dispose();
  }
});

test("sessionStarted 不得阻塞：慢服务器也要立刻返回", async () => {
  const h = await makeHarness({
    servers: [makeServer({ serverName: "a", command: "node", args: ["srv.js"], lifecycle: "eager" })],
    behaviors: [{ key: "node srv.js", tools: [{ name: "ping" }], connectDelayMs: 200 }],
  });
  try {
    const started = Date.now();
    h.runtime.sessionStarted({ sessionId: "main" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 50, "sessionStarted 必须同步返回，实际 " + elapsed + "ms");
    // connectDelayMs=200，所以 50ms 内不可能连上 —— 这就是「没有阻塞」的直接证据。
    await sleep(400);
    assert.ok(h.registry.connectCalls >= 1, "后台连接最终要建立");
  } finally {
    await h.dispose();
  }
});

test("idleTimeout=0 表示不回收", async () => {
  const h = await makeHarness({
    servers: [makeServer({ serverName: "a", command: "node", args: ["srv.js"], idleTimeoutMin: 0 })],
    behaviors: [BEHAVIOR],
  });
  try {
    await h.runtime.execute({ tool: "ping", args: {} }, callCtx("main"));
    h.clock.jump(24 * 3600 * 1000);
    assert.equal(await h.runtime.sweepOnce(), 0);
    assert.equal(h.registry.liveProcessCount(), 1);
  } finally {
    await h.dispose();
  }
});

test("默认 lazy 的 idleTimeout 继承全局值（10 分钟）", async () => {
  const h = await makeHarness({
    servers: [makeServer({ serverName: "a", command: "node", args: ["srv.js"], idleTimeoutMin: 10 })],
    behaviors: [BEHAVIOR],
  });
  try {
    await h.runtime.execute({ tool: "ping", args: {} }, callCtx("main"));
    h.clock.jump(9 * 60_000);
    assert.equal(await h.runtime.sweepOnce(), 0, "还没到点");
    h.clock.jump(2 * 60_000);
    assert.equal(await h.runtime.sweepOnce(), 1, "超过 10 分钟应回收");
  } finally {
    await h.dispose();
  }
});

test("inFlight > 0 期间巡检绝不回收（慢调用保护）", async () => {
  const h = await makeHarness({
    servers: [makeServer({ serverName: "a", command: "node", args: ["srv.js"] })],
    behaviors: [{ key: "node srv.js", tools: [{ name: "ping" }], callDelayMs: 60 }],
  });
  try {
    await h.runtime.execute({ connect: "a" }, callCtx("main"));
    const calling = h.runtime.execute({ tool: "ping", args: {} }, callCtx("main"));
    // 先等这次调用真的进了 SDK（callDelayMs=60 的慢调用），否则「巡检不回收」测的是
    // 「调用还没开始」这段空窗 —— 那时实例确实空闲，回收它并不违反 D-D7。
    await waitFor(() => h.registry.callCalls.length > 0, 2000, "慢调用进入 SDK");
    h.clock.jump(60 * 60_000);
    assert.equal(await h.runtime.sweepOnce(), 0, "调用进行中不该被回收");
    await calling;
    assert.equal(h.registry.liveProcessCount(), 1);
    // 调用结束会刷新「最后使用时间」，所以必须先再空转一个窗口才谈得上回收。
    h.clock.jump(11 * 60_000);
    assert.equal(await h.runtime.sweepOnce(), 1, "调用结束后才可回收");
  } finally {
    await h.dispose();
  }
});

test("30 秒定时巡检会自动回收（用可注入时钟驱动）", async () => {
  const h = await makeHarness({
    servers: [makeServer({ serverName: "a", command: "node", args: ["srv.js"], idleTimeoutMin: 1 })],
    behaviors: [BEHAVIOR],
  });
  try {
    await h.runtime.execute({ tool: "ping", args: {} }, callCtx("main"));
    assert.equal(h.registry.liveProcessCount(), 1);
    // idleTimeoutMin=1 ⇒ 巡检（每 30 秒一次）在推进 2 分钟后必然回收。
    await h.clock.advance(2 * 60_000);
    await h.runtime.waitForBackgroundWork();
    assert.equal(h.registry.liveProcessCount(), 0, "定时巡检必须自动回收空闲实例");
  } finally {
    await h.dispose();
  }
});

test("停用的服务器不随生命周期启动", async () => {
  const h = await makeHarness({
    servers: [makeServer({ serverName: "a", command: "node", args: ["srv.js"], lifecycle: "eager", disabled: true })],
    behaviors: [BEHAVIOR],
  });
  try {
    const before = h.registry.connectCalls;
    h.runtime.sessionStarted({ sessionId: "main" });
    await sleep(20);
    assert.equal(h.registry.connectCalls, before, "停用的服务器不该被启动");
  } finally {
    await h.dispose();
  }
});
