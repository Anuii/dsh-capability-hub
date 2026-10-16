/**
 * 提示词页的数据与写操作（ADR-0005）：列表、回收站，以及查看 / 保存 / 新建 / 启停 / 恢复 / 清空。
 *
 * 规则都在这里（组件只管抽屉、对话框与 Toast）：
 *   - 保存带上打开时拿到的内容版本做冲突检测；宿主返回 409 CONFLICT 时把「文件已在别处修改」
 *     记进文档状态，界面据此显示错误与「重新加载」，绝不用旧内容覆盖别人的改动；
 *   - 新建 / 启停 / 恢复成功后重读列表与回收站（恢复会把当前内容送进回收站）；
 *   - 启停成功后只替换那一行（与技能页同一口径）；
 *   - 请求错误一律转成结果里的中文 message，绝不抛出。
 *
 * 数据访问经 PromptsAdapter：正式运行是 data.ts 的 promptsApi，单测是内存 fake。不 import React。
 */

import { createStore, type Store } from "../../kit/store.ts";
import type { FieldError } from "../../platform/contract/host.ts";
import type { PromptCreateLocation, PromptFile, PromptsListResult, PromptTrashItem } from "../contract/prompts.ts";
import { errorCodeOf, fieldErrorsOf } from "../../platform/client/api.ts";
import { errorText } from "../../shared/error-text.ts";
import { t } from "./strings.ts";

export interface PromptsAdapter {
  list(workspace: string | undefined): Promise<PromptsListResult>;
  view(id: string, workspace: string | undefined): Promise<{ file: PromptFile; content: string }>;
  save(id: string, content: string, baseVersion: string, workspace: string | undefined): Promise<PromptFile>;
  create(location: PromptCreateLocation, workspace: string | undefined): Promise<PromptFile>;
  setEnabled(id: string, enabled: boolean, workspace: string | undefined): Promise<PromptFile>;
  trash(): Promise<PromptTrashItem[]>;
  restore(trashId: string, workspace: string | undefined): Promise<PromptFile>;
  /** 不给 trashId = 清空；返回删掉的条数 */
  purge(trashId: string | undefined): Promise<number>;
}

/** 详情抽屉里正在看的那一份（内容、版本与冲突状态）。 */
export interface PromptDoc {
  file: PromptFile;
  /** 打开（或最近一次保存 / 重新加载）时的内容，界面据此判断「有没有改动」 */
  content: string;
  /** 保存时做冲突检测的内容版本 */
  version: string;
  loading: boolean;
  /** 读取或保存失败的原文 */
  error?: string;
  /** 保存时磁盘上的版本已经变了（409） */
  conflict: boolean;
}

/** 页面底部的一条提示（Toast）。seq 递增：同样的文字再提示一次也会重新出现。 */
export interface Notice {
  seq: number;
  text: string;
  tone?: "success";
}

export interface PromptsState {
  list?: PromptsListResult;
  listError?: string;
  loading: boolean;
  trash?: PromptTrashItem[];
  trashError?: string;
  trashLoading: boolean;
  /** 启停 / 新建在途的文件 id */
  busyIds: ReadonlySet<string>;
  /** 恢复 / 彻底删除在途的回收站条目 */
  trashBusyIds: ReadonlySet<string>;
  purgingAll: boolean;
  /** 正在看的那一份（没有打开就是 undefined） */
  doc?: PromptDoc;
  notice?: Notice;
}

/** 一次写操作的结果：message 是给 Toast / 对话框的一句中文。 */
export interface ActionResult {
  ok: boolean;
  message: string;
  fieldErrors: readonly FieldError[];
  /** 保存时文件在别处被改过（409） */
  conflict?: boolean;
  /** 新建成功时那一份文件（界面据此直接打开它） */
  file?: PromptFile;
}

