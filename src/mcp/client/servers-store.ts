/**
 * MCP 页的服务器列表仓库（ADR-0005）：配置的读取与写操作、保存后的跟进、页面提示。
 *
 * 规则都在这里（组件只管抽屉、对话框的开合与渲染）：
 *   - 启停：在途的服务器开关置灰；成功后只替换那一行；
 *   - 排序：拖动后整表换成宿主返回的新顺序；
 *   - 删除、刷新缓存、断开全部实例：各有在途标记，完成后给一句提示；
 *   - 保存一个服务器后重读列表，并等后台探测把工具数写进缓存再提示（D-C6）；
 *     批量保存（粘贴 JSON / 导入）时探测静默进行，只出一条汇总提示，免得多条提示互相遮挡；
 *   - 请求错误一律转成提示里的中文，绝不抛出。
 *
 * 配置经 ServersAdapter 访问（正式运行是 data.ts 的 serversApi，单测是内存 fake）；运行状态相关的动作
 * 交给同一页的运行状态仓库（runtime-store.ts）。本文件不 import React。
 */

import { createStore, type Store } from "../../kit/store.ts";
import { reorderNames } from "./view-model.ts";
import { t } from "./strings.ts";
import { errorText } from "../../shared/error-text.ts";
import type { ConfigPayload, McpSettings, ServerView } from "../contract/config.ts";
import type { RuntimeStore } from "./runtime-store.ts";

export interface ServersAdapter {
  load(): Promise<ConfigPayload>;
  toggle(name: string, disabled: boolean): Promise<ServerView>;
  reorder(names: readonly string[]): Promise<ServerView[]>;
  remove(name: string): Promise<void>;
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
  /** 正在刷新工具缓存的服务器名 */
  refreshing?: string;
  disconnecting: boolean;
  notice?: Notice;
}

export interface ServersStore {
  readonly state: Store<ServersState>;
  /** 重读配置（运行状态也顺带重读一次） */
  reload(): Promise<void>;
  toggle(view: ServerView, disabled: boolean): Promise<void>;
  /** 把 from 位置的服务器挪到 to */
  move(from: number, to: number): Promise<void>;
  /** 删除；成功返回 true（界面据此关掉指向它的抽屉） */
  remove(name: string): Promise<boolean>;
  refreshCache(name: string): Promise<void>;
  /** 断开该服务器在全部会话里的实例 */
  disconnectAll(name: string): Promise<void>;
  /** 表单 / JSON 保存了一个服务器 */
  serverSaved(server: ServerView, warnings: readonly string[]): void;
  /** 批量保存之后；summary = 是否由这里出一条「已添加 N 个」的汇总提示 */
  batchSaved(names: readonly string[], summary: boolean): void;
  settingsSaved(settings: McpSettings, settingsSet: readonly string[]): void;
  /** 子视图自己的提示（例如复制成功） */
  notify(text: string, tone?: "success"): void;
  /** 提示淡出后调用：只清掉还是这一条的提示 */
  dismiss(seq: number): void;
}

type RuntimeActions = Pick<RuntimeStore, "reload" | "refresh" | "disconnect" | "waitForTools">;

function withName(names: ReadonlySet<string>, name: string, on: boolean): ReadonlySet<string> {
  const next = new Set(names);
  if (on) next.add(name);
  else next.delete(name);
  return next;
}

export function createServersStore(adapter: ServersAdapter, runtime: RuntimeActions): ServersStore {
  const state = createStore<ServersState>({ loading: true, busy: new Set(), deleting: false, disconnecting: false });
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
    void runtime.reload(false);
    try {
      state.patch({ config: await adapter.load(), loading: false });
    } catch (failure) {
      state.patch({ loadError: errorText(failure), loading: false });
    }
  };

  /** 等后台探测把工具数写进缓存；silent 时不提示。 */
  const probeTools = (name: string, silent: boolean): void => {
    void runtime.waitForTools(name).then((count) => {
      if (silent) return;
      if (count === undefined) notify(t("mcp.form.probeTimeout", { name }));
      else notify(t("mcp.form.savedWithTools", { name, count }), "success");
    });
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
    async refreshCache(name) {
      state.patch({ refreshing: name });
      try {
        const result = await runtime.refresh(name);
        notify(t("mcp.detail.refreshOk", { name, count: result.toolCount }), "success");
      } catch (failure) {
        notify(t("mcp.detail.refreshFailed", { name, message: errorText(failure) }));
      } finally {
        state.patch({ refreshing: undefined });
      }
    },
    async disconnectAll(name) {
      state.patch({ disconnecting: true });
      try {
        const result = await runtime.disconnect(name);
        if (result.closed === 0) notify(t("mcp.detail.disconnectNone", { name }));
        else notify(t("mcp.detail.disconnectOk", { name, count: result.closed }), "success");
      } catch (failure) {
        notify(t("mcp.detail.disconnectFailed", { name, message: errorText(failure) }));
      } finally {
        state.patch({ disconnecting: false });
      }
    },
    serverSaved(server, warnings) {
      void reload();
      notify(warnings.length > 0 ? warnings.join("；") : t("mcp.form.saved", { name: server.serverName }), "success");
      probeTools(server.serverName, false);
    },
    batchSaved(names, summary) {
      if (names.length === 0) return;
      void reload();
      for (const name of names) probeTools(name, true);
      if (summary) notify(t("mcp.paste.savedMany", { count: names.length }), "success");
    },
    settingsSaved(settings, settingsSet) {
      updateConfig((config) => ({ ...config, settings, settingsSet: [...settingsSet] }));
      notify(t("mcp.settings.saved"), "success");
    },
    notify,
    dismiss(done) {
      if (state.get().notice?.seq === done) state.patch({ notice: undefined });
    },
  };
}
