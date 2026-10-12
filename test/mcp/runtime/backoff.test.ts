/** 失败退避（D-D7）：冷却期内的调用、手动刷新不受冷却限制、成功清空、取消不算失败、服务器自己的错误不算失败。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { callCtx, makeHarness, makeServer } from "./helpers.ts";

const SERVER = makeServer({ serverName: "a", command: "node", args: ["srv.js"] });
const PING = "mcp__a__ping";

/**
 * 造一个「先成功后失败」的假服务器：start() 会先做一次启动探测（第 1 次连接），它必须成功，
 * 工具才会进缓存、才会被注册；之后第 failOnCalls 次（1 起数）连接失败。
 */
function flaky(key: string, tools: Array<{ name: string }>, failOnCalls: number[] = [2]) {
  let call = 0;
  return {
    key,
    tools,
    get connectFailure() {
      call += 1;
      return failOnCalls.includes(call) ? "启动失败" : undefined;
    },
  };
}

/** 等一个 Promise 失败并返回错误文字（调用失败一律抛错，DSH 把它记成失败的工具调用）。 */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("本该失败的调用成功了");
}

test("连接失败后进入冷却，冷却期内的调用直接拒绝并给出剩余时间与解决办法", async () => {
  const h = await makeHarness({ servers: [SERVER], behaviors: [flaky("node srv.js", [{ name: "ping" }], [2])] });
  try {
    assert.deepEqual(
      h.runtime.tools().map((spec) => spec.name),
      [PING],
    );
    const first = await failure(h.runtime.call(PING, {}, callCtx("main")));
    assert.match(first, /调用 "mcp__a__ping" 失败/);
    assert.match(first, /启动失败/);
    assert.match(first, /已进入 \d+ 秒冷却/);
    const connects = h.registry.connectCalls;
    const second = await failure(h.runtime.call(PING, {}, callCtx("main")));
    assert.match(second, /冷却还剩 \d+ 秒/);
    assert.match(second, /不会自动重试/);
    assert.match(second, /能力中心/, "告诉模型可以请用户去界面里刷新");
    assert.equal(h.registry.connectCalls, connects, "冷却期内不再连接");
  } finally {
    await h.dispose();
  }
});

test("冷却期过后会真的再试一次", async () => {
  const h = await makeHarness({ servers: [SERVER], behaviors: [flaky("node srv.js", [{ name: "ping" }], [2, 3])] });
  try {
    await failure(h.runtime.call(PING, {}, callCtx("main")));
    h.clock.jump(61_000);
    const again = await failure(h.runtime.call(PING, {}, callCtx("main")));
    assert.match(again, /启动失败/, "会真的再试一次（仍然失败）");
    assert.ok(!again.includes("冷却还剩"), "不再是冷却文案");
  } finally {
    await h.dispose();
  }
});

test("界面上的手动刷新不受冷却限制，成功后清空失败、调用恢复", async () => {
  const h = await makeHarness({ servers: [SERVER], behaviors: [flaky("node srv.js", [{ name: "ping" }], [2])] });
  try {
    await failure(h.runtime.call(PING, {}, callCtx("main")));
    assert.match(await failure(h.runtime.call(PING, {}, callCtx("main"))), /冷却还剩/);
    assert.deepEqual(await h.runtime.refresh("a"), { toolCount: 1 });
    assert.equal((await h.runtime.status()).servers[0]!.lastFailure, undefined);
    assert.equal(await h.runtime.call(PING, {}, callCtx("main")), "fake:ping");
  } finally {
    await h.dispose();
  }
});

test("成功即清空失败记录", async () => {
  const h = await makeHarness({ servers: [SERVER], behaviors: [flaky("node srv.js", [{ name: "ping" }], [2])] });
  try {
    await failure(h.runtime.call(PING, {}, callCtx("main")));
    assert.ok((await h.runtime.status()).servers[0]!.lastFailure, "先要有一次失败");
    h.clock.jump(61_000);
    assert.equal(await h.runtime.call(PING, {}, callCtx("main")), "fake:ping");
    assert.equal((await h.runtime.status()).servers[0]!.lastFailure, undefined, "成功之后不该还留着失败记录");
  } finally {
    await h.dispose();
  }
});