export interface PromptsStore {
  readonly state: Store<PromptsState>;
  /** 换工作区（或第一次）：重读列表 */
  setWorkspace(workspace: string | undefined): void;
  reload(): Promise<void>;
  reloadTrash(): Promise<void>;
  reloadAll(): Promise<void>;
  /** 打开一份文件：读它的原文（列表里已有的文件先用列表里的元数据撑住界面） */
  open(id: string): Promise<void>;
  /** 保存冲突时「重新加载」：重读原文与版本 */
  reloadDoc(): Promise<void>;
  closeDoc(): void;
  /** 保存当前文档 */
  save(content: string): Promise<ActionResult>;
  create(location: PromptCreateLocation): Promise<ActionResult>;
  setEnabled(file: PromptFile, enabled: boolean): Promise<ActionResult>;
  restore(item: PromptTrashItem): Promise<ActionResult>;
  purgeOne(item: PromptTrashItem): Promise<ActionResult>;
  purgeAll(): Promise<ActionResult>;
  notify(text: string, tone?: "success"): void;
  /** 提示淡出后调用：只清掉还是这一条的提示 */
  dismiss(seq: number): void;
}

const ok = (message: string): ActionResult => ({ ok: true, message, fieldErrors: [] });
const failed = (failure: unknown): ActionResult => ({
  ok: false,
  message: t("prompts.action.failed", { message: errorText(failure) }),
  fieldErrors: fieldErrorsOf(failure),
});
const isConflict = (failure: unknown): boolean => errorCodeOf(failure) === "CONFLICT";

