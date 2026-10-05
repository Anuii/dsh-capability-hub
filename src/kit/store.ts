/**
 * 极小的外部状态仓库（ADR-0005）：持有一份不可变快照，变更时通知订阅者。
 *
 * 功能的「状态仓库」（例如 MCP 页的运行状态）在它之上加动作，并通过可替换的数据 adapter 访问宿主；
 * 组件用 useStoreState() 订阅。本文件不 import React，node:test 直接测。
 */

export interface Store<S> {
  get(): S;
  /** 整体替换（传函数时基于当前值）；值没变（===）时不通知 */
  set(next: S | ((current: S) => S)): void;
  /** 浅合并 */
  patch(partial: Partial<S>): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // 订阅者自己的异常不能影响别人
      }
    }
  };
  const set = (next: S | ((current: S) => S)): void => {
    const value = typeof next === "function" ? (next as (current: S) => S)(state) : next;
    if (value === state) return;
    state = value;
    emit();
  };
  return {
    get: () => state,
    set,
    patch: (partial) => set({ ...state, ...partial }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
