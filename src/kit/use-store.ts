/** 把 kit/store.ts 的快照接进 React（React 16.8+ 都可用，不依赖 useSyncExternalStore）。 */

import * as React from "react";
import type { Store } from "./store.ts";

export function useStoreState<S>(store: { get(): S; subscribe(listener: () => void): () => void }): S {
  const [state, setState] = React.useState<S>(() => store.get());
  React.useEffect(() => {
    setState(store.get());
    return store.subscribe(() => setState(store.get()));
  }, [store]);
  return state;
}

export type { Store };