function withId(ids: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(ids);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/** 用宿主返回的那一份替换列表里的同名文件（列表里没有就原样返回，别的层的对象身份都不动）。 */
export function replaceFile(list: PromptsListResult, file: PromptFile): PromptsListResult {
  const at = list.layers.findIndex((layer) => layer.files.some((item) => item.id === file.id));
  if (at === -1) return list;
  const layers = list.layers.map((layer, index) =>
    index === at ? { ...layer, files: layer.files.map((item) => (item.id === file.id ? file : item)) } : layer,
  );
  return { ...list, layers };
}

export function createPromptsStore(adapter: PromptsAdapter): PromptsStore {
  const state = createStore<PromptsState>({
    loading: true,
    trashLoading: false,
    busyIds: new Set(),
    trashBusyIds: new Set(),
    purgingAll: false,
  });
  let workspace: string | undefined;
  /** 换工作区后，旧一轮的列表回应不覆盖新的 */
  let round = 0;
  let seq = 0;

  const notify = (text: string, tone?: "success"): void => {
    seq += 1;
    state.patch({ notice: { seq, text, ...(tone === undefined ? {} : { tone }) } });
  };
  const busy = (id: string, on: boolean): void => state.patch({ busyIds: withId(state.get().busyIds, id, on) });
  const trashBusy = (id: string, on: boolean): void =>
    state.patch({ trashBusyIds: withId(state.get().trashBusyIds, id, on) });
  const patchDoc = (change: Partial<PromptDoc>): void => {
    const doc = state.get().doc;
    if (doc !== undefined) state.patch({ doc: { ...doc, ...change } });
  };
  const updateList = (change: (list: PromptsListResult) => PromptsListResult): void => {
    const list = state.get().list;
    if (list !== undefined) state.patch({ list: change(list) });
  };

  const reload = async (): Promise<void> => {
    const mine = ++round;
    state.patch({ loading: true, listError: undefined });
    try {
      const list = await adapter.list(workspace);
      if (mine === round) state.patch({ list, loading: false });
    } catch (failure) {
      if (mine === round) state.patch({ listError: errorText(failure), loading: false });
    }
  };

  const reloadTrash = async (): Promise<void> => {
    state.patch({ trashLoading: true, trashError: undefined });
    try {
      state.patch({ trash: await adapter.trash(), trashLoading: false });
    } catch (failure) {
      state.patch({ trashError: errorText(failure), trashLoading: false });
    }
  };

  const reloadAll = async (): Promise<void> => {
    await Promise.all([reload(), reloadTrash()]);
  };

  /** 打开一份文件：先放一个 loading 的文档（元数据来自列表），再读原文。 */
  const loadDoc = async (file: PromptFile): Promise<void> => {
    state.patch({ doc: { file, content: "", version: file.version, loading: true, conflict: false } });
    try {
      const view = await adapter.view(file.id, workspace);
      const current = state.get().doc;
      // 读的过程中用户已经换了一份：丢掉这次的结果。
      if (current === undefined || current.file.id !== file.id) return;
      state.patch({
        doc: {
          file: view.file,
          content: view.content,
          version: view.file.version,
          loading: false,
          conflict: false,
        },
      });
      updateList((list) => replaceFile(list, view.file));
    } catch (failure) {
      const current = state.get().doc;
      if (current === undefined || current.file.id !== file.id) return;
      patchDoc({ loading: false, error: errorText(failure) });
    }
  };

  return {
    state,
    setWorkspace(next) {
      workspace = next;
      state.patch({ doc: undefined });
      void reload();
    },
    reload,
    reloadTrash,
    reloadAll,
    async open(id) {
      const file = (state.get().list?.layers ?? []).flatMap((layer) => layer.files).find((item) => item.id === id);
      if (file === undefined) return;
      await loadDoc(file);
    },
    async reloadDoc() {
      const doc = state.get().doc;
      if (doc === undefined) return;
      await loadDoc(doc.file);
    },
    closeDoc() {
      state.patch({ doc: undefined });
    },
    async save(content) {
      const doc = state.get().doc;
      if (doc === undefined) return failed(new Error(t("prompts.detail.notOpen")));
      patchDoc({ error: undefined, conflict: false });
      busy(doc.file.id, true);
      try {
        const file = await adapter.save(doc.file.id, content, doc.version, workspace);
        const current = state.get().doc;
        if (current !== undefined && current.file.id === file.id) {
          state.patch({ doc: { file, content, version: file.version, loading: false, conflict: false } });
        }
        updateList((list) => replaceFile(list, file));
        void reloadTrash();
        const message = t("prompts.detail.saved");
        notify(message, "success");
        return ok(message);
      } catch (failure) {
        const conflict = isConflict(failure);
        const current = state.get().doc;
        if (current !== undefined && current.file.id === doc.file.id) {
          patchDoc({ error: errorText(failure), conflict });
        }
        return conflict
          ? {
              ok: false,
              message: t("prompts.detail.conflict"),
              fieldErrors: fieldErrorsOf(failure),
              conflict: true,
            }
          : failed(failure);
      } finally {
        busy(doc.file.id, false);
      }
    },
    async create(location) {
      try {
        const file = await adapter.create(location, workspace);
        await reloadAll();
        return { ...ok(t("prompts.createDialog.done", { path: file.displayPath || file.path })), file };
      } catch (failure) {
        return isConflict(failure)
          ? {
              ok: false,
              message: t("prompts.createDialog.conflict"),
              fieldErrors: fieldErrorsOf(failure),
            }
          : failed(failure);
      }
    },
    async setEnabled(file, enabled) {
      busy(file.id, true);
      try {
        const updated = await adapter.setEnabled(file.id, enabled, workspace);
        updateList((list) => replaceFile(list, updated));
        const current = state.get().doc;
        if (current !== undefined && current.file.id === updated.id) patchDoc({ file: updated });
        const message = enabled
          ? t("prompts.toast.toggleOn", { name: file.name })
          : t("prompts.toast.toggleOff", { name: file.name });
        notify(message, "success");
        return ok(message);
      } catch (failure) {
        return failed(failure);
      } finally {
        busy(file.id, false);
      }
    },
    async restore(item) {
      trashBusy(item.trashId, true);
      try {
        await adapter.restore(item.trashId, workspace);
        await reloadAll();
        const doc = state.get().doc;
        if (doc !== undefined && doc.file.id === item.fileId) await loadDoc(doc.file);
        return ok(t("prompts.trash.restored", { path: item.displayPath }));
      } catch (failure) {
        return failed(failure);
      } finally {
        trashBusy(item.trashId, false);
      }
    },
    async purgeOne(item) {
      trashBusy(item.trashId, true);
      try {
        await adapter.purge(item.trashId);
        void reloadTrash();
        return ok(t("prompts.trash.purgedOne"));
      } catch (failure) {
        return failed(failure);
      } finally {
        trashBusy(item.trashId, false);
      }
    },
    async purgeAll() {
      state.patch({ purgingAll: true });
      try {
        const count = await adapter.purge(undefined);
        void reloadTrash();
        return ok(t("prompts.trash.purgedAll", { count }));
      } catch (failure) {
        return failed(failure);
      } finally {
        state.patch({ purgingAll: false });
      }
    },
    notify,
    dismiss(done) {
      if (state.get().notice?.seq === done) state.patch({ notice: undefined });
    },
  };
}
