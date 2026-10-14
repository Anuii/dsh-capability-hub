/**
 * servers-store.ts：MCP 页的配置读写、保存后的跟进与页面提示。用内存 fake 代替 HTTP 与运行状态仓库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServersStore, type ServersAdapter } from "../../../src/mcp/client/servers-store.ts";
import type { ConfigPayload, ServerView } from "../../../src/mcp/contract/config.ts";
import type { RuntimeServerView } from "../../../src/mcp/contract/runtime.ts";
import { makeConfig, makeRow, makeServerView } from "./fixtures.ts";

function setup(initial: ServerView[] = [makeServerView({ serverName: "a" }), makeServerView({ serverName: "b" })]) {
  let config: ConfigPayload = makeConfig(initial);
  const calls: string[] = [];
  const adapter: ServersAdapter = {
    async load() {
      calls.push("load");
      return config;
    },
    async toggle(name, disabled) {
      calls.push("toggle " + name + " " + disabled);
      if (name === "broken") throw new Error("磁盘满了");
      return makeServerView({ serverName: name, disabled });
    },
    async reorder(names) {
      calls.push("reorder " + names.join(","));
      return names.map((name) => makeServerView({ serverName: name }));
    },
    async remove(name) {
      calls.push("remove " + name);
      if (name === "broken") throw new Error("找不到服务器「broken」。");
      config = makeConfig(config.servers.filter((server) => server.serverName !== name));
    },
  };
  const settled = new Map<string, RuntimeServerView | undefined>();
  const runtime = {
    reload: async () => void calls.push("runtime.reload"),
    reconnect: async (name: string) => {
      calls.push("reconnect " + name);
      if (name === "broken") throw new Error("服务器「broken」已停用");
      return makeRow({ name, state: "failed", tools: [], error: "spawn npx ENOENT" });
    },
    waitSettled: async (name: string) => settled.get(name),
  };
  const store = createServersStore(adapter, runtime);
  return { store, calls, settled };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("读取：成功后有配置；失败给中文原因；运行状态也顺带重读", async () => {
  const { store, calls } = setup();
  assert.equal(store.state.get().loading, true);
  await store.reload();
  assert.deepEqual(
    store.state.get().config?.servers.map((s) => s.serverName),
    ["a", "b"],
  );
  assert.ok(calls.includes("runtime.reload"));
  const broken = createServersStore(
    { ...({} as ServersAdapter), load: async () => Promise.reject(new Error("接口 500")) },
    { reload: async () => {}, reconnect: async (name) => makeRow({ name }), waitSettled: async () => undefined },
  );
  await broken.reload();
  assert.equal(broken.state.get().loadError, "接口 500");
  assert.equal(broken.state.get().loading, false);
});

test("启停：在途置灰，成功只换那一行并重读运行状态；失败给提示", async () => {
  const { store, calls } = setup();
  await store.reload();
  const pending = store.toggle(makeServerView({ serverName: "a" }), true);
  assert.equal(store.state.get().busy.has("a"), true);
  await pending;
  assert.equal(store.state.get().busy.has("a"), false);
  assert.equal(store.state.get().config?.servers.find((s) => s.serverName === "a")?.disabled, true);
  assert.equal(calls.filter((c) => c === "runtime.reload").length, 2);
  assert.match(store.state.get().notice!.text, /已停用「a」/);
  await store.toggle(makeServerView({ serverName: "broken" }), true);
  assert.match(store.state.get().notice!.text, /磁盘满了/);
});

test("排序与删除", async () => {
  const { store, calls } = setup();
  await store.reload();
  await store.move(0, 1);
  assert.ok(calls.includes("reorder b,a"));
  assert.deepEqual(
    store.state.get().config?.servers.map((s) => s.serverName),
    ["b", "a"],
  );
  assert.equal(await store.remove("a"), true);
  assert.match(store.state.get().notice!.text, /已删除「a」/);
  assert.equal(await store.remove("broken"), false);
  assert.match(store.state.get().notice!.text, /找不到服务器/);
});

test("重新连接：在途标记；结果写进提示（失败带原因）；接口报错也只给提示", async () => {
  const { store } = setup();
  const pending = store.reconnect("a");
  assert.equal(store.state.get().reconnecting, "a");
  await pending;
  assert.equal(store.state.get().reconnecting, undefined);
  assert.match(store.state.get().notice!.text, /「a」连接失败：spawn npx ENOENT/);
  await store.reconnect("broken");
  assert.match(store.state.get().notice!.text, /重新连接「broken」失败：服务器「broken」已停用/);
});

test("保存后等连接结果再提示：已连接带工具数；按会话说明下个会话生效；还没结果说正在连接", async () => {
  const { store, settled } = setup();
  settled.set("a", makeRow({ name: "a" }));
  store.serverSaved(makeServerView({ serverName: "a" }), []);
  await tick();
  await tick();
  assert.equal(store.state.get().notice?.tone, "success");
  assert.match(store.state.get().notice!.text, /「a」已连接 · 2 个工具/);
  settled.set("s", makeRow({ name: "s", scope: "session", state: "session", tools: [] }));
  store.serverSaved(makeServerView({ serverName: "s", scope: "session" }), []);
  await tick();
  await tick();
  assert.match(store.state.get().notice!.text, /按会话连接/);
  store.serverSaved(makeServerView({ serverName: "slow" }), []);
  await tick();
  await tick();
  assert.match(store.state.get().notice!.text, /还在连接中/);
});

test("保存一个停用的服务器：不等连接，直接说已保存；宿主的警告原样提示", async () => {
  const { store } = setup();
  store.serverSaved(makeServerView({ serverName: "off", disabled: true }), []);
  assert.match(store.state.get().notice!.text, /已保存「off」/);
  store.serverSaved(makeServerView({ serverName: "w", disabled: true }), ["没有找到启动命令「npx」"]);
  assert.match(store.state.get().notice!.text, /没有找到启动命令/);
});

test("批量保存（粘贴 JSON）：一条汇总提示；一个都没保存时不出提示", async () => {
  const { store } = setup();
  store.batchSaved([]);
  assert.equal(store.state.get().notice, undefined);
  store.batchSaved(["x", "y"]);
  assert.match(store.state.get().notice!.text, /已保存 2 个服务器/);
});

test("提示淡出：只清掉还是这一条的提示", () => {
  const { store } = setup();
  store.notify("一");
  const first = store.state.get().notice!.seq;
  store.notify("二");
  store.dismiss(first);
  assert.equal(store.state.get().notice?.text, "二");
  store.dismiss(store.state.get().notice!.seq);
  assert.equal(store.state.get().notice, undefined);
});
