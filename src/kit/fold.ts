/**
 * 可折叠分组的折叠状态（技能列表的层级 / 来源仓库、仓库视图的汇总分组共用）。
 *
 * 规则（UI-DESIGN §3）：
 *   - 只记用户点过的分组（key → 展开与否），没点过的用调用方给的默认值（例如「DSH 内置默认折叠」
 *     「技能数超过 50 的仓库默认折叠」）；
 *   - 筛选中（scope ≠ ""）有匹配的分组默认全部展开；用户在筛选中的折叠只对这一次筛选有效，
 *     换一种筛选又全部展开；
 *   - 清空筛选（scope 回到 ""）恢复不筛选时的状态，原样不动。
 *
 * scope 是「这一次筛选」的标识：由调用方把搜索词与各筛选项拼起来，不筛选时是 ""。
 * 纯函数，不碰 React；组件里用 kit 的 useFold()。
 */

export interface FoldState {
  /** 不筛选时用户点过的分组 */
  readonly normal: ReadonlyMap<string, boolean>;
  /** 某一次筛选里用户点过的分组 */
  readonly scoped: { readonly scope: string; readonly open: ReadonlyMap<string, boolean> };
}

export const EMPTY_FOLD: FoldState = { normal: new Map(), scoped: { scope: "", open: new Map() } };

function scopedOpen(state: FoldState, scope: string): ReadonlyMap<string, boolean> {
  return state.scoped.scope === scope ? state.scoped.open : new Map();
}

/** 某个分组现在是否展开。byDefault 只在不筛选时生效（筛选中默认展开）。 */
export function foldExpanded(state: FoldState, scope: string, key: string, byDefault = true): boolean {
  if (scope === "") return state.normal.get(key) ?? byDefault;
  return scopedOpen(state, scope).get(key) ?? true;
}

/** 用户点了某个分组的标题。 */
export function foldToggle(state: FoldState, scope: string, key: string, byDefault = true): FoldState {
  const next = !foldExpanded(state, scope, key, byDefault);
  if (scope === "") return { ...state, normal: new Map(state.normal).set(key, next) };
  return { ...state, scoped: { scope, open: new Map(scopedOpen(state, scope)).set(key, next) } };
}
