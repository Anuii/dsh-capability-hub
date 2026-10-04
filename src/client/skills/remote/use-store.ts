/**
 * 把 remote/store.ts 的快照接进 React（React 16.8+ 都可用，不依赖 useSyncExternalStore）。
 */

import * as React from "react";
import { remoteStore, type RemoteSnapshot, type RemoteStore } from "./store.ts";

/** 订阅 store；每次变更返回新的快照对象（store 内部保证不可变替换）。 */
export function useRemoteState(store: RemoteStore = remoteStore): RemoteSnapshot {
  const [state, setState] = React.useState<RemoteSnapshot>(() => store.snapshot());
  React.useEffect(() => store.subscribe(() => setState(store.snapshot())), [store]);
  return state;
}
