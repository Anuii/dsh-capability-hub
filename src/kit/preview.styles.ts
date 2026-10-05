/** 开发预览面板（?hubKitPreview=1）的样式；写法见 ./css.ts。 */

import { kitSheet } from "./css.ts";

export const previewSheet = kitSheet(
  ["preview", "previewBand", "previewCaption", "previewNote"],
  [
    ".chk_preview{display:flex;flex-direction:column;gap:var(--chk-sp5);flex:none;padding-bottom:var(--chk-sp5)}",
    ".chk_previewBand{display:flex;flex-direction:column;gap:var(--chk-sp3)}",
    ".chk_previewCaption{margin:0;font-size:var(--chk-fs-badge);font-weight:500;color:var(--chk-fg-caption);letter-spacing:.04em;text-transform:uppercase}",
    ".chk_previewNote{margin:0;font-size:var(--chk-fs-small);color:var(--chk-fg-tertiary);line-height:18px}",
  ],
);
