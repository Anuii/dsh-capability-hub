/**
 * MCP 页的服务器列表仓库（ADR-0005）：配置的读取与写操作、保存后的跟进、页面提示。
 *
 * 规则都在这里（组件只管抽屉、对话框的开合与渲染）：
 *   - 启停：在途的服务器开关置灰；成功后只替换那一行；
 *   - 排序：拖动后整表换成宿主返回的新顺序；
 *   - 删除、重新连接：各有在途标记，完成后给一句提示；
 *   - 保存一个服务器后重读列表，等连接结果出来再提示「已连接 · N 个工具」或失败原因；
 *     批量保存（粘贴 JSON）时只出一条汇总提示，免得多条提示互相遮挡；
 *   - 请求错误一律转成提示里的中文，绝不抛出。
 *
 * 配置经 ServersAdapter 访问（正式运行是 data.ts 的 serversApi，单测是内存 fake）；运行状态相关的动作
 * 交给同一页的运行状态仓库（runtime-store.ts）。本文件不 import React。
 */

import { createStore, type Store } from "../../kit/store.ts";
import { reorderNames } from "./view-model.ts";
import { t } from "./strings.ts";
import { errorText } from "../../shared/error-text.ts";
import type { ConfigPayload, ServerView } from "../contract/config.ts";
import type { RuntimeServerView } from "../contract/runtime.ts";
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
  /** 正在重新连接的服务器名 */
  reconnecting?: string;
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
  reconnect(name: string): Promise<void>;
  /** JSON 编辑保存了一个服务器 */
  serverSaved(server: ServerView, warnings: readonly string[]): void;
  /** 粘贴 JSON 批量保存之后 */
  batchSaved(names: readonly string[]): void;
  /** 子视图自己的提示（例如复制成功） */
  notify(text: string, tone?: "success"): void;
  /** 提示淡出后调用：只清掉还是这一条的提示 */
  dismiss(seq: number): void;
}

type RuntimeActions = Pick<RuntimeStore, "reload" | "reconnect" | "waitSettled">;

function withName(names: ReadonlySet<string>, name: string, on: boolean): ReadonlySet<string> {
  const next = new Set(names);
  if (on) next.add(name);
  else next.delete(name);
  return next;
}

/** 一行连接结果的提示文字；成功返回 tone=success。 */
function connectNotice(name: string, row: RuntimeServerView | undefined): { text: string; tone?: "success" } {
  if (row === undefined) return { text: t("mcp.toast.connectPending", { name }) };
  if (row.state === "connected")
    return { text: t("mcp.toast.connected", { name, count: row.tools.length }), tone: "success" };
  if (row.state === "session") return { text: t("mcp.toast.sessionSaved", { name }), tone: "success" };
  if (row.state === "failed") return { text: t("mcp.toast.connectFailed", { name, message: row.error ?? "" }) };
  return { text: t("mcp.toast.connectPending", { name }) };
}

export function createServersStore(adapter: ServersAdapter, runtime: RuntimeActions): ServersStore {
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
    void runtime.reload(false);
    try {
      state.patch({ config: await adapter.load(), loading: false });
    } catch (failure) {
      state.patch({ loadError: errorText(failure), loading: false });
    }
  };

  /** 等连接结果再提示。 */
  const followConnect = (name: string): void => {
    void runtime.waitSettled(name).then((row) => {
      const notice = connectNotice(name, row);
      notify(notice.text, notice.tone);
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
        void runtime.reload(true);
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
    async reconnect(name) {
      state.patch({ reconnecting: name });
      try {
        const row = await runtime.reconnect(name);
        const notice = connectNotice(name, row);
        notify(notice.text, notice.tone);
      } catch (failure) {
        notify(t("mcp.toast.reconnectFailed", { name, message: errorText(failure) }));
      } finally {
        state.patch({ reconnecting: undefined });
      }
    },
    serverSaved(server, warnings) {
      void reload();
      if (warnings.length > 0) notify(warnings.join("；"));
      if (server.disabled) {
        if (warnings.length === 0) notify(t("mcp.toast.saved", { name: server.serverName }), "success");
        return;
      }
      followConnect(server.serverName);
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
