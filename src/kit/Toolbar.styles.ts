/** Toolbar 的样式；写法见 ./css.ts。 */

import { kitSheet } from "./css.ts";

export const toolbarSheet = kitSheet(
  [
    "toolbar",
    "toolbarStart",
    "toolbarSpacer",
    "toolbarAfterFilters",
    "toolbarEnd",
    "search",
    "segments",
    "segment",
    "segmentCount",
  ],
  [
    ".chk_toolbar{display:flex;align-items:center;gap:var(--chk-sp2);flex:none;flex-wrap:wrap;min-height:32px}",
    ".chk_toolbarStart{display:flex;align-items:center;gap:var(--chk-sp2);min-width:0}",
    ".chk_toolbarSpacer{flex:1;min-width:var(--chk-sp2)}",
    ".chk_toolbarAfterFilters{display:inline-flex;align-items:center;gap:var(--chk-sp2);flex:none}",
    ".chk_toolbarEnd{display:flex;align-items:center;gap:var(--chk-sp2);min-width:0}",
    ".chk_search{width:220px;flex:none}",
    ".chk_segments{display:flex;align-items:center;gap:2px;flex-wrap:wrap}",
    ".chk_segment{cursor:pointer;display:inline-flex;align-items:center;gap:6px;background:0 0;border:none;border-radius:var(--chk-radius-control);padding:5px 10px;font:inherit;font-size:var(--chk-fs-small);color:var(--chk-fg-secondary);line-height:18px}",
    ".chk_segment:hover{background:var(--chk-hover);color:var(--chk-fg-primary)}",
    ".chk_segment[data-active]{background:var(--chk-hover);color:var(--chk-fg-primary);font-weight:500}",
    ".chk_segmentCount{font-variant-numeric:tabular-nums;color:var(--chk-fg-caption);font-size:var(--chk-fs-badge)}",
    ".chk_segment[data-active] .chk_segmentCount{color:var(--chk-fg-tertiary)}",
    ".chk_segment[data-quiet]{color:var(--chk-fg-caption)}",
    ".chk_segment[data-quiet]:hover{color:var(--chk-fg-secondary)}",
    "@media (max-width:720px){.chk_search{width:100%}.chk_toolbarEnd{width:100%}}",
  ],
);
