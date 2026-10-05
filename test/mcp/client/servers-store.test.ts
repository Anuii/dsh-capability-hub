/**
 * servers-store.ts：MCP 页的配置读写、保存后的跟进与页面提示。用内存 fake 代替 HTTP 与运行状态仓库。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServersStore, type ServersAdapter } from "../../../src/mcp/client/servers-store.ts";
import type { ConfigPayload, ServerView } from "../../../src/mcp/contract/config.ts";
import { defaultSettings, makeConfig, makeServerView } from "./fixtures.ts";

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
  const tools = new Map<string, number | undefined>();
  const runtime = {
    reload: async () => void calls.push("runtime.reload"),
    refresh: async (name: string) => {
      if (name === "broken") throw new Error("连接失败");
      return { toolCount: 7 };
    },
    disconnect: async (name: string) => ({ closed: name === "a" ? 2 : 0 }),
    waitForTools: async (name: string) => tools.get(name),
  };
  const store = createServersStore(adapter, runtime);
  return { store, calls, tools, setConfig: (next: ConfigPayload) => (config = next) };
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
    {
      reload: async () => {},
      refresh: async () => ({ toolCount: 0 }),
      disconnect: async () => ({ closed: 0 }),
      waitForTools: async () => undefined,
    },
  );
  await broken.reload();
  assert.equal(broken.state.get().loadError, "接口 500");
  assert.equal(broken.state.get().loading, false);
});

test("启停：在途置灰、成功只换那一行并提示；失败提示原因且不改列表", async () => {
  const { store } = setup([makeServerView({ serverName: "a" }), makeServerView({ serverName: "broken" })]);
  await store.reload();
  const pending = store.toggle(store.state.get().config!.servers[0]!, true);
  assert.equal(store.state.get().busy.has("a"), true);
  await pending;
  assert.equal(store.state.get().busy.has("a"), false);
  assert.equal(store.state.get().config!.servers[0]!.disabled, true);
  assert.equal(store.state.get().notice?.tone, "success");
  await store.toggle(store.state.get().config!.servers[1]!, true);
  assert.match(store.state.get().notice!.text, /磁盘满了/);
  assert.equal(store.state.get().notice?.tone, undefined);
  assert.equal(store.state.get().config!.servers[1]!.disabled, false);
});

test("排序：按拖动位置算出新顺序交给宿主，整表换成返回的顺序", async () => {
  const { store, calls } = setup([
    makeServerView({ serverName: "a" }),
    makeServerView({ serverName: "b" }),
    makeServerView({ serverName: "c" }),
  ]);
  await store.reload();
  await store.move(0, 2);
  assert.ok(calls.includes("reorder b,c,a"));
  assert.deepEqual(
    store.state.get().config!.servers.map((s) => s.serverName),
    ["b", "c", "a"],
  );
});

test("删除：成功返回 true 并重读；失败返回 false、提示原因", async () => {
  const { store } = setup([makeServerView({ serverName: "a" }), makeServerView({ serverName: "broken" })]);
  await store.reload();
  assert.equal(await store.remove("a"), true);
  await tick();
  assert.deepEqual(
    store.state.get().config!.servers.map((s) => s.serverName),
    ["broken"],
  );
  assert.equal(store.state.get().deleting, false);
  assert.equal(await store.remove("broken"), false);
  assert.match(store.state.get().notice!.text, /找不到服务器/);
});

test("刷新缓存与断开实例：在途标记，结果各给一句提示", async () => {
  const { store } = setup();
  const refreshing = store.refreshCache("a");
  assert.equal(store.state.get().refreshing, "a");
  await refreshing;
  assert.equal(store.state.get().refreshing, undefined);
  assert.match(store.state.get().notice!.text, /7/);
  await store.refreshCache("broken");
  assert.match(store.state.get().notice!.text, /连接失败/);
  await store.disconnectAll("a");
  assert.equal(store.state.get().notice?.tone, "success");
  await store.disconnectAll("b");
  assert.equal(store.state.get().notice?.tone, undefined, "没有实例可断开时只是说明，不是成功提示");
  assert.equal(store.state.get().disconnecting, false);
});

test("保存一个服务器：重读并提示；等到工具数再提示一次；有警告时提示警告", async () => {
  const { store, tools, calls } = setup();
  tools.set("a", 4);
  store.serverSaved(makeServerView({ serverName: "a" }), []);
  assert.ok(calls.includes("load"));
  const first = store.state.get().notice!;
  await tick();
  const second = store.state.get().notice!;
  assert.ok(second.seq > first.seq, "工具数出来后再提示一次");
  assert.match(second.text, /4/);
  store.serverSaved(makeServerView({ serverName: "z" }), ["命令在 PATH 里找不到"]);
  assert.equal(store.state.get().notice!.text, "命令在 PATH 里找不到");
  await tick();
  assert.notEqual(store.state.get().notice!.text, "命令在 PATH 里找不到", "等不到工具数也要说一声");
});

test("批量保存：探测静默进行，只有粘贴 JSON 出一条汇总提示；空列表什么都不做", async () => {
  const { store, calls, tools } = setup();
  tools.set("x", 1);
  store.batchSaved([], true);
  assert.deepEqual(calls, []);
  store.batchSaved(["x", "y"], false);
  await tick();
  assert.equal(store.state.get().notice, undefined, "导入的提示由导入视图自己出");
  store.batchSaved(["x", "y"], true);
  await tick();
  assert.match(store.state.get().notice!.text, /2/);
});

test("全局设置保存后就地更新；提示淡出只清掉还是那一条的", () => {
  const { store } = setup();
  store.settingsSaved({ ...defaultSettings, idleTimeoutMin: 3 }, ["idleTimeout"]);
  assert.equal(store.state.get().config, undefined, "还没读到配置时不凭空造一份");
  store.notify("一");
  const old = store.state.get().notice!.seq;
  store.notify("二");
  store.dismiss(old);
  assert.equal(store.state.get().notice?.text, "二");
  store.dismiss(store.state.get().notice!.seq);
  assert.equal(store.state.get().notice, undefined);
});
