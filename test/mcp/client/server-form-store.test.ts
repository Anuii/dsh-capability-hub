/**
 * server-form-store.ts：服务器表单的草稿、错误显示、检查命令、显示遮罩值与保存流程。HTTP 用内存 fake。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServerFormStore, type ServerFormAdapter } from "../../../src/mcp/client/server-form-store.ts";
import { draftFromView, emptyServerDraft, withField, type ServerDraft } from "../../../src/mcp/client/draft.ts";
import { HIDDEN } from "../../../src/mcp/rules/server.ts";
import type { UpsertResult } from "../../../src/mcp/contract/config.ts";
import { makeServerView } from "./fixtures.ts";

function setup(options: { initial?: ServerDraft; originalName?: string; names?: string[]; found?: boolean } = {}) {
  const calls: string[] = [];
  let upsertError: unknown;
  const adapter: ServerFormAdapter = {
    async checkCommand(command, cwd) {
      calls.push("check " + command + (cwd === undefined ? "" : " @" + cwd));
      return options.found === false ? { found: false } : { found: true, resolvedPath: "C:/bin/" + command + ".exe" };
    },
    async reveal(name) {
      calls.push("reveal " + name);
      if (name === "broken") throw new Error("没有权限");
      return makeServerView({ serverName: name, env: { TOKEN: "s3cret" }, headers: { Authorization: "Bearer x" } });
    },
    async upsert(originalName, server): Promise<UpsertResult> {
      calls.push("upsert " + (originalName ?? "-") + " " + JSON.stringify(server));
      if (upsertError !== undefined) throw upsertError;
      return { server: makeServerView({ serverName: String(server.serverName) }), warnings: [] };
    },
  };
  const names = options.names ?? [];
  const store = createServerFormStore(adapter, {
    initial: options.initial ?? emptyServerDraft("stdio"),
    ...(options.originalName === undefined ? {} : { originalName: options.originalName }),
    existingNames: () => names,
  });
  return { store, calls, failUpsert: (error: unknown) => (upsertError = error) };
}

const filled = (): ServerDraft =>
  withField(withField(emptyServerDraft("stdio"), "serverName", "demo"), "command", "node");

test("字段：改值记为碰过；恢复默认删掉键并让编辑器重读；改命令清掉找不到命令的警告", async () => {
  const { store } = setup({ initial: filled(), found: false });
  store.setField("args", ["-y"]);
  assert.deepEqual(store.state.get().draft.values.args, ["-y"]);
  assert.equal(store.state.get().touched.has("args"), true);
  const token = store.state.get().syncToken;
  store.resetField("args");
  assert.equal("args" in store.state.get().draft.values, false);
  assert.equal(store.state.get().syncToken, token + 1);
  await store.save(false);
  assert.match(store.state.get().commandWarning!, /node/);
  store.setField("command", "npx");
  assert.equal(store.state.get().commandWarning, undefined);
});

test("切换传输方式只改 transport：另一种传输的字段留在草稿里", () => {
  const { store } = setup({ initial: filled() });
  store.setTransport("streamable-http");
  assert.equal(store.state.get().draft.values.command, "node");
  assert.equal(store.state.get().draft.values.transport, "streamable-http");
  assert.deepEqual(store.errors().url?.length, 1, "http 必须填地址（同一份规则）");
});

test("错误：表单检查与重名用的是同一份规则；保存时有错不发请求，并把所有错误亮出来", async () => {
  const { store, calls } = setup({ initial: filled(), names: ["demo"] });
  assert.equal(store.errors().serverName?.length, 1, "重名");
  assert.equal(store.state.get().showAll, false);
  assert.equal(await store.save(false), undefined);
  assert.equal(store.state.get().showAll, true);
  assert.deepEqual(calls, []);
  const editing = setup({ initial: filled(), names: ["demo"], originalName: "demo" });
  assert.equal(editing.store.errors().serverName, undefined, "编辑自己不算重名");
});

test("保存：命令找到 → 直接提交；找不到 → 先警告，确认后才提交", async () => {
  const ok = setup({ initial: filled() });
  const result = await ok.store.save(false);
  assert.equal(result?.server.serverName, "demo");
  assert.deepEqual(ok.calls[0], "check node");
  assert.match(ok.calls[1]!, /^upsert - \{"serverName":"demo","transport":"stdio","command":"node"\}$/);
  assert.equal(ok.store.state.get().saving, false);

  const missing = setup({ initial: filled(), found: false });
  assert.equal(await missing.store.save(false), undefined);
  assert.equal(
    missing.calls.some((call) => call.startsWith("upsert")),
    false,
  );
  assert.notEqual(await missing.store.save(true), undefined, "仍然保存");
});

test("保存失败：给中文原因，宿主的逐字段错误映射回字段", async () => {
  const { store, failUpsert } = setup({ initial: filled() });
  failUpsert(
    Object.assign(new Error("参数不合法"), {
      code: "VALIDATION",
      details: [{ path: "server.env.API_KEY", message: "这是遮罩占位符，不是真实值。" }],
    }),
  );
  assert.equal(await store.save(false), undefined);
  assert.match(store.state.get().formError!, /参数不合法/);
  assert.deepEqual(store.errors().env, ["这是遮罩占位符，不是真实值。"]);
  store.resetField("env");
  assert.equal(store.errors().env, undefined, "恢复默认同时清掉这个字段的宿主错误");
});

test("显示遮罩值：只在编辑已有服务器时可用；明文只写进草稿", async () => {
  const view = makeServerView({
    serverName: "demo",
    env: { TOKEN: HIDDEN },
    setFields: ["serverName", "transport", "command", "env"],
  });
  const { store } = setup({ initial: draftFromView(view), originalName: "demo" });
  assert.equal(await store.reveal("env"), true);
  assert.deepEqual(store.state.get().draft.values.env, { TOKEN: "s3cret" });
  assert.equal(store.state.get().revealed.has("env"), true);
  const fresh = setup();
  assert.equal(await fresh.store.reveal("env"), false);
  const broken = setup({ initial: filled(), originalName: "broken" });
  assert.equal(await broken.store.reveal("headers"), false);
  assert.match(broken.store.state.get().revealError!, /没有权限/);
});

test("手动检查命令：带上工作目录；结果写进状态", async () => {
  const { store, calls } = setup({ initial: withField(filled(), "cwd", "D:/work") });
  await store.checkCommand();
  assert.deepEqual(calls, ["check node @D:/work"]);
  assert.equal(store.state.get().commandCheck?.found, true);
  assert.equal(store.state.get().checking, false);
});
