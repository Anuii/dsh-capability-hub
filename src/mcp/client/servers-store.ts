/**
 * MCP 页的服务器列表仓库（ADR-0005）：配置的读取与写操作、保存后的跟进、页面提示。
 *
 * 规则都在这里（组件只管抽屉、对话框的开合与渲染）：
 *   - 启停：在途的服务器开关置灰；成功后只替换那一行；
 *   - 排序：拖动后整表换成宿主返回的新顺序；
 *   - 删除：有在途标记，完成后给一句提示；
 *   - 保存一个服务器后重读列表，给一句中性的「已保存」（0.9.0 起页面上没有运行状态，
 *     所以**不等连接结果、也不按连接状态出提示**）；批量保存（粘贴 JSON）只出一条汇总提示，
 *     免得多条提示互相遮挡；
 *   - 请求错误一律转成提示里的中文，绝不抛出。
 *
 * 配置经 ServersAdapter 访问（正式运行是 data.ts 的 serversApi，单测是内存 fake）。
 * 连接是宿主与官方 MCP 插件的事：连不上只记在 GET health 的 mcpServers 里，要重试就重启 DSH。
 * 本文件不 import React。
 */

import { createStore, type Store } from "../../kit/store.ts";
import { reorderNames } from "./view-model.ts";
import { t } from "./strings.ts";
import { errorText } from "../../shared/error-text.ts";
import type { ConfigPayload, ServerScope, ServerView } from "../contract/config.ts";
import { serverJsonValues } from "./json-model.ts";

export interface ServersAdapter {
  load(): Promise<ConfigPayload>;
  toggle(name: string, disabled: boolean): Promise<ServerView>;
  reorder(names: readonly string[]): Promise<ServerView[]>;
  remove(name: string): Promise<void>;
  /** 整条写回（改进程归属用：只带显式设置过的字段，与服务端一致的 upsert 语义）。 */
  upsert(name: string, values: Record<string, unknown>): Promise<ServerView>;
}

/** 页面底部的一条提示（Toast）。seq 递增：同样的文字再提示一次也会重新出现。 */
export interface Notice {
  seq: number;
  text: string;
  tone?: "success";
}

export interface ServersState {
  config?: ConfigPayload;
  loadError?: string;
  loading: boolean;
  /** 启停在途的服务器名 */
  busy: ReadonlySet<string>;
  deleting: boolean;
  notice?: Notice;
}

export interface ServersStore {
  readonly state: Store<ServersState>;
  /** 重读配置 */
  reload(): Promise<void>;
  toggle(view: ServerView, disabled: boolean): Promise<void>;
  /** 把 from 位置的服务器挪到 to */
  move(from: number, to: number): Promise<void>;
  /** 删除；成功返回 true（界面据此关掉指向它的抽屉） */
  remove(name: string): Promise<boolean>;
  /** 改进程归属：全局一份 ↔ 按会话（仍然只走 upsert，不新增接口）。 */
  setScope(view: ServerView, scope: ServerScope): Promise<void>;
  /** JSON 编辑保存了一个服务器 */
  serverSaved(server: ServerView, warnings: readonly string[]): void;
  /** 粘贴 JSON 批量保存之后 */
  batchSaved(names: readonly string[]): void;
  /** 子视图自己的提示（例如复制成功） */
  notify(text: string, tone?: "success"): void;
  /** 提示淡出后调用：只清掉还是这一条的提示 */
  dismiss(seq: number): void;
}

function withName(names: ReadonlySet<string>, name: string, on: boolean): ReadonlySet<string> {
  const next = new Set(names);
  if (on) next.add(name);
  else next.delete(name);
  return next;
}

export function createServersStore(adapter: ServersAdapter): ServersStore {
  const state = createStore<ServersState>({ loading: true, busy: new Set(), deleting: false });
  let seq = 0;

  const notify = (text: string, tone?: "success"): void => {
    seq += 1;
    state.patch({ notice: { seq, text, ...(tone === undefined ? {} : { tone }) } });
  };
  const failed = (failure: unknown): void => notify(t("mcp.toast.failed", { message: errorText(failure) }));
  const updateConfig = (change: (config: ConfigPayload) => ConfigPayload): void => {
    const config = state.get().config;
    if (config !== undefined) state.patch({ config: change(config) });
  };

  const reload = async (): Promise<void> => {
    state.patch({ loading: true, loadError: undefined });
    try {
      state.patch({ config: await adapter.load(), loading: false });
    } catch (failure) {
      state.patch({ loadError: errorText(failure), loading: false });
    }
  };

  return {
    state,
    reload,
    async toggle(view, disabled) {
      const name = view.serverName;
      state.patch({ busy: withName(state.get().busy, name, true) });
      try {
        const server = await adapter.toggle(name, disabled);
        updateConfig((config) => ({
          ...config,
          servers: config.servers.map((item) => (item.serverName === server.serverName ? server : item)),
        }));
        notify(disabled ? t("mcp.toast.toggleOff", { name }) : t("mcp.toast.toggleOn", { name }), "success");
      } catch (failure) {
        failed(failure);
      } finally {
        state.patch({ busy: withName(state.get().busy, name, false) });
      }
    },
    async move(from, to) {
      const names = (state.get().config?.servers ?? []).map((server) => server.serverName);
      try {
        const servers = await adapter.reorder(reorderNames(names, from, to));
        updateConfig((config) => ({ ...config, servers }));
        notify(t("mcp.toast.reordered"), "success");
      } catch (failure) {
        failed(failure);
      }
    },
    async setScope(view, scope) {
      const name = view.serverName;
      if (view.scope === scope) return;
      state.patch({ busy: withName(state.get().busy, name, true) });
      try {
        // 只搬显式设置过的字段（与 JSON 编辑同一份白名单），再覆盖 scope：服务端按 upsert 语义整条写回。
        const values = { ...serverJsonValues(view), scope };
        const server = await adapter.upsert(name, values);
        updateConfig((config) => ({
          ...config,
          servers: config.servers.map((item) => (item.serverName === server.serverName ? server : item)),
        }));
        notify(scope === "session" ? t("mcp.toast.scopeSession") : t("mcp.toast.scopeGlobal"), "success");
      } catch (failure) {
        failed(failure);
      } finally {
        state.patch({ busy: withName(state.get().busy, name, false) });
      }
    },
    async remove(name) {
      state.patch({ deleting: true });
      try {
        await adapter.remove(name);
        void reload();
        notify(t("mcp.delete.done", { name }), "success");
        return true;
      } catch (failure) {
        failed(failure);
        return false;
      } finally {
        state.patch({ deleting: false });
      }
    },
    serverSaved(server, warnings) {
      void reload();
      if (warnings.length > 0) notify(warnings.join("；"));
      else notify(t("mcp.toast.saved", { name: server.serverName }), "success");
    },
    batchSaved(names) {
      if (names.length === 0) return;
      void reload();
      notify(t("mcp.paste.savedMany", { count: names.length }), "success");
    },
    notify,
    dismiss(done) {
      if (state.get().notice?.seq === done) state.patch({ notice: undefined });
    },
  };
}
