/**
 * servers-store.ts：MCP 页的配置读写与页面提示。用内存 fake 代替 HTTP。
 *
 * 0.9.0 起没有运行状态：保存 / 删除 / 启停之后不等连接结果，提示也不按连接状态写，
 * 一律是中性的一句成功提示（连不上只看宿主 GET health 的 mcpServers）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServersStore, type ServersAdapter } from "../../../src/mcp/client/servers-store.ts";
import type { ConfigPayload, ServerView } from "../../../src/mcp/contract/config.ts";
import { makeConfig, makeServerView } from "./fixtures.ts";

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
  const store = createServersStore(adapter);
  return { store, calls };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("读取：成功后有配置；失败给中文原因", async () => {
  const { store } = setup();
  assert.equal(store.state.get().loading, true);
  await store.reload();
  assert.deepEqual(
    store.state.get().config?.servers.map((s) => s.serverName),
    ["a", "b"],
  );
  const broken = createServersStore({
    ...({} as ServersAdapter),
    load: async () => Promise.reject(new Error("接口 500")),
  });
  await broken.reload();
  assert.equal(broken.state.get().loadError, "接口 500");
  assert.equal(broken.state.get().loading, false);
});

test("启停：在途置灰，成功只换那一行并给中性提示；失败给提示", async () => {
  const { store, calls } = setup();
  await store.reload();
  const pending = store.toggle(makeServerView({ serverName: "a" }), true);
  assert.equal(store.state.get().busy.has("a"), true);
  await pending;
  assert.equal(store.state.get().busy.has("a"), false);
  assert.equal(store.state.get().config?.servers.find((s) => s.serverName === "a")?.disabled, true);
  assert.match(store.state.get().notice!.text, /已停用「a」/);
  assert.equal(store.state.get().notice?.tone, "success");
  await store.toggle(makeServerView({ serverName: "broken" }), true);
  assert.match(store.state.get().notice!.text, /磁盘满了/);
  assert.equal(calls.filter((c) => c.startsWith("load")).length, 1, "启停不再重读配置或运行状态");
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

test("保存一个服务器：重读列表 + 一句中性的「已保存」，不等连接结果", async () => {
  const { store, calls } = setup();
  store.serverSaved(makeServerView({ serverName: "a" }), []);
  assert.equal(store.state.get().notice?.tone, "success");
  assert.match(store.state.get().notice!.text, /已保存「a」/);
  await tick();
  assert.ok(calls.includes("load"), "保存之后重读配置");
});

test("保存时宿主的警告原样提示（此时只说警告）", async () => {
  const { store } = setup();
  store.serverSaved(makeServerView({ serverName: "w" }), ["没有找到启动命令「npx」"]);
  assert.match(store.state.get().notice!.text, /没有找到启动命令/);
  assert.equal(store.state.get().notice?.tone, undefined);
});

test("批量保存（粘贴 JSON）：一条汇总提示；一个都没保存时不出提示", async () => {
  const { store } = setup();
  store.batchSaved([]);
  assert.equal(store.state.get().notice, undefined);
  store.batchSaved(["x", "y"]);
  assert.match(store.state.get().notice!.text, /已保存 2 个服务器/);
  assert.equal(store.state.get().notice?.tone, "success");
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
