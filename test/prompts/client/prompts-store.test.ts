/**
 * prompts-store.ts：提示词页的读写、冲突处理与页面提示。用内存 fake 代替 HTTP。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createPromptsStore,
  docCanRevert,
  docCanSave,
  docDirty,
  replaceFile,
  type PromptsAdapter,
} from "../../../src/prompts/client/prompts-store.ts";
import { ApiError } from "../../../src/platform/client/api.ts";
import { makeFile, makeLayer, makeList } from "./fixtures.ts";
import type {
  PromptCreateLocation,
  PromptFile,
  PromptsListResult,
  PromptTrashItem,
} from "../../../src/prompts/contract/prompts.ts";

const GLOBAL_ID = "C:\\home\\.dsh\\AGENTS.md";
const PROJECT_ID = "C:\\proj\\AGENTS.md";

function makeTrash(overrides: Partial<PromptTrashItem> = {}): PromptTrashItem {
  return {
    trashId: "t1",
    fileId: GLOBAL_ID,
    displayPath: "~/.dsh/AGENTS.md",
    reason: "save",
    savedAt: "2026-10-16T10:00:00.000Z",
    size: 12,
    ...overrides,
  };
}

/** 内存 fake：列表、原文、回收站都在内存里，能按需制造冲突。 */
function setup() {
  const calls: string[] = [];
  let list: PromptsListResult = makeList({
    layers: [
      makeLayer({
        scope: "global",
        displayDir: "~/.dsh",
        isProjectRoot: false,
        canCreate: true,
        files: [makeFile({ id: GLOBAL_ID, path: GLOBAL_ID, displayPath: "~/.dsh/AGENTS.md" })],
      }),
      makeLayer({ files: [makeFile({ id: PROJECT_ID, path: PROJECT_ID, displayPath: "AGENTS.md" })] }),
    ],
  });
  let trash: PromptTrashItem[] = [makeTrash()];
  const contents = new Map<string, string>([[GLOBAL_ID, "旧内容"]]);
  let conflictOnSave = false;
  /** 回收站恢复写回的内容（默认与原文相同；单测可以改成别的一版）。 */
  let restoredContent = "旧内容";
  /**
   * 让下一次 view 挂起：单测用它模拟「读原文的请求还没回来」。
   * 走查实测到的缺陷正是这一段窗口里文本框是空的、而「保存」却是亮的。
   */
  let pendingView: Promise<void> | undefined;
  const adapter: PromptsAdapter = {
    async list() {
      calls.push("list");
      return list;
    },
    async view(id) {
      calls.push("view " + id);
      const file = list.layers.flatMap((layer) => layer.files).find((item) => item.id === id);
      if (file === undefined) throw new Error("找不到这一份提示词。");
      const answer = { file, content: contents.get(id) ?? "" };
      const gate = pendingView;
      if (gate !== undefined) {
        pendingView = undefined;
        await gate;
      }
      return answer;
    },
    async save(id, content, baseVersion) {
      calls.push("save " + id + " @" + baseVersion);
      if (conflictOnSave) throw new ApiError("CONFLICT", "文件已经在别处被修改。");
      const file = makeFile({
        id,
        path: id,
        displayPath: id === GLOBAL_ID ? "~/.dsh/AGENTS.md" : "AGENTS.md",
        size: content.length,
        version: "ffffffffffffffff",
      });
      contents.set(id, content);
      list = replaceFile(list, file);
      trash = [makeTrash({ trashId: "t" + String(trash.length + 1) }), ...trash];
      return file;
    },
    async create(location: PromptCreateLocation) {
      calls.push("create " + location);
      const file = makeFile({ id: PROJECT_ID, path: PROJECT_ID, displayPath: "AGENTS.md", size: 0 });
      list = {
        ...list,
        layers: list.layers.map((layer) => (layer.scope === "global" ? layer : { ...layer, files: [file] })),
      };
      return file;
    },
    async setEnabled(id, enabled) {
      calls.push("setEnabled " + id + " " + String(enabled));
      const file = makeFile({
        id,
        path: id,
        displayPath: id === GLOBAL_ID ? "~/.dsh/AGENTS.md" : "AGENTS.md",
        disabled: !enabled,
      });
      list = replaceFile(list, file);
      return file;
    },
    async trash() {
      calls.push("trash");
      return trash;
    },
    async restore(trashId) {
      calls.push("restore " + trashId);
      const file = makeFile({ id: GLOBAL_ID, path: GLOBAL_ID, displayPath: "~/.dsh/AGENTS.md" });
      contents.set(GLOBAL_ID, restoredContent);
      list = replaceFile(list, file);
      trash = [makeTrash({ trashId: "t-restore", reason: "restore" }), ...trash];
      return file;
    },
    async purge(trashId) {
      calls.push("purge " + String(trashId));
      if (trashId === undefined) {
        const count = trash.length;
        trash = [];
        return count;
      }
      trash = trash.filter((item) => item.trashId !== trashId);
      return 1;
    },
  };
  const store = createPromptsStore(adapter);
  return {
    store,
    calls,
    contents,
    setConflictOnSave: (value: boolean) => {
      conflictOnSave = value;
    },
    setTrash: (items: PromptTrashItem[]) => {
      trash = items;
    },
    currentList: () => list,
    setRestoreContent: (text: string) => {
      restoredContent = text;
    },
    /** 让下一次 view 挂起；返回放行它的函数。 */
    deferNextView: () => {
      let release = (): void => {};
      pendingView = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

const globalFile = (): PromptFile => makeFile({ id: GLOBAL_ID, path: GLOBAL_ID, displayPath: "~/.dsh/AGENTS.md" });

test("加载：成功后有列表与回收站；失败给中文原因", async () => {
  const { store } = setup();
  assert.equal(store.state.get().loading, true);
  store.setWorkspace("C:\\proj");
  await store.reloadAll();
  assert.equal(store.state.get().list?.layers.length, 2);
  assert.equal(store.state.get().trash?.length, 1);
  assert.equal(store.state.get().loading, false);

  const broken = createPromptsStore({
    ...({} as PromptsAdapter),
    list: async () => Promise.reject(new Error("接口 500")),
    trash: async () => Promise.reject(new Error("接口 500")),
  });
  await broken.reloadAll();
  assert.equal(broken.state.get().listError, "接口 500");
  assert.equal(broken.state.get().trashError, "接口 500");
  assert.equal(broken.state.get().loading, false);
});

test("打开：读到原文与版本；换工作区时关掉已打开的文档", async () => {
  const { store, calls } = setup();
  store.setWorkspace("C:\\proj");
  await store.reload();
  await store.open(GLOBAL_ID);
  assert.equal(store.state.get().doc?.content, "旧内容");
  assert.equal(store.state.get().doc?.draft, "旧内容", "原文到达时草稿要跟着换");
  assert.equal(store.state.get().doc?.loaded, true);
  assert.equal(store.state.get().doc?.version, "0123456789abcdef");
  assert.equal(store.state.get().doc?.loading, false);
  assert.equal(docDirty(store.state.get().doc!), false);
  assert.ok(calls.includes("view " + GLOBAL_ID));
  store.setWorkspace(undefined);
  assert.equal(store.state.get().doc, undefined);
});

test("保存成功：文档版本跟着换、提示「已保存，旧内容已放进回收站」、回收站重读", async () => {
  const { store, calls } = setup();
  store.setWorkspace("C:\\proj");
  await store.reload();
  await store.open(GLOBAL_ID);
  store.setDraft("新内容");
  assert.equal(docDirty(store.state.get().doc!), true);
  const result = await store.save();
  assert.equal(result.ok, true);
  assert.equal(result.message, "已保存，旧内容已放进回收站");
  assert.equal(store.state.get().doc?.content, "新内容");
  assert.equal(store.state.get().doc?.draft, "新内容", "保存成功后草稿就是刚写下去的内容");
  assert.equal(docDirty(store.state.get().doc!), false);
  assert.equal(store.state.get().doc?.version, "ffffffffffffffff");
  assert.equal(store.state.get().notice?.text, "已保存，旧内容已放进回收站");
  assert.equal(store.state.get().notice?.tone, "success");
  assert.equal(store.state.get().busyIds.has(GLOBAL_ID), false);
  assert.ok(calls.some((call) => call.startsWith("save " + GLOBAL_ID)));
  assert.ok(calls.includes("trash"), "保存后回收站要重读（旧内容已经进去了）");
});

test("保存冲突（409）：文档标记 conflict 并保留宿主原文，界面据此显示「重新加载」", async () => {
  const { store, setConflictOnSave } = setup();
  store.setWorkspace("C:\\proj");
  await store.reload();
  await store.open(GLOBAL_ID);
  setConflictOnSave(true);
  store.setDraft("我的改动");
  const result = await store.save();
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(result.message, "文件已在别处修改");
  assert.equal(store.state.get().doc?.conflict, true);
  assert.equal(store.state.get().doc?.error, "文件已经在别处被修改。");
  assert.equal(store.state.get().doc?.content, "旧内容", "冲突时原文不能变成没保存上的那一份");
  assert.equal(store.state.get().doc?.draft, "我的改动", "冲突时用户的草稿要留着，别丢");
  assert.equal(docCanSave(store.state.get().doc!, false), false, "冲突未解决前不能保存");
  // 重新加载：读回磁盘上的原文，冲突标记清掉、草稿跟着换回原文
  setConflictOnSave(false);
  await store.reloadDoc();
  assert.equal(store.state.get().doc?.conflict, false);
  assert.equal(store.state.get().doc?.content, "旧内容");
  assert.equal(store.state.get().doc?.draft, "旧内容");
  assert.equal(docCanSave(store.state.get().doc!, false), false);
});

test("草稿：原文到达前不可保存（走查实测的缺陷——文本框空着而「保存」是亮的）", async () => {
  const { store, deferNextView } = setup();
  store.setWorkspace("C:\\proj");
  await store.reload();
  const release = deferNextView();
  const opening = store.open(GLOBAL_ID);
  // 原文还没回来：草稿是空的，但绝不能允许保存——那会把文件写成空。
  assert.equal(store.state.get().doc?.loading, true);
  assert.equal(store.state.get().doc?.loaded, false);
  assert.equal(store.state.get().doc?.draft, "");
  assert.equal(docDirty(store.state.get().doc!), false);
  assert.equal(docCanSave(store.state.get().doc!, false), false, "原文没读到就不许保存");
  assert.equal(docCanRevert(store.state.get().doc!, false), false);
  release();
  await opening;
  // 原文到达：草稿同步换成原文，没有改动、也不能保存（列表里的 version 与磁盘相同，不能靠它判断）。
  assert.equal(store.state.get().doc?.loading, false);
  assert.equal(store.state.get().doc?.loaded, true);
  assert.equal(store.state.get().doc?.draft, "旧内容");
  assert.equal(store.state.get().doc?.content, "旧内容");
  assert.equal(docDirty(store.state.get().doc!), false);
  assert.equal(docCanSave(store.state.get().doc!, false), false, "没有改动就不能保存");
});

test("草稿：setDraft 后可保存、revert 回到原文；保存成功后草稿就是新内容", async () => {
  const { store } = setup();
  store.setWorkspace("C:\\proj");
  await store.reload();
  await store.open(GLOBAL_ID);
  store.setDraft("改了一行");
  assert.equal(docDirty(store.state.get().doc!), true);
  assert.equal(docCanSave(store.state.get().doc!, false), true);
  assert.equal(docCanRevert(store.state.get().doc!, false), true);
  assert.equal(docCanSave(store.state.get().doc!, true), false, "保存中不能重复点");
  store.revert();
  assert.equal(store.state.get().doc?.draft, "旧内容", "还原回到磁盘原文");
  assert.equal(docDirty(store.state.get().doc!), false);
  assert.equal(docCanSave(store.state.get().doc!, false), false);
  store.setDraft("再改一次");
  await store.save();
  assert.equal(store.state.get().doc?.draft, "再改一次");
  assert.equal(store.state.get().doc?.content, "再改一次");
  assert.equal(docDirty(store.state.get().doc!), false);
  assert.equal(docCanSave(store.state.get().doc!, false), false);
});

test("草稿：读取失败时不能保存（不能拿空内容覆盖磁盘上的文件）", async () => {
  const broken = createPromptsStore({
    ...({} as PromptsAdapter),
    view: async () => Promise.reject(new Error("读取失败")),
  });
  broken.state.patch({ list: makeList() });
  await broken.open("C:\\proj\\AGENTS.md");
  assert.equal(broken.state.get().doc?.loaded, false);
  assert.equal(broken.state.get().doc?.error, "读取失败");
  assert.equal(docCanSave(broken.state.get().doc!, false), false);
  broken.setDraft("随便写点什么");
  assert.equal(docCanSave(broken.state.get().doc!, false), false, "原文没读到，输入再多也不给保存");
  const result = await broken.save();
  assert.equal(result.ok, false, "store 也要拦住它（界面之外还有别的调用点）");
});

test("草稿：重新加载与回收站恢复之后都跟着宿主给的原文", async () => {
  const { store, setTrash, setRestoreContent } = setup();
  store.setWorkspace("C:\\proj");
  await store.reload();
  await store.open(GLOBAL_ID);
  store.setDraft("没保存的改动");
  await store.reloadDoc();
  assert.equal(store.state.get().doc?.draft, "旧内容", "重新加载丢掉未保存的草稿");
  // 回收站恢复：磁盘内容换成回收站里那一版，草稿跟着换。
  setRestoreContent("回收站里的那一版");
  setTrash([makeTrash({ trashId: "t9" })]);
  await store.reloadTrash();
  const item = store.state.get().trash?.[0];
  assert.ok(item !== undefined);
  await store.restore(item);
  assert.equal(store.state.get().doc?.content, "回收站里的那一版");
  assert.equal(store.state.get().doc?.draft, "回收站里的那一版");
  assert.equal(docDirty(store.state.get().doc!), false);
});

test("启停：成功后只替换那一行并给提示；失败给中文提示", async () => {
  const { store } = setup();
  store.setWorkspace("C:\\proj");
  await store.reload();
  const off = await store.setEnabled(globalFile(), false);
  assert.equal(off.ok, true);
  assert.equal(off.message, "已停用「AGENTS.md」");
  const row = store.state
    .get()
    .list?.layers.flatMap((layer) => layer.files)
    .find((file) => file.id === GLOBAL_ID);
  assert.equal(row?.disabled, true);
  assert.equal(store.state.get().busyIds.has(GLOBAL_ID), false);

  const broken = createPromptsStore({
    ...({} as PromptsAdapter),
    setEnabled: async () => Promise.reject(new Error("目标名已存在")),
  });
  broken.state.patch({ list: makeList() });
  const failed = await broken.setEnabled(globalFile(), true);
  assert.equal(failed.ok, false);
  assert.match(failed.message, /操作失败：目标名已存在/);
});

test("新建：成功后重读列表，并把新建的那一份带回来；已存在（409）给专用文案", async () => {
  const { store, calls } = setup();
  store.setWorkspace("C:\\proj");
  await store.reload();
  const created = await store.create("project-root");
  assert.equal(created.ok, true);
  assert.match(created.message, /已新建/);
  assert.equal(created.file?.id, PROJECT_ID);
  assert.ok(calls.filter((call) => call === "list").length >= 2);

  const conflict = createPromptsStore({
    ...({} as PromptsAdapter),
    create: async () => Promise.reject(new ApiError("CONFLICT", "已经有 AGENTS.md。")),
  });
  const result = await conflict.create("global");
  assert.equal(result.ok, false);
  assert.equal(result.message, "这个位置已经有 AGENTS.md 了");
});

test("回收站：恢复后列表与回收站都重读；彻底删除与清空各自重读", async () => {
  const { store, calls, setTrash } = setup();
  store.setWorkspace("C:\\proj");
  await store.reloadAll();
  const item = store.state.get().trash?.[0];
  assert.ok(item !== undefined);
  const restored = await store.restore(item);
  assert.equal(restored.ok, true);
  assert.match(restored.message, /已恢复/);
  assert.ok(calls.filter((call) => call === "trash").length >= 2, "恢复后回收站要重读");
  assert.equal(store.state.get().trashBusyIds.size, 0);

  setTrash([makeTrash({ trashId: "x1" }), makeTrash({ trashId: "x2" })]);
  await store.reloadTrash();
  const one = await store.purgeOne(makeTrash({ trashId: "x1" }));
  assert.equal(one.message, "已从回收站彻底删除 1 条");
  const all = await store.purgeAll();
  assert.equal(all.message, "已清空回收站（1 条）", "单条删掉之后只剩一条");
  assert.equal(store.state.get().purgingAll, false);
});

test("回收站恢复：成功后自己发提示「已恢复…」（界面不再自己补 Toast）", async () => {
  const { store, setTrash } = setup();
  store.setWorkspace("C:\\proj");
  await store.reloadAll();
  const item = store.state.get().trash?.[0];
  assert.ok(item !== undefined);
  const result = await store.restore(item);
  assert.equal(result.ok, true);
  assert.match(result.message, /已恢复/);
  assert.equal(store.state.get().notice?.text, result.message, "store 要把提示放进 notice");
  assert.match(store.state.get().notice?.text ?? "", /已恢复/);
  assert.equal(store.state.get().notice?.tone, "success");
  assert.equal(store.state.get().trashBusyIds.size, 0);
});

test("提示：同样的文字再提示一次会换一个 seq；dismiss 只清掉还是这一条", async () => {
  const { store } = setup();
  store.notify("第一句");
  const first = store.state.get().notice?.seq;
  store.notify("第二句");
  const second = store.state.get().notice?.seq;
  assert.notEqual(first, second);
  store.dismiss(first ?? 0);
  assert.equal(store.state.get().notice?.text, "第二句", "旧 seq 的 dismiss 不能清掉新提示");
  store.dismiss(second ?? 0);
  assert.equal(store.state.get().notice, undefined);
});

test("replaceFile：换掉同名文件；列表里没有就原样返回", () => {
  const list = makeList();
  const before = list.layers[0].files[0];
  const updated = makeFile({ id: before.id, path: before.path, disabled: true });
  const next = replaceFile(list, updated);
  assert.equal(next.layers[0].files[0].disabled, true);
  assert.equal(next.layers[1], list.layers[1], "别的层原样保留");
  assert.equal(replaceFile(list, makeFile({ id: "别的" })), list);
});
