/**
 * kit —— 能力中心三个标签页共用的 UI 组件层。
 *
 * 用法（完整说明见 docs/CLIENT-GUIDE.md「kit 使用说明」）：
 *
 *   import { Toolbar, ListSurface, ListGroup, ListRow, Badge } from "../../kit/index.ts";
 *
 * 三个约束：
 *   1. 标签页**只通过 kit 拼界面**，不要再自己写列表 / 抽屉 / 标记的样式；
 *   2. 颜色一律来自 kit 的 token（它自己只引用 --dsw-* 主题变量），
 *      标签页自己的 styles.ts 里也不要出现写死的颜色；
 *   3. kit 的 CSS 写在各组件旁边的 *.styles.ts（写法见 css.ts），由外壳的 applier 统一注入（injectKitStyles），
 *      标签页不用管；标签页自己的样式也用 css.ts 的 defineSheet / injectStyleTag。
 */
export { injectKitStyles, kit, KIT_CSS } from "./styles.ts";
export { defineSheet, injectStyleTag } from "./css.ts";
export type { Sheet } from "./css.ts";
export {
  countByPredicates,
  clampBadges,
  drawerIsFullWidth,
  drawerKey,
  drawerWidth,
  filterTestId,
  MAX_ROW_BADGES,
  passthroughAttrs,
  rowKeyDecision,
  searchFlag,
  SKELETON_ROWS,
  wrapIndex,
} from "./pure.ts";
export type { FilterItem, KeyDecision } from "./pure.ts";

export { Badge, StatusDot } from "./Badge.tsx";
export type { BadgeTone, StatusTone } from "./Badge.tsx";

export { ChevronGlyph, GripIcon, RefreshIcon, SectionChevron } from "./icons.tsx";

export { MoreMenu, PrimaryMenuButton, menuChildren } from "./menu.tsx";
export type { MenuItem } from "./menu.tsx";

export { Toolbar } from "./Toolbar.tsx";
export type { ToolbarProps } from "./Toolbar.tsx";

export { ListFoot, ListGroup, ListRow, ListSurface } from "./ListSurface.tsx";
export type { ListRowProps, RowAction } from "./ListSurface.tsx";

export { Drawer, focusablesIn } from "./Drawer.tsx";
export type { DrawerProps } from "./Drawer.tsx";

export { KeyValue, Section } from "./Section.tsx";
export type { KeyValueItem } from "./Section.tsx";

export { Banner, EmptyState, SkeletonRows } from "./Feedback.tsx";
export type { BannerTone } from "./Feedback.tsx";

/** 开发用预览面板（只在 ?hubKitPreview=1 时由外壳渲染）。 */
export { KitPreview } from "./preview.tsx";
