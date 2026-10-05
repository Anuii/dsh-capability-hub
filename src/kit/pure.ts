/**
 * kit 的纯逻辑：这里**不 import React、不碰 DOM**，所以可以在 node:test 里直接跑。
 *
 * 组件只做「渲染 + 把事件翻译成这些函数的输入」，判断本身全在这里，
 * 这样键盘行为与筛选计数才有单测（见 test/kit）。
 */

/** 筛选分段的一项。 */
export interface FilterItem {
  id: string;
  label: string;
  /** 该分段下的条目数；省略则不显示计数。 */
  count?: number;
  /** 调淡（例如「需关注 0」：没有问题时不抢眼，有问题时恢复正常）；当前选中的分段不调淡。 */
  quiet?: boolean;
}

/** 一次键盘决策。 */
export type KeyDecision =
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "focus"; index: number }
  | { kind: "trap" }
  | { kind: "ignore" };

/** 列表行最多显示几个标记（UI-DESIGN §1）。 */
export const MAX_ROW_BADGES = 2;

/** 骨架屏默认行数（UI-DESIGN §1）。 */
export const SKELETON_ROWS = 6;

/** 按一组谓词统计各分段的条目数（工具栏分段上的 n）。 */
export function countByPredicates<T>(
  items: readonly T[],
  predicates: Record<string, (item: T) => boolean>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of Object.keys(predicates)) out[id] = 0;
  for (const item of items) {
    for (const [id, test] of Object.entries(predicates)) {
      if (test(item)) out[id] += 1;
    }
  }
  return out;
}

/**
 * 行上的按键决策：Tab 与其它键交给浏览器，Enter / Space 才打开详情。
 * Space 也打开是因为行是 role="button"（与原生按钮一致），而 Space 在列表里不会滚动页面。
 */
export function rowKeyDecision(key: string): KeyDecision {
  if (key === "Enter" || key === " " || key === "Spacebar") return { kind: "open" };
  return { kind: "ignore" };
}

/** 把索引按 shift 方向在 [0, count) 上环绕；count 为 0 时返回 -1。 */
export function wrapIndex(currentIndex: number, count: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (currentIndex < 0) return shift ? count - 1 : 0;
  return shift ? (currentIndex - 1 + count) % count : (currentIndex + 1) % count;
}

/**
 * 抽屉里的按键决策：Esc 关闭；Tab 在抽屉内部环绕（焦点陷阱）；其余不管。
 * @param key 事件 key
 * @param shift 是否按住 Shift
 * @param currentIndex 当前焦点在可聚焦元素列表里的下标；不在列表里时 -1
 * @param count 抽屉内可聚焦元素个数
 */
export function drawerKey(key: string, shift: boolean, currentIndex: number, count: number): KeyDecision {
  if (key === "Escape" || key === "Esc") return { kind: "close" };
  if (key !== "Tab") return { kind: "ignore" };
  if (count <= 0) return { kind: "trap" };
  return { kind: "focus", index: wrapIndex(currentIndex, count, shift) };
}

/**
 * 筛选分段的 data-testid。
 *
 * 三个标签页同时挂载（切换只改 hidden），不带前缀时「全部 / 已启用 / …」会撞成同一个 testid，
 * 走查脚本只能靠祖先选择器区分；给了工具栏的 testId 就用 <testId>-filter-<id>。
 */
export function filterTestId(toolbarTestId: string | undefined, filterId: string): string {
  return toolbarTestId === undefined ? "kit-filter-" + filterId : toolbarTestId + "-filter-" + filterId;
}

/**
 * ListRow 的 attrs 透传白名单：只让 data-* 与 aria-* 落到行元素上。
 *
 * 为什么要有白名单：attrs 是标签页直接给的对象，放行 onClick / className / style
 * 这类键等于绕开 kit 的样式与交互约定（一行只由 kit 决定长什么样、能不能点）。
 * 走查脚本用 data-* 定位、无障碍用 aria-*，这两类才是真正需要的。
 */
export function passthroughAttrs(attrs: Readonly<Record<string, string>> | undefined): Record<string, string> {
  if (attrs === undefined) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value !== "string") continue;
    if (key.startsWith("data-") || key.startsWith("aria-")) out[key] = value;
  }
  return out;
}

/** 行上的标记最多 MAX_ROW_BADGES 个，多余的截掉（防止一行堆成一团）。 */
export function clampBadges<T>(badges: readonly T[] | undefined, max: number = MAX_ROW_BADGES): T[] {
  if (badges === undefined) return [];
  return badges.slice(0, Math.max(0, max));
}

/** 详情抽屉的宽度：窄视口下退化为整屏（UI-DESIGN §1）。 */
export function drawerWidth(viewportWidth: number, preferred = 560): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return preferred;
  return Math.min(preferred, viewportWidth);
}

/** 是否整屏（用于给抽屉去掉圆角 / 左边框）。 */
export function drawerIsFullWidth(viewportWidth: number, preferred = 560): boolean {
  return viewportWidth > 0 && viewportWidth <= preferred;
}

/** 从 URL 的 search 里读开发用开关（?hubKitPreview=1）。 */
export function searchFlag(search: string, name: string): boolean {
  const text = search.startsWith("?") ? search.slice(1) : search;
  if (text === "") return false;
  for (const part of text.split("&")) {
    if (part === "") continue;
    const at = part.indexOf("=");
    const key = at === -1 ? part : part.slice(0, at);
    if (key !== name) continue;
    const value = at === -1 ? "" : part.slice(at + 1);
    return value !== "0" && value.toLowerCase() !== "false" && value !== "";
  }
  return false;
}
