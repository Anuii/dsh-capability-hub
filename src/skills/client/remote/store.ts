/**
 * 「远程部分」的共享状态：来源表 + 检查更新结果 + 凭据模式 + 在途标志。
 *
 * 为什么需要它：安装子视图、每一行的来源/更新展示位、工具栏的批量动作是**同一棵树里
 * 三个互不相邻的组件**，但共享同一份数据（批量的「全部检查」要立刻反映到每一行）。
 * 用一个极小的外部 store + 订阅替代把状态层层往下传。
 *
 * 本文件不 import React、不碰 DOM：可被 node:test 直接测（见 test/skills/client/remote-store.test.ts）。
 */

import type { AuthMode, SourceEntry, UpdateCheckItem } from "../../contract/remote.ts";

export interface RemoteSnapshot {
  /** 来源表是否已经成功加载过一次 */
  sourcesLoaded: boolean;
  sourcesLoading: boolean;
  sourcesError: string | undefined;
  /** skillId → 来源条目 */
  sources: Readonly<Record<string, SourceEntry>>;
  /** GitHub 凭据模式（只有模式，绝不含令牌） */
  auth: AuthMode | undefined;
  rateLimitRemaining: number | undefined;
  /** skillId → 最近一次检查更新的结果 */
  checks: Readonly<Record<string, UpdateCheckItem>>;
  checking: boolean;
  applying: boolean;
}

export interface RemoteStore {
  snapshot(): RemoteSnapshot;
  subscribe(listener: () => void): () => void;
  patch(next: Partial<RemoteSnapshot>): void;
  setSources(entries: readonly SourceEntry[]): void;
  upsertSource(entry: SourceEntry): void;
  removeSource(skillId: string): void;
  setChecks(items: readonly UpdateCheckItem[], auth?: { mode: AuthMode; rateLimitRemaining?: number }): void;
  setCheck(item: UpdateCheckItem): void;
  setAuth(mode: AuthMode, rateLimitRemaining?: number): void;
  reset(): void;
}

function emptySnapshot(): RemoteSnapshot {
  return {
    sourcesLoaded: false,
    sourcesLoading: false,
    sourcesError: undefined,
    sources: {},
    auth: undefined,
    rateLimitRemaining: undefined,
    checks: {},
    checking: false,
    applying: false,
  };
}

export function createRemoteStore(): RemoteStore {
  let state = emptySnapshot();
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 订阅者自己的异常不能影响别人
      }
    }
  }

  function set(next: RemoteSnapshot): void {
    state = next;
    emit();
  }

  function patch(partial: Partial<RemoteSnapshot>): void {
    set({ ...state, ...partial });
  }

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    patch,
    setSources(entries) {
      const sources: Record<string, SourceEntry> = {};
      for (const entry of entries) sources[entry.skillId] = entry;
      patch({ sources, sourcesLoaded: true, sourcesLoading: false, sourcesError: undefined });
    },
    upsertSource(entry) {
      patch({ sources: { ...state.sources, [entry.skillId]: entry } });
    },
    removeSource(skillId) {
      const sources: Record<string, SourceEntry> = { ...state.sources };
      delete sources[skillId];
      patch({ sources });
    },
    setChecks(items, auth) {
      const checks: Record<string, UpdateCheckItem> = { ...state.checks };
      for (const item of items) checks[item.skillId] = item;
      patch({
        checks,
        ...(auth === undefined
          ? {}
          : {
              auth: auth.mode,
              rateLimitRemaining:
                auth.rateLimitRemaining === undefined ? state.rateLimitRemaining : auth.rateLimitRemaining,
            }),
      });
    },
    setCheck(item) {
      patch({ checks: { ...state.checks, [item.skillId]: item } });
    },
    setAuth(mode, rateLimitRemaining) {
      patch({
        auth: mode,
        rateLimitRemaining: rateLimitRemaining === undefined ? state.rateLimitRemaining : rateLimitRemaining,
      });
    },
    reset() {
      set(emptySnapshot());
    },
  };
}

/** 标签页共用的那一个实例。 */
export const remoteStore = createRemoteStore();
