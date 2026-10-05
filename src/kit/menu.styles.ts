/** MoreMenu 的样式；写法见 ./css.ts。 */

import { kitSheet } from "./css.ts";

export const menuSheet = kitSheet(
  ["more", "moreButton"],
  [
    ".chk_more{display:inline-flex}",
    ".chk_moreButton{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;background:0 0;border:1px solid var(--chk-line-weak);border-radius:var(--chk-radius-control);color:var(--chk-fg-secondary);font-size:14px;line-height:1;padding:0}",
    ".chk_moreButton:hover{background:var(--chk-hover);color:var(--chk-fg-primary)}",
  ],
);