test("调用抛错同样进入冷却", async () => {
  const h = await makeHarness({
    servers: [SERVER],
    behaviors: [{ key: "node srv.js", tools: [{ name: "ping" }], callFailure: "服务器内部错误" }],
  });
  try {
    const first = await failure(h.runtime.call(PING, {}, callCtx("main")));
    assert.match(first, /调用 "mcp__a__ping" 失败/);
    assert.match(first, /服务器内部错误/);
    assert.match(await failure(h.runtime.call(PING, {}, callCtx("main"))), /冷却还剩/);
  } finally {
    await h.dispose();
  }
});

test("服务器自己返回的错误（isError）原文交给模型，不算失败、不进冷却", async () => {
  const h = await makeHarness({
    servers: [SERVER],
    behaviors: [
      {
        key: "node srv.js",
        tools: [{ name: "ping" }],
        callResults: { ping: { isError: true, content: [{ type: "text", text: "参数 x 不能为空" }] } },
      },
    ],
  });
  try {
    assert.match(await failure(h.runtime.call(PING, {}, callCtx("main"))), /参数 x 不能为空/);
    assert.equal((await h.runtime.status()).servers[0]!.lastFailure, undefined);
    assert.match(await failure(h.runtime.call(PING, {}, callCtx("main"))), /参数 x 不能为空/, "下一次照常调用");
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
    await h.runtime.call(PING, {}, callCtx("main"));
    const controller = new AbortController();
    const calling = h.runtime.call(PING, {}, callCtx("main", { signal: controller.signal }));
    controller.abort();
    assert.match(await failure(calling), /已取消/);
    assert.equal((await h.runtime.status()).servers[0]!.lastFailure, undefined, "取消不该留下失败记录");
    assert.equal(await h.runtime.call(PING, {}, callCtx("main")), "fake:ping", "取消后照常调用");
  } finally {
    await h.dispose();
  }
});

test("failureBackoffMs 可配置（0 = 立刻可重试）", async () => {
  const h = await makeHarness({
    servers: [SERVER],
    behaviors: [flaky("node srv.js", [{ name: "ping" }], [2, 3])],
    settings: { failureBackoffMs: 0 },
  });
  try {
    const first = await failure(h.runtime.call(PING, {}, callCtx("main")));
    assert.ok(!first.includes("冷却"), "退避为 0 时不该出现冷却文案");
    assert.equal((await h.runtime.status()).servers[0]!.lastFailure!.cooldownUntil, undefined);
    assert.match(await failure(h.runtime.call(PING, {}, callCtx("main"))), /启动失败/, "立刻再试");
  } finally {
    await h.dispose();
  }
});

test("status 暴露最近失败与冷却时间", async () => {
  const h = await makeHarness({ servers: [SERVER], behaviors: [flaky("node srv.js", [{ name: "ping" }], [2])] });
  try {
    await failure(h.runtime.call(PING, {}, callCtx("main")));
    const last = (await h.runtime.status()).servers[0]!.lastFailure!;
    assert.match(last.message, /启动失败/);
    assert.equal(typeof last.at, "number");
    assert.equal(typeof last.cooldownUntil, "number");
  } finally {
    await h.dispose();
  }
});

test("不存在的工具名、已停用服务器的工具：说明原因，不起进程", async () => {
  const h = await makeHarness({ servers: [SERVER], behaviors: [flaky("node srv.js", [{ name: "ping" }], [])] });
  try {
    const connects = h.registry.connectCalls;
    assert.match(await failure(h.runtime.call("mcp__a__nope", {}, callCtx("main"))), /已不存在/);
    h.config.setServers([{ ...SERVER, disabled: true }]);
    assert.deepEqual(h.runtime.tools(), []);
    assert.match(await failure(h.runtime.call(PING, {}, callCtx("main"))), /已不存在/);
    assert.equal(h.registry.connectCalls, connects);
  } finally {
    await h.dispose();
  }
});
