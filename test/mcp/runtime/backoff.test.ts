/** 失败退避（D-D7）：冷却期内的 call/connect、force 绕过、取消不算失败。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { callCtx, makeHarness, makeServer } from "./helpers.ts";

const SERVER = makeServer({ serverName: "a", command: "node", args: ["srv.js"] });

/**
 * 造一个「先成功后失败」的假服务器：因为 start() 会先做一次启动探测，
 * 若一上来就失败，第一次 connect 已经在冷却里了，测不出「失败 → 冷却」这条路径。
 */
function flaky(key: string, tools: Array<{ name: string }>, failOnCalls: number[] = [2]) {
  let call = 0;
  return {
    key,
    tools,
    // 只有第 failOnCalls 次（1 起数）连接失败，其余成功。第 1 次通常是 start() 的启动探测。
    get connectFailure() {
      call += 1;
      return failOnCalls.includes(call) ? "启动失败" : undefined;
    },
  };
}

test("连接失败后进入冷却，冷却期内的 connect / call 直接返回说明与剩余时间", async () => {
  const h = await makeHarness({ servers: [SERVER], behaviors: [flaky("node srv.js", [{ name: "ping" }], [2])] });
  try {
    const first = await h.runtime.execute({ connect: "a" }, callCtx("main"));
    assert.match(first, /连接服务器 "a" 失败/);
    assert.match(first, /启动失败/);
    assert.match(first, /已进入 \d+ 秒冷却/);

    const second = await h.runtime.execute({ connect: "a" }, callCtx("main"));
    assert.match(second, /冷却还剩 \d+ 秒/);
    assert.match(second, /不会自动重试/);
    assert.match(second, /force: true/);
  } finally {
    await h.dispose();
  }
});

test("冷却期过后可以再试", async () => {
  const h = await makeHarness({ servers: [SERVER], behaviors: [flaky("node srv.js", [{ name: "ping" }], [2, 3])] });
  try {
    await h.runtime.execute({ connect: "a", force: true }, callCtx("main"));
    assert.ok((await h.runtime.status()).servers[0].lastFailure, "应当已有失败记录");
    h.clock.jump(61_000);
    const again = await h.runtime.execute({ connect: "a" }, callCtx("main"));
    assert.match(again, /失败/, "会真的再试一次（仍然失败）");
    assert.ok(!again.includes("冷却还剩"), "不再是冷却文案");
  } finally {
    await h.dispose();
  }
});

test("connect 带 force 可绕过冷却", async () => {
  let failures = 1;
  const h = await makeHarness({
    servers: [SERVER],
    behaviors: [
      {
        key: "node srv.js",
        tools: [{ name: "ping" }],
        get connectFailure() {
          return failures-- > 0 ? "第一次失败" : undefined;
        },
      },
    ],
  });
  try {
    const first = await h.runtime.execute({ connect: "a" }, callCtx("main"));
    assert.match(first, /冷却/);
    const forced = await h.runtime.execute({ connect: "a", force: true }, callCtx("main"));
    assert.match(forced, /已连接服务器 "a"/);
    assert.ok(!forced.includes("冷却"));
  } finally {
    await h.dispose();
  }
});

test("成功即清空失败记录", async () => {
  // start() 的启动探测成功（第 1 次）⇒ 第一次 connect 失败（第 2 次）⇒ 再连成功（第 3 次）。
  const h = await makeHarness({ servers: [SERVER], behaviors: [flaky("node srv.js", [{ name: "ping" }], [2])] });
  try {
    await h.runtime.execute({ connect: "a", force: true }, callCtx("main"));
    assert.ok((await h.runtime.status()).servers[0].lastFailure, "先要有一次失败");
    h.clock.jump(61_000);
    await h.runtime.execute({ connect: "a" }, callCtx("main"));
    const status = await h.runtime.status();
    assert.equal(status.servers[0].lastFailure, undefined, "成功之后不该还留着失败记录");
  } finally {
    await h.dispose();
  }
});

test("调用失败后同样进入冷却，冷却期内 call 直接返回", async () => {
  const h = await makeHarness({
    servers: [SERVER],
    behaviors: [{ key: "node srv.js", tools: [{ name: "ping" }], callFailure: "服务器内部错误" }],
  });
  try {
    const first = await h.runtime.execute({ tool: "ping", args: {} }, callCtx("main"));
    assert.match(first, /调用 "a__ping" 失败/);
    assert.match(first, /服务器内部错误/);
    const second = await h.runtime.execute({ tool: "ping", args: {} }, callCtx("main"));
    assert.match(second, /冷却还剩/);
  } finally {
    await h.dispose();
  }
});

test("取消不算失败：不进入冷却", async () => {
  const h = await makeHarness({
    servers: [SERVER],
    behaviors: [{ key: "node srv.js", tools: [{ name: "ping" }], callDelayMs: 100 }],
  });
  try {
    await h.runtime.execute({ connect: "a" }, callCtx("main"));
    const controller = new AbortController();
    const calling = h.runtime.execute({ tool: "ping", args: {} }, callCtx("main", { signal: controller.signal }));
    controller.abort();
    const text = await calling;
    assert.match(text, /已被取消/);
    const status = await h.runtime.status();
    assert.equal(status.servers[0].lastFailure, undefined, "取消不该留下失败记录");
    // 而且下一次调用应当被正常尝试
    const again = await h.runtime.execute({ tool: "ping", args: {} }, callCtx("main"));
    assert.ok(!again.includes("冷却"), "取消后不该有冷却");
  } finally {
    await h.dispose();
  }
});

test("failureBackoffMs 可配置（0 = 立刻可重试）", async () => {
  const h = await makeHarness({
    servers: [SERVER],
    behaviors: [{ key: "node srv.js", connectFailure: "失败" }],
    settings: { failureBackoffMs: 0 },
  });
  try {
    const first = await h.runtime.execute({ connect: "a" }, callCtx("main"));
    assert.match(first, /失败/);
    assert.ok(!first.includes("冷却"), "退避为 0 时不该出现冷却文案");
    const status = await h.runtime.status();
    assert.equal(status.servers[0].lastFailure!.cooldownUntil, undefined, "退避为 0 时不该有 cooldownUntil");
  } finally {
    await h.dispose();
  }
});

test("status 暴露最近失败与冷却时间", async () => {
  const h = await makeHarness({ servers: [SERVER], behaviors: [{ key: "node srv.js", connectFailure: "爆炸" }] });
  try {
    await h.runtime.execute({ connect: "a" }, callCtx("main"));
    const status = await h.runtime.status();
    assert.ok(status.servers[0].lastFailure);
    assert.match(status.servers[0].lastFailure!.message, /爆炸/);
    assert.equal(typeof status.servers[0].lastFailure!.at, "number");
    assert.equal(typeof status.servers[0].lastFailure!.cooldownUntil, "number");
  } finally {
    await h.dispose();
  }
});
