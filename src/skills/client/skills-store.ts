/**
 * 技能页的数据与写操作（ADR-0005）：技能列表、回收站，以及启停 / 删除 / 恢复 / 彻底删除。
 *
 * 规则都在这里（组件只管对话框与 Toast）：
 *   - 启停成功后只替换那一行（验收 U2）；在途的技能开关置灰；
 *   - 删除成功后从列表摘掉那一行并重读回收站；VALIDATION 的逐字段错误交给对话框；
 *   - 恢复默认不覆盖，同名冲突时返回 conflict 让界面再问一次；恢复后列表与回收站都重读；
 *   - 请求错误一律转成结果里的中文 message，绝不抛出。
 *
 * 数据访问经 SkillsAdapter：正式运行是 data.ts 的 skillsApi，单测是内存 fake。不 import React。
 */

import { createStore, type Store } from "../../kit/store.ts";
import type { FieldError } from "../../platform/contract/host.ts";
import type { ListResult, SkillSummary, TrashItem } from "../contract/local.ts";
import { displayName, errorMessage, fieldErrors, isConflict, removeSkill, replaceSkill } from "./format.ts";
import { t } from "./strings.ts";

export interface SkillsAdapter {
  list(workspace: string | undefined): Promise<ListResult>;
  trash(): Promise<TrashItem[]>;
  setEnabled(id: string, enabled: boolean, workspace: string | undefined): Promise<SkillSummary>;
  remove(id: string, workspace: string | undefined): Promise<TrashItem>;
  restore(trashId: string, replace: boolean, workspace: string | undefined): Promise<SkillSummary>;
  /** 不给 trashId = 清空全部；返回删掉的条数 */
  purge(trashId: string | undefined): Promise<number>;
}

export interface SkillsState {
  list?: ListResult;
  listError?: string;
  loading: boolean;
  trash?: TrashItem[];
  trashError?: string;
  trashLoading: boolean;
  /** 启停 / 删除在途的技能 id */
  busyIds: ReadonlySet<string>;
  /** 恢复 / 彻底删除在途的回收站条目 */
  trashBusyIds: ReadonlySet<string>;
  purgingAll: boolean;
}

/** 一次写操作的结果：message 是给 Toast 的一句中文。 */
export interface ActionResult {
  ok: boolean;
  message: string;
  /** VALIDATION 的逐字段错误（对话框里显示） */
  fieldErrors: readonly FieldError[];
  /** 恢复时目标位置已有同名技能（界面再问一次是否覆盖） */
  conflict?: boolean;
}

export interface SkillsStore {
  readonly state: Store<SkillsState>;
  /** 换工作区（或第一次）：重读列表 */
  setWorkspace(workspace: string | undefined): void;
  reload(): Promise<void>;
  reloadTrash(): Promise<void>;
  /** 来源 / 更新 / 安装这类写操作之后：列表与回收站都重读 */
  reloadAll(): Promise<void>;
  toggle(skill: SkillSummary, enabled: boolean): Promise<ActionResult>;
  remove(skill: SkillSummary): Promise<ActionResult>;
  restore(item: TrashItem, replace: boolean): Promise<ActionResult>;
  purgeOne(item: TrashItem): Promise<ActionResult>;
  purgeAll(): Promise<ActionResult>;
}

const ok = (message: string): ActionResult => ({ ok: true, message, fieldErrors: [] });
const failed = (failure: unknown): ActionResult => ({
  ok: false,
  message: t("skills.toast.failed", { message: errorMessage(failure) }),
  fieldErrors: fieldErrors(failure),
});

function withId(ids: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(ids);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

export function createSkillsStore(adapter: SkillsAdapter): SkillsStore {
  const state = createStore<SkillsState>({
    loading: true,
    trashLoading: false,
    busyIds: new Set(),
    trashBusyIds: new Set(),
    purgingAll: false,
  });
  let workspace: string | undefined;
  /** 换工作区后，旧一轮的列表回应不覆盖新的 */
  let round = 0;

  const busy = (id: string, on: boolean): void => state.patch({ busyIds: withId(state.get().busyIds, id, on) });
  const trashBusy = (id: string, on: boolean): void =>
    state.patch({ trashBusyIds: withId(state.get().trashBusyIds, id, on) });
  const updateList = (change: (list: ListResult) => ListResult): void => {
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
      if (mine === round) state.patch({ listError: errorMessage(failure), loading: false });
    }
  };

  const reloadTrash = async (): Promise<void> => {
    state.patch({ trashLoading: true, trashError: undefined });
    try {
      state.patch({ trash: await adapter.trash(), trashLoading: false });
    } catch (failure) {
      state.patch({ trashError: errorMessage(failure), trashLoading: false });
    }
  };

  const reloadAll = async (): Promise<void> => {
    await Promise.all([reload(), reloadTrash()]);
  };

  return {
    state,
    setWorkspace(next) {
      workspace = next;
      void reload();
    },
    reload,
    reloadTrash,
    reloadAll,
    async toggle(skill, enabled) {
      const name = displayName(skill).text;
      busy(skill.id, true);
      try {
        const updated = await adapter.setEnabled(skill.id, enabled, workspace);
        updateList((list) => replaceSkill(list, updated));
        return ok(enabled ? t("skills.toast.toggleOn", { name }) : t("skills.toast.toggleOff", { name }));
      } catch (failure) {
        return failed(failure);
      } finally {
        busy(skill.id, false);
      }
    },
    async remove(skill) {
      const name = displayName(skill).text;
      busy(skill.id, true);
      try {
        await adapter.remove(skill.id, workspace);
        updateList((list) => removeSkill(list, skill.id));
        void reloadTrash();
        return ok(t("skills.delete.done", { name }));
      } catch (failure) {
        return failed(failure);
      } finally {
        busy(skill.id, false);
      }
    },
    async restore(item, replace) {
      trashBusy(item.trashId, true);
      try {
        await adapter.restore(item.trashId, replace, workspace);
        void reloadAll();
        return ok(t("skills.trash.restored", { name: item.name ?? item.dirName }));
      } catch (failure) {
        return { ...failed(failure), ...(!replace && isConflict(failure) ? { conflict: true } : {}) };
      } finally {
        trashBusy(item.trashId, false);
      }
    },
    async purgeOne(item) {
      trashBusy(item.trashId, true);
      try {
        await adapter.purge(item.trashId);
        void reloadTrash();
        return ok(t("skills.trash.purgedOne"));
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
        return ok(t("skills.trash.purgedAll", { count }));
      } catch (failure) {
        return failed(failure);
      } finally {
        state.patch({ purgingAll: false });
      }
    },
  };
}
