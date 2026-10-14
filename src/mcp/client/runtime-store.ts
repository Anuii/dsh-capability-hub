/**
 * MCP 页的运行状态仓库（ADR-0005）：GET mcp/runtime 的唯一读取处。
 *
 * 服务器行的状态点与工具数、详情抽屉的状态与工具清单、「MCP」标签旁的红点都读同一份快照；
 * 重新连接之后它自己重读，调用方不必再互相通知。
 *
 *   const store = createRuntimeStore(runtimeApi);      // data.ts 的 HTTP adapter
 *   const stop = store.startPolling();                 // 每 5 秒一次，页面不可见时跳过
 *   const { status, error, pollError } = useStoreState(store.state);
 *
 * 数据访问经 RuntimeAdapter：正式运行是 HTTP（data.ts 的 runtimeApi），单测是内存 fake。本文件不 import React、不发请求。
 */

import { createStore, type Store } from "../../kit/store.ts";
import type { RuntimeServerView, RuntimeStatus } from "../contract/runtime.ts";
import { errorText } from "../../shared/error-text.ts";

/** 访问宿主运行时的 seam。 */
export interface RuntimeAdapter {
  status(): Promise<RuntimeStatus>;
  reconnect(name: string): Promise<RuntimeServerView>;
}

export interface RuntimeSnapshot {
  /** 最近一次成功读到的状态；还没读到时 undefined */
  status?: RuntimeStatus;
  /** 还没有任何数据时读取失败的原因 */
  error?: string;
  /** 已有数据后某次自动刷新失败（保留旧数据，只加一行提示） */
  pollError?: string;
}

/** 计时器（单测换成假的）。 */
export interface RuntimeTimers {
  every(ms: number, run: () => void): () => void;
  sleep(ms: number): Promise<void>;
  /** 页面不可见时跳过这一轮轮询 */
  hidden(): boolean;
}

export const POLL_INTERVAL_MS = 5000;
/** 保存后等连接结果：每 1 秒看一次，最多 15 次。 */
export const SETTLE_INTERVAL_MS = 1000;
export const SETTLE_ATTEMPTS = 15;

export interface RuntimeStore {
  readonly state: Store<RuntimeSnapshot>;
  /** 立即读一次。silent：失败时若已有数据只记 pollError（自动刷新与操作之后的重读用）。 */
  reload(silent?: boolean): Promise<void>;
  /** 重新连接某个服务器，然后重读。失败原样抛出。 */
  reconnect(name: string): Promise<RuntimeServerView>;
  /** 等某个服务器不再是「连接中」：返回那一行；超时（或一直读失败）返回 undefined。 */
  waitSettled(name: string): Promise<RuntimeServerView | undefined>;
  /** 开始轮询；返回停止函数。多处同时调用只共用一个计时器。 */
  startPolling(): () => void;
}

const realTimers: RuntimeTimers = {
  every(ms, run) {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  hidden: () => typeof document !== "undefined" && document.hidden,
};

export function createRuntimeStore(adapter: RuntimeAdapter, timers: RuntimeTimers = realTimers): RuntimeStore {
  const state = createStore<RuntimeSnapshot>({});
  let pollers = 0;
  let stopTimer: (() => void) | undefined;

  const reload = async (silent = false): Promise<void> => {
    if (!silent && state.get().error !== undefined) state.patch({ error: undefined });
    try {
      const status = await adapter.status();
      state.set({ status });
    } catch (failure) {
      const message = errorText(failure);
      if (silent && state.get().status !== undefined) state.patch({ pollError: message });
      else state.patch({ error: message });
    }
  };

  return {
    state,
    reload,
    async reconnect(name) {
      const result = await adapter.reconnect(name);
      await reload(true);
      return result;
    },
    async waitSettled(name) {
      for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
        await timers.sleep(SETTLE_INTERVAL_MS);
        try {
          const status = await adapter.status();
          state.set({ status });
          const row = status.servers.find((server) => server.name === name);
          if (row !== undefined && row.state !== "connecting") return row;
        } catch {
          // 连接期间读失败不算结束，下一轮再看
        }
      }
      return undefined;
    },
    startPolling() {
      pollers += 1;
      if (pollers === 1) {
        stopTimer = timers.every(POLL_INTERVAL_MS, () => {
          if (!timers.hidden()) void reload(true);
        });
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        pollers -= 1;
        if (pollers === 0) {
          stopTimer?.();
          stopTimer = undefined;
        }
      };
    },
  };
}

/** 把接口返回补成安全形状（缺字段给默认值、丢掉坏的条目）。 */
export function normalizeRuntimeStatus(data: Partial<RuntimeStatus> | undefined): RuntimeStatus {
  const servers = Array.isArray(data?.servers) ? data.servers : [];
  return {
    servers: servers
      .filter((server) => server !== null && typeof server === "object" && typeof server.name === "string")
      .map((server) => ({
        ...server,
        tools: Array.isArray(server.tools) ? server.tools.filter((tool) => typeof tool?.name === "string") : [],
        sessions: typeof server.sessions === "number" ? server.sessions : 0,
      })),
  };
}
