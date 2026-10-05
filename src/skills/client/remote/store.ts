/**
 * 「远程部分」的共享状态：来源表 + 检查更新结果 + 凭据模式 + 在途标志。
 *
 * 为什么需要它：安装子视图、每一行的来源/更新展示位、工具栏的批量动作是**同一棵树里
 * 三个互不相邻的组件**，但共享同一份数据（批量的「全部检查」要立刻反映到每一行）。
 * 用 kit 的 store（kit/store.ts）+ 订阅替代把状态层层往下传。
 *
 * 本文件不 import React、不碰 DOM：可被 node:test 直接测（见 test/skills/client/remote-store.test.ts）。
 */

import { createStore, type Store } from "../../../kit/store.ts";
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
  /** 快照（组件用 kit 的 useStoreState 订阅；浅合并用 state.patch） */
  readonly state: Store<RemoteSnapshot>;
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
  const state = createStore<RemoteSnapshot>(emptySnapshot());
  const get = (): RemoteSnapshot => state.get();
  return {
    state,
    setSources(entries) {
      const sources: Record<string, SourceEntry> = {};
      for (const entry of entries) sources[entry.skillId] = entry;
      state.patch({ sources, sourcesLoaded: true, sourcesLoading: false, sourcesError: undefined });
    },
    upsertSource(entry) {
      state.patch({ sources: { ...get().sources, [entry.skillId]: entry } });
    },
    removeSource(skillId) {
      const sources: Record<string, SourceEntry> = { ...get().sources };
      delete sources[skillId];
      state.patch({ sources });
    },
    setChecks(items, auth) {
      const checks: Record<string, UpdateCheckItem> = { ...get().checks };
      for (const item of items) checks[item.skillId] = item;
      state.patch({
        checks,
        ...(auth === undefined
          ? {}
          : {
              auth: auth.mode,
              rateLimitRemaining:
                auth.rateLimitRemaining === undefined ? get().rateLimitRemaining : auth.rateLimitRemaining,
            }),
      });
    },
    setCheck(item) {
      state.patch({ checks: { ...get().checks, [item.skillId]: item } });
    },
    setAuth(mode, rateLimitRemaining) {
      state.patch({
        auth: mode,
        rateLimitRemaining: rateLimitRemaining === undefined ? get().rateLimitRemaining : rateLimitRemaining,
      });
    },
    reset() {
      state.set(emptySnapshot());
    },
  };
}

/** 标签页共用的那一个实例。 */
export const remoteStore = createRemoteStore();
