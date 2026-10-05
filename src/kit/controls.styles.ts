/** 标签页直接使用的原生控件：下拉、勾选框、图标按钮、危险按钮；写法见 ./css.ts。 */

import { kitSheet } from "./css.ts";

export const controlsSheet = kitSheet(
  ["select", "check", "dangerButton", "iconButton"],
  [
    // 安静的原生下拉（技能页「目录」筛选）：与分段同高、中性灰，展开后是系统菜单。
    ".chk_select{height:28px;max-width:220px;padding:0 6px;border:1px solid var(--chk-line-weak);border-radius:var(--chk-radius-control);background:var(--chk-surface);color:var(--chk-fg-secondary);font:inherit;font-size:var(--chk-fs-small);cursor:pointer}",
    ".chk_select:hover{color:var(--chk-fg-primary)}",
    // 行首的原生勾选框（仓库视图）：中性色、无可见文字（名称就在同一行的标题里，靠 aria-label 提供无障碍名）。
    // color-scheme 跟随 DSH 主题（而不是系统偏好），否则亮色主题下未勾选的框会被画成深色方块。
    ".chk_check{flex:none;width:14px;height:14px;margin:0;cursor:pointer;accent-color:var(--chk-fg-primary);color-scheme:light}",
    "[data-ds-dark-theme] .chk_check{color-scheme:dark}",
    ".chk_check:disabled{cursor:default;opacity:.45}",
    ".chk_check:focus-visible{outline:2px solid var(--chk-focus);outline-offset:2px}",
    ".chk_select:focus-visible{outline:2px solid var(--chk-focus);outline-offset:1px}",
    ".chk_select[data-active]{color:var(--chk-fg-primary);border-color:var(--chk-line)}",
    ".chk_dangerButton{color:var(--chk-danger);opacity:.85}",
    ".chk_iconButton{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;background:0 0;border:none;border-radius:var(--chk-radius-control);color:var(--chk-fg-tertiary);font-size:13px;line-height:1}",
    ".chk_iconButton:hover{background:var(--chk-hover);color:var(--chk-fg-primary)}",
    ".chk_iconButton:focus-visible{outline:2px solid var(--chk-focus);outline-offset:1px}",
  ],
);
