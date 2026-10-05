/** Badge 与 StatusDot 的样式；写法见 ./css.ts。 */

import { kitSheet } from "./css.ts";

export const badgeSheet = kitSheet(
  ["badge", "dot"],
  [
    ".chk_badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:9px;border:1px solid var(--chk-line);background:0 0;font-size:var(--chk-fs-badge);font-weight:500;line-height:1;color:var(--chk-fg-tertiary);white-space:nowrap}",
    ".chk_badge[data-tone=accent]{color:var(--chk-accent);border-color:var(--chk-accent)}",
    ".chk_badge[data-tone=warn]{color:var(--chk-warn);border-color:var(--chk-warn)}",
    ".chk_badge[data-tone=danger]{color:var(--chk-danger);border-color:var(--chk-danger)}",
    ".chk_dot{display:inline-block;flex:none;width:var(--chk-dot);height:var(--chk-dot);border-radius:50%;background:var(--chk-idle)}",
    ".chk_dot[data-tone=idle]{background:var(--chk-idle)}",
    ".chk_dot[data-tone=active]{background:var(--chk-accent)}",
    ".chk_dot[data-tone=failed]{background:var(--chk-danger)}",
    ".chk_dot[data-tone=cooling]{background:var(--chk-warn)}",
  ],
);
