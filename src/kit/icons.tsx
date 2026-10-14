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
  return (
    <svg className={className} viewBox="0 0 16 16" width={12} height={12} fill="currentColor" aria-hidden="true">
      <circle cx="6" cy="4" r="1.05" />
      <circle cx="10" cy="4" r="1.05" />
      <circle cx="6" cy="8" r="1.05" />
      <circle cx="10" cy="8" r="1.05" />
      <circle cx="6" cy="12" r="1.05" />
      <circle cx="10" cy="12" r="1.05" />
    </svg>
  );
}

/** 行的「打开详情」指示（淡色右尖括号）。 */
export function ChevronGlyph({ className }: { className?: string }): React.ReactElement {
  return (
    <span className={className} aria-hidden="true">
      {"\u203a"}
    </span>
  );
}

/**
 * 折叠折角（chevron）。
 *
 * 用 12px 的 SVG 而不是「▸」字形：字形在不同字体下大小与基线都不一致，
 * 而这里要与 12px 的小节标题（line-height 18px）垂直居中对齐。
 * 展开时旋转 90°，旋转与动画由样式表上的 [data-open] 负责（含 reduced-motion）。
 */
export function SectionChevron({ open, className }: { open: boolean; className?: string }): React.ReactElement {
  return (
    <span className={className} data-open={open ? "" : undefined} aria-hidden="true">
      <svg
        viewBox="0 0 12 12"
        width={12}
        height={12}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        <path d="M4.5 2.5 L8 6 L4.5 9.5" />
      </svg>
    </span>
  );
}
