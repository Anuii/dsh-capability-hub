/**
 * 把 fold.ts 接进组件：一个组件持有一份折叠状态（标签隐藏而不卸载，切标签不会丢）。
 *
 *   const fold = useFold(scope);
 *   <ListGroup expanded={fold.expanded(key, byDefault)} onToggle={() => fold.toggle(key, byDefault)} />
 */

import * as React from "react";
import { EMPTY_FOLD, foldExpanded, foldToggle, type FoldState } from "./fold.ts";

export interface Fold {
  expanded(key: string, byDefault?: boolean): boolean;
  toggle(key: string, byDefault?: boolean): void;
}

export function useFold(scope: string): Fold {
  const [state, setState] = React.useState<FoldState>(EMPTY_FOLD);
  return {
    expanded: (key, byDefault) => foldExpanded(state, scope, key, byDefault),
    toggle: (key, byDefault) => setState((current) => foldToggle(current, scope, key, byDefault)),
  };
}
