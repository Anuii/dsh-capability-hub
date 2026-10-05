/** Banner、EmptyState、SkeletonRows 的样式；写法见 ./css.ts。 */

import { kitSheet } from "./css.ts";

export const feedbackSheet = kitSheet(
  [
    "banner",
    "bannerBody",
    "bannerAction",
    "empty",
    "emptyTitle",
    "emptyText",
    "skeleton",
    "skeletonRow",
    "skeletonBar",
    "skeletonStack",
  ],
  [
    ".chk_banner{display:flex;align-items:center;gap:var(--chk-sp3);flex:none;padding:var(--chk-sp2) var(--chk-sp4);border:1px solid var(--chk-line-weak);border-left:3px solid var(--chk-fg-tertiary);border-radius:var(--chk-radius-container);background:var(--chk-surface);font-size:var(--chk-fs-small);color:var(--chk-fg-secondary)}",
    ".chk_banner[data-tone=warn]{border-left-color:var(--chk-warn)}",
    ".chk_banner[data-tone=danger]{border-left-color:var(--chk-danger)}",
    ".chk_banner[data-tone=accent]{border-left-color:var(--chk-accent)}",
    ".chk_bannerBody{flex:1;min-width:0;line-height:18px}",
    ".chk_bannerAction{cursor:pointer;flex:none;background:0 0;border:none;padding:2px 4px;font:inherit;font-size:var(--chk-fs-small);color:var(--chk-fg-secondary);text-decoration:underline;text-underline-offset:2px;border-radius:var(--chk-radius-control)}",
    ".chk_bannerAction:hover{color:var(--chk-fg-primary);background:var(--chk-hover)}",
    ".chk_empty{display:flex;flex-direction:column;align-items:center;gap:var(--chk-sp2);padding:var(--chk-sp5) var(--chk-sp4);border:1px dashed var(--chk-line-weak);border-radius:var(--chk-radius-container);text-align:center}",
    ".chk_emptyTitle{margin:0;font-size:var(--chk-fs-row-title);font-weight:500;color:var(--chk-fg-secondary)}",
    ".chk_emptyText{margin:0;font-size:var(--chk-fs-small);color:var(--chk-fg-tertiary);max-width:44ch;line-height:18px}",
    ".chk_skeleton{display:flex;flex-direction:column;border:1px solid var(--chk-line-weak);border-radius:var(--chk-radius-container);background:var(--chk-surface);overflow:hidden}",
    ".chk_skeletonRow{display:flex;align-items:center;gap:var(--chk-sp3);min-height:var(--chk-row-h);padding:0 var(--chk-sp4);border-top:1px solid var(--chk-line-weak)}",
    ".chk_skeletonRow:first-child{border-top:none}",
    ".chk_skeletonBar{height:9px;border-radius:4px;background:var(--chk-hover);animation:chk_pulse 1.4s ease-in-out infinite}",
    ".chk_skeletonBar[data-w=title]{width:132px}",
    ".chk_skeletonBar[data-w=sub]{width:236px;height:7px;opacity:.6}",
    ".chk_skeletonStack{display:flex;flex-direction:column;gap:6px;flex:1;min-width:0}",
    "@keyframes chk_pulse{0%,100%{opacity:.45}50%{opacity:.9}}",
    "@media (prefers-reduced-motion:reduce){.chk_skeletonBar{animation:none}}",
  ],
);
