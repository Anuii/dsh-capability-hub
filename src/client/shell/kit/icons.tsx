/**
 * kit 的小图标。
 *
 * 为什么用手写 SVG / 字形而不是宿主 primitives 的 Icon*：
 *   - 宿主 198 个图标的导出名没有 .d.ts，写错名字只会在运行期变成 undefined
 *     （页面直接崩），风险与收益不成比例；
 *   - kit 只需要三四个极简字形，全部用 currentColor，跟随文字颜色与主题。
 */
import * as React from "react";

/** 拖动手柄（六个点）。 */
export function GripIcon({ className }: { className?: string }): React.ReactElement {
  return React.createElement("svg", {
    className,
    viewBox: "0 0 16 16",
    width: 12,
    height: 12,
    fill: "currentColor",
    "aria-hidden": "true",
  },
  React.createElement("circle", { cx: "6", cy: "4", r: "1.05" }),
  React.createElement("circle", { cx: "10", cy: "4", r: "1.05" }),
  React.createElement("circle", { cx: "6", cy: "8", r: "1.05" }),
  React.createElement("circle", { cx: "10", cy: "8", r: "1.05" }),
  React.createElement("circle", { cx: "6", cy: "12", r: "1.05" }),
  React.createElement("circle", { cx: "10", cy: "12", r: "1.05" }));
}

/** 行的「打开详情」指示（淡色右尖括号）。 */
export function ChevronGlyph({ className }: { className?: string }): React.ReactElement {
  return React.createElement("span", { className, "aria-hidden": "true" }, "\u203a");
}

/**
 * 刷新（环形箭头）。
 *
 * 运行态页原本在自己目录里手画了一份一模一样的 SVG（RefreshGlyph）——
 * UI-C 收到「把运行态里手写的刷新 SVG 换成 kit 的」这条意见后收到这里，
 * 两个地方（工具栏的「刷新」按钮、以后任何要刷新的地方）共用同一个字形。
 */
export function RefreshIcon({ className }: { className?: string }): React.ReactElement {
  return React.createElement("svg", {
    className,
    viewBox: "0 0 16 16",
    width: 14,
    height: 14,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.4",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    focusable: "false",
  },
  React.createElement("path", { d: "M13.2 8a5.2 5.2 0 1 1-1.6-3.75" }),
  React.createElement("path", { d: "M13.4 1.9v3.2H10.2" }));
}

/**
 * 折叠折角（chevron）。
 *
 * 用 12px 的 SVG 而不是「▸」字形：字形在不同字体下大小与基线都不一致，
 * 而这里要与 12px 的小节标题（line-height 18px）垂直居中对齐。
 * 展开时旋转 90°，旋转与动画由样式表上的 [data-open] 负责（含 reduced-motion）。
 */
export function SectionChevron({ open, className }: { open: boolean; className?: string }): React.ReactElement {
  return React.createElement("span", {
    className,
    "data-open": open ? "" : undefined,
    "aria-hidden": "true",
  },
  React.createElement("svg", {
    viewBox: "0 0 12 12",
    width: 12,
    height: 12,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.4",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    focusable: "false",
  },
  React.createElement("path", { d: "M4.5 2.5 L8 6 L4.5 9.5" })));
}
