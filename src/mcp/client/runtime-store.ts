/**
 * MCP 页的运行状态仓库（ADR-0005）：GET mcp/runtime 的唯一读取处。
 *
 * 服务器行的状态点与工具数、详情抽屉的工具缓存与实例数、底部「运行中」区域、「MCP」标签旁的红点
 * 都读同一份快照；刷新缓存、断开实例之后它自己重读，调用方不必再互相通知。
 *
 *   const store = createRuntimeStore(runtimeApi);      // data.ts 的 HTTP adapter
 *   const stop = store.startPolling();                 // 每 5 秒一次，页面不可见时跳过
 *   const { status, error, pollError } = useStoreState(store.state);
 *
 * 数据访问经 RuntimeAdapter：正式运行是 HTTP（data.ts 的 runtimeApi），开发预览是
 * previewAdapter（「运行中」用示例会话），单测是内存 fake。本文件不 import React、不发请求。
 */

import { createStore, type Store } from "../../kit/store.ts";
import type { RuntimeDisconnectResult, RuntimeRefreshResult, RuntimeStatus } from "../contract/runtime.ts";
import { errorText } from "../../shared/error-text.ts";

/** 访问宿主运行时的 seam。 */
export interface RuntimeAdapter {
  status(): Promise<RuntimeStatus>;
  refresh(name: string): Promise<RuntimeRefreshResult>;
  /** 省略 sessionId = 该服务器在全部会话里的实例 */
  disconnect(name: string, sessionId?: string): Promise<RuntimeDisconnectResult>;
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
/** 保存后等后台探测把工具数写进缓存（D-C6）：每 1.5 秒看一次，最多 6 次。 */
export const PROBE_INTERVAL_MS = 1500;
export const PROBE_ATTEMPTS = 6;

export interface RuntimeStore {
  readonly state: Store<RuntimeSnapshot>;
  /** 立即读一次。silent：失败时若已有数据只记 pollError（自动刷新与操作之后的重读用）。 */
  reload(silent?: boolean): Promise<void>;
  /** 刷新某个服务器的工具缓存，然后重读。失败原样抛出。 */
  refresh(name: string): Promise<RuntimeRefreshResult>;
  /** 断开实例，然后重读。失败原样抛出。 */
  disconnect(name: string, sessionId?: string): Promise<RuntimeDisconnectResult>;
  /** 等某个服务器的工具缓存出现：返回工具数；超时（或一直读失败）返回 undefined。 */
  waitForTools(name: string): Promise<number | undefined>;
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
    async refresh(name) {
      const result = await adapter.refresh(name);
      await reload(true);
      return result;
    },
    async disconnect(name, sessionId) {
      const result = await adapter.disconnect(name, sessionId);
      await reload(true);
      return result;
    },
    async waitForTools(name) {
      for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
        await timers.sleep(PROBE_INTERVAL_MS);
        try {
          const status = await adapter.status();
          state.set({ status });
          const cache = status.servers.find((server) => server.name === name)?.cache;
          if (cache !== undefined) return cache.toolCount;
        } catch {
          // 后台探测期间读失败不算结束，下一轮再看
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

/** 把接口返回补成安全形状（缺字段给默认值、丢掉坏的实例条目）。 */
export function normalizeRuntimeStatus(data: Partial<RuntimeStatus> | undefined): RuntimeStatus {
  return {
    servers: Array.isArray(data?.servers) ? data.servers : [],
    sessions: Array.isArray(data?.sessions)
      ? data.sessions.map((session) => ({
          ...session,
          sessionId: typeof session?.sessionId === "string" ? session.sessionId : "",
          instances: Array.isArray(session?.instances)
            ? session.instances.filter(
                (instance) => instance !== null && typeof instance === "object" && typeof instance.server === "string",
              )
            : [],
        }))
      : [],
  };
}

/**
 * 开发预览（URL 带 ?hubPreviewRunning=1）：服务器状态照常读，会话换成示例数据（走查不允许新建会话，
 * 测试 profile 里没有实例）；断开不调用接口。
 */
export function previewAdapter(base: RuntimeAdapter, sample: (now: number) => RuntimeStatus): RuntimeAdapter {
  return {
    async status() {
      const real = await base.status().catch((): RuntimeStatus => ({ servers: [], sessions: [] }));
      return { servers: real.servers, sessions: sample(Date.now()).sessions };
    },
    refresh: (name) => base.refresh(name),
    disconnect: async () => ({ closed: 0 }),
  };
}
