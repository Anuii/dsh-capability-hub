/** Section 与 KeyValue 的样式；写法见 ./css.ts。 */

import { kitSheet } from "./css.ts";

export const sectionSheet = kitSheet(
  ["section", "sectionHead", "sectionTitle", "sectionChevron", "sectionEnd", "sectionBody", "kv", "kvKey", "kvValue"],
  [
    ".chk_section{display:flex;flex-direction:column;gap:var(--chk-sp2)}",
    ".chk_sectionHead{display:flex;align-items:center;gap:var(--chk-sp2);min-height:22px}",
    ".chk_sectionTitle{cursor:default;display:inline-flex;align-items:center;gap:6px;line-height:18px;background:0 0;border:none;padding:0;font:inherit;font-size:var(--chk-fs-group);font-weight:500;color:var(--chk-fg-tertiary)}",
    ".chk_sectionTitle[data-collapsible]{cursor:pointer}",
    ".chk_sectionTitle[data-collapsible]:hover{color:var(--chk-fg-secondary)}",
    ".chk_sectionChevron{flex:none;display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;color:var(--chk-fg-caption);transition:transform 120ms ease-out}",
    ".chk_sectionChevron[data-open]{transform:rotate(90deg)}",
    ".chk_sectionEnd{margin-left:auto;display:flex;align-items:center;gap:var(--chk-sp2)}",
    ".chk_sectionBody{display:flex;flex-direction:column;gap:var(--chk-sp2);min-width:0}",
    ".chk_kv{display:grid;grid-template-columns:112px 1fr;gap:6px var(--chk-sp3);margin:0;min-width:0}",
    ".chk_kvKey{margin:0;font-size:var(--chk-fs-small);color:var(--chk-fg-tertiary)}",
    ".chk_kvValue{margin:0;font-size:var(--chk-fs-small);color:var(--chk-fg-secondary);min-width:0;overflow-wrap:anywhere}",
    ".chk_kvValue[data-mono]{font-family:var(--chk-mono);font-size:var(--chk-fs-mono)}",
    "@media (prefers-reduced-motion:reduce){.chk_sectionChevron{transition:none}}",
  ],
);
