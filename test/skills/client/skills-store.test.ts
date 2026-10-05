/**
 * skills-store.ts：技能页的数据与写操作。用内存 adapter，通过仓库的接口测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createSkillsStore, type SkillsAdapter } from "../../../src/skills/client/skills-store.ts";
import type { ListResult, SkillSummary, TrashItem } from "../../../src/skills/contract/local.ts";
import { makeList, makeSkill, makeTrashItem, root } from "./fixtures.ts";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 带 status / code / details 的错误（与 platform/client/api.ts 的 ApiError 同形）。 */
function apiError(code: string, message: string, details?: unknown): Error {
  return Object.assign(new Error(message), { code, status: code === "CONFLICT" ? 409 : 422, details });
}

function fake(overrides: Partial<SkillsAdapter> = {}): SkillsAdapter & { calls: string[] } {
  const calls: string[] = [];
  const a = makeSkill({ id: "user-agents:a", name: "a" });
  const b = makeSkill({ id: "user-agents:b", name: "b" });
  const base: SkillsAdapter = {
    list: async (workspace) => {
      calls.push("list:" + (workspace ?? ""));
      return makeList([root("user-agents")], [a, b]);
    },
    trash: async () => {
      calls.push("trash");
      return [makeTrashItem({ trashId: "t1", dirName: "old" })];
    },
    setEnabled: async (id, enabled) => {
      calls.push("set:" + id + ":" + String(enabled));
      return makeSkill({ id, name: id.split(":")[1], modelInvocationDisabled: !enabled });
    },
    remove: async (id) => {
      calls.push("remove:" + id);
      return makeTrashItem({ trashId: "t2", skillId: id });
    },
    restore: async (trashId, replace) => {
      calls.push("restore:" + trashId + ":" + String(replace));
      return makeSkill({ id: "user-agents:old", name: "old" });
    },
    purge: async (trashId) => {
      calls.push("purge:" + (trashId ?? "*"));
      return 3;
    },
  };
  return Object.assign({ ...base, ...overrides }, { calls });
}

async function loaded(adapter: SkillsAdapter) {
  const store = createSkillsStore(adapter);
  store.setWorkspace("D:\\work");
  await flush();
  return store;
}

test("加载：按工作区读列表；读失败记错误；换工作区后旧回应不覆盖新的", async () => {
  const adapter = fake();
  const store = await loaded(adapter);
  assert.equal(store.state.get().loading, false);
  assert.equal(store.state.get().list?.skills.length, 2);
  assert.deepEqual(adapter.calls, ["list:D:\\work"]);

  const broken = await loaded(fake({ list: async () => Promise.reject(new Error("宿主没响应")) }));
  assert.equal(broken.state.get().listError, "宿主没响应");

  let release: (value: ListResult) => void = () => undefined;
  let first = true;
  const racing = createSkillsStore(
    fake({
      list: (workspace) =>
        first
          ? ((first = false), new Promise<ListResult>((resolve) => (release = resolve)))
          : Promise.resolve(
              makeList([root("user-agents")], [makeSkill({ id: "user-agents:" + workspace, name: "n" })]),
            ),
    }),
  );
  racing.setWorkspace("old");
  racing.setWorkspace("new");
  await flush();
  release(makeList([], []));
  await flush();
  assert.deepEqual(
    racing.state.get().list?.skills.map((skill) => skill.id),
    ["user-agents:new"],
  );
});

test("启停：成功后只替换那一行，在途时置灰；失败给中文原因、列表不动", async () => {
  const store = await loaded(fake());
  const a = store.state.get().list!.skills[0] as SkillSummary;
  const pending = store.toggle(a, false);
  assert.equal(store.state.get().busyIds.has(a.id), true, "在途时开关置灰");
  const result = await pending;
  assert.deepEqual(result, { ok: true, message: "已停用「a」", fieldErrors: [] });
  const after = store.state.get().list!.skills;
  assert.equal(after[0]!.modelInvocationDisabled, true);
  assert.equal(after[1], store.state.get().list!.skills[1], "别的行原样不动");
  assert.equal(store.state.get().busyIds.size, 0);

  const failing = await loaded(fake({ setEnabled: async () => Promise.reject(new Error("文件被占用")) }));
  const r = await failing.toggle(a, false);
  assert.equal(r.ok, false);
  assert.equal(r.message, "操作失败：文件被占用");
  assert.equal(failing.state.get().list!.skills[0]!.modelInvocationDisabled, false);
});

test("删除：成功后摘掉那一行并重读回收站；校验失败把逐字段错误交给对话框", async () => {
  const adapter = fake();
  const store = await loaded(adapter);
  const a = store.state.get().list!.skills[0] as SkillSummary;
  const result = await store.remove(a);
  await flush();
  assert.equal(result.ok, true);
  assert.deepEqual(
    store.state.get().list!.skills.map((skill) => skill.id),
    ["user-agents:b"],
  );
  assert.ok(adapter.calls.includes("trash"), "删除后回收站计数要跟上");

  const invalid = await loaded(
    fake({
      remove: async () =>
        Promise.reject(apiError("VALIDATION", "参数校验未通过", [{ path: "id", message: "id 不能为空" }])),
    }),
  );
  const bad = await invalid.remove(a);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.fieldErrors, [{ path: "id", message: "id 不能为空" }]);
});

test("恢复：默认不覆盖；同名冲突时返回 conflict 再问一次；覆盖时不再报冲突；成功后列表与回收站都重读", async () => {
  const item: TrashItem = makeTrashItem({ trashId: "t1", dirName: "old", name: "old" });
  const conflicting = await loaded(fake({ restore: async () => Promise.reject(apiError("CONFLICT", "已有同名技能")) }));
  const first = await conflicting.restore(item, false);
  assert.equal(first.conflict, true);
  const forced = await conflicting.restore(item, true);
  assert.equal(forced.conflict, undefined, "选择覆盖后再失败就只报错");

  const adapter = fake();
  const store = await loaded(adapter);
  adapter.calls.length = 0;
  const done = await store.restore(item, false);
  await flush();
  assert.equal(done.message, "已恢复「old」。");
  assert.deepEqual(adapter.calls.sort(), ["list:D:\\work", "restore:t1:false", "trash"]);
});

test("彻底删除：单条与全部；全部时给出删掉的条数", async () => {
  const adapter = fake();
  const store = await loaded(adapter);
  const one = await store.purgeOne(makeTrashItem({ trashId: "t1" }));
  assert.equal(one.ok, true);
  const all = await store.purgeAll();
  assert.equal(all.message, "已清空回收站（3 条）。");
  assert.equal(store.state.get().purgingAll, false);
  assert.ok(adapter.calls.includes("purge:t1") && adapter.calls.includes("purge:*"));
});
