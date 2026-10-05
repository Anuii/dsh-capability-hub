/** Drawer 的样式；写法见 ./css.ts。 */

import { kitSheet } from "./css.ts";

export const drawerSheet = kitSheet(
  [
    "drawerLayer",
    "drawerMask",
    "drawer",
    "drawerHead",
    "drawerHeadText",
    "drawerTitle",
    "drawerSub",
    "drawerHeadEnd",
    "drawerBody",
    "drawerFoot",
    "drawerFootSpacer",
  ],
  [
    ".chk_drawerLayer{position:fixed;inset:0;z-index:60;display:flex;justify-content:flex-end}",
    ".chk_drawerMask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);animation:chk_fade 160ms ease-out}",
    ".chk_drawer{position:relative;display:flex;flex-direction:column;width:var(--chk-drawer-w);max-width:100%;height:100%;background:var(--chk-surface);border-left:1px solid var(--chk-line-weak);box-shadow:var(--dsw-shadow-lv3,0 12px 32px var(--chk-line));outline:none;animation:chk_slide 160ms ease-out}",
    ".chk_drawer[data-full]{width:100%;border-left:none}",
    ".chk_drawerHead{display:flex;align-items:flex-start;gap:var(--chk-sp3);flex:none;padding:var(--chk-sp4);border-bottom:1px solid var(--chk-line-weak)}",
    ".chk_drawerHeadText{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}",
    ".chk_drawerTitle{font-size:15px;font-weight:600;color:var(--chk-fg-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    // 单行截断（完整内容在 title 提示里）：早先的 overflow-wrap:anywhere 会把长路径折成三行，
    // 把抽屉头部顶得忽高忽低。
    ".chk_drawerSub{font-family:var(--chk-mono);font-size:var(--chk-fs-mono);color:var(--chk-fg-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
    ".chk_drawerHeadEnd{display:flex;align-items:center;gap:var(--chk-sp2);flex:none}",
    ".chk_drawerBody{display:flex;flex-direction:column;gap:var(--chk-sp4);flex:1;min-height:0;overflow:auto;padding:var(--chk-sp4)}",
    ".chk_drawerFoot{display:flex;align-items:center;gap:var(--chk-sp2);flex:none;padding:var(--chk-sp3) var(--chk-sp4);border-top:1px solid var(--chk-line-weak)}",
    ".chk_drawerFootSpacer{flex:1}",
    "@keyframes chk_slide{from{transform:translateX(100%)}to{transform:translateX(0)}}",
    "@keyframes chk_fade{from{opacity:0}to{opacity:1}}",
    "@media (prefers-reduced-motion:reduce){.chk_drawer,.chk_drawerMask{animation:none;transition:none}}",
  ],
);
