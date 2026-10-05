/** kit 的 token 与全局规则：主题变量映射、开关缩放、占位文字；写法见 ./css.ts。 */

import { kitSheet } from "./css.ts";

export const tokensSheet = kitSheet(
  ["scope"],
  [
    // 抽屉是 portal 到 body 的，落在 [data-dsh-capability-hub-view] 之外 ——
    // 所以 token 选择器同时挂 .chk_scope（抽屉层带这个类），否则里面的 var(--chk-*) 全部失效。
    "[data-dsh-capability-hub-view],.chk_scope{",
    "--chk-sp1:4px;--chk-sp2:8px;--chk-sp3:12px;--chk-sp4:16px;--chk-sp5:24px;",
    "--chk-radius-container:10px;--chk-radius-control:6px;",
    "--chk-fs-page-title:18px;--chk-fs-group:12px;--chk-fs-row-title:14px;--chk-fs-row-sub:12.5px;",
    "--chk-fs-mono:12px;--chk-fs-badge:11px;--chk-fs-small:12px;",
    // 行高恒为 52px（有副标题两行字、没有副标题一行字，都靠 align-items:center 居中）——
    // 早先给无副标题的行 44px，一列排下来明显参差。
    "--chk-row-h:52px;--chk-dot:7px;--chk-drawer-w:560px;",
    // 宿主 Switch 没有 size/compact 参数（实测 lib/index.js:3394 只解构
    // checked/onChange/label/disabled/title/className），所以在能力中心作用域内
    // 用 CSS 把它整体缩到约 80%（36x20 -> 29x16），见下面的「开关」一节。
    "--chk-switch-w:29px;--chk-switch-h:16px;--chk-switch-thumb:12px;--chk-switch-travel:13px;",
    // 行副标题的专用色：比 --dsw-alias-label-tertiary 再向主文字靠 15%。
    // 为什么不是直接用 tertiary：亮色下 tertiary（bluish-600 #81858c）落在面板底（bluish-00 #fff）
    // 上只有 3.71:1，达不到 WCAG AA 小字 4.5:1；混 15% primary 后亮色 4.70:1、暗色 8.30:1。
    "--chk-fg-sub:color-mix(in srgb, var(--dsw-alias-label-tertiary) 85%, var(--dsw-alias-label-primary));",
    "--chk-fg-primary:var(--dsw-alias-label-primary);",
    "--chk-fg-secondary:var(--dsw-alias-label-secondary);",
    "--chk-fg-tertiary:var(--dsw-alias-label-tertiary);",
    "--chk-fg-caption:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));",
    "--chk-line-weak:var(--dsw-alias-border-l1);",
    "--chk-line:var(--dsw-alias-border-l2);",
    "--chk-surface:var(--dsw-alias-bg-layer-1);",
    "--chk-surface-sunken:var(--dsw-alias-bg-module-platform);",
    "--chk-hover:var(--dsw-alias-interactive-bg-hover);",
    "--chk-accent:var(--dsw-alias-state-business-primary);",
    "--chk-danger:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));",
    "--chk-warn:var(--dsw-alias-state-warn-primary);",
    "--chk-idle:var(--dsw-alias-state-idle-primary);",
    // DSH 自己的等宽字体变量（主题 base.css 的 :root，已核实真实存在）：
    //   --ds-font-family-code:"SF Mono","JetBrains Mono","Fira Code",Consolas,
    //     "Liberation Mono",Menlo,Courier,"PingFang SC","Microsoft YaHei"
    // 变量名是 --ds- 前缀而不是 --dsw-。早先用 var(--dsw-font-family-mono,monospace)
    // 会落到泛型 monospace，在中文系统上落到中文等宽字体，字距松散、显旧。
    '--chk-mono:var(--ds-font-family-code,"Cascadia Mono","Cascadia Code","JetBrains Mono",Consolas,"SFMono-Regular",Menlo,ui-monospace,monospace);',
    "--chk-focus:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));",
    "}",
    // 输入框占位文字：宿主默认的占位色太淡，在能力中心里统一提到次要色（满足对比度）。
    "[data-dsh-capability-hub-view] input::placeholder,.chk_scope input::placeholder{color:var(--chk-fg-tertiary);opacity:1}",
    // 宿主 Switch 只有 className 一个样式钩子（类名在产物里是哈希过的），DOM 固定是
    // <button role="switch"><span/></button>，所以这里按 role 与「唯一子元素」定位。
    // 作用域限定在能力中心页面与 kit 抽屉层内，**不影响 DSH 其他任何页面**。
    ".chk_scope button[role=switch],[data-dsh-capability-hub-view] button[role=switch]{width:var(--chk-switch-w);height:var(--chk-switch-h)}",
    ".chk_scope button[role=switch]>span,[data-dsh-capability-hub-view] button[role=switch]>span{width:var(--chk-switch-thumb);height:var(--chk-switch-thumb)}",
    ".chk_scope button[role=switch][aria-checked=true]>span,[data-dsh-capability-hub-view] button[role=switch][aria-checked=true]>span{transform:translateX(var(--chk-switch-travel))}",
  ],
);
