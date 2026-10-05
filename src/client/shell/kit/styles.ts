/**
 * kit 的样式：**一个** CSS 字符串 + **一个** injectStyles。
 *
 * 约定（UI-DESIGN §1）：
 *   - 颜色一律走 DSH 主题变量（--dsw-*），绝不写死颜色 —— 否则暗色主题会崩；
 *     所以这里连遮罩都用宿主的 --dsw-alias-bg-mask-1，而不是自己写 rgba()。
 *   - 布局尺度（间距 / 圆角 / 字号 / 行高）定义成本文件的 --chk-* token，
 *     组件只用 token，不散落魔法数字。
 *   - 类名统一 chk_ 前缀，与外壳（ch_）和三个标签页（chsk_ / chmcp_ / chrt_）都不冲突。
 *   - kit 的样式表与外壳的样式表是两张 <style>（id 不同），两边都可以独立热更新。
 */

/** 类名前缀。 */
const PREFIX = "chk_";

/** 主题变量的取值处（集中在这里，改主题只改这一段）。 */
const CSS = [
  // ---- tokens -------------------------------------------------------------
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
  "--chk-mono:var(--ds-font-family-code,\"Cascadia Mono\",\"Cascadia Code\",\"JetBrains Mono\",Consolas,\"SFMono-Regular\",Menlo,ui-monospace,monospace);",
  "--chk-focus:var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));",
  "}",

  // ---- 工具条 --------------------------------------------------------------
  ".chk_toolbar{display:flex;align-items:center;gap:var(--chk-sp2);flex:none;flex-wrap:wrap;min-height:32px}",
  ".chk_toolbarStart{display:flex;align-items:center;gap:var(--chk-sp2);min-width:0}",
  ".chk_toolbarSpacer{flex:1;min-width:var(--chk-sp2)}",
  ".chk_toolbarAfterFilters{display:inline-flex;align-items:center;gap:var(--chk-sp2);flex:none}",
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
  ".chk_toolbarEnd{display:flex;align-items:center;gap:var(--chk-sp2);min-width:0}",
  ".chk_search{width:220px;flex:none}",
  ".chk_segments{display:flex;align-items:center;gap:2px;flex-wrap:wrap}",
  ".chk_segment{cursor:pointer;display:inline-flex;align-items:center;gap:6px;background:0 0;border:none;border-radius:var(--chk-radius-control);padding:5px 10px;font:inherit;font-size:var(--chk-fs-small);color:var(--chk-fg-secondary);line-height:18px}",
  ".chk_segment:hover{background:var(--chk-hover);color:var(--chk-fg-primary)}",
  ".chk_segment[data-active]{background:var(--chk-hover);color:var(--chk-fg-primary);font-weight:500}",
  ".chk_segmentCount{font-variant-numeric:tabular-nums;color:var(--chk-fg-caption);font-size:var(--chk-fs-badge)}",
  ".chk_segment[data-active] .chk_segmentCount{color:var(--chk-fg-tertiary)}",

  // ---- 列表容器 ------------------------------------------------------------
  ".chk_surface{display:flex;flex-direction:column;gap:var(--chk-sp5);min-height:0;flex:none}",
  ".chk_group{display:flex;flex-direction:column;border:1px solid var(--chk-line-weak);border-radius:var(--chk-radius-container);background:var(--chk-surface);overflow:hidden}",
  ".chk_groupHead{display:flex;align-items:center;gap:var(--chk-sp2);padding:0 var(--chk-sp4);min-height:32px;background:var(--chk-surface-sunken);border-bottom:1px solid var(--chk-line-weak)}",
  ".chk_groupTitle{font-size:var(--chk-fs-group);font-weight:500;color:var(--chk-fg-tertiary);white-space:nowrap}",
  ".chk_groupMeta{font-family:var(--chk-mono);font-size:var(--chk-fs-mono);color:var(--chk-fg-caption);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
  ".chk_groupSpacer{flex:1}",
  ".chk_groupCount{font-size:var(--chk-fs-badge);color:var(--chk-fg-caption);font-variant-numeric:tabular-nums;white-space:nowrap}",
  ".chk_groupBadges{display:flex;align-items:center;gap:var(--chk-sp1)}",
  // 可折叠的分组标题行（技能的层级 / 来源仓库、MCP 的「运行中」）：整条是一个按钮。
  ".chk_groupHeadWrap{position:relative;display:flex;align-items:stretch}",
  ".chk_groupHeadWrap>.chk_groupHead{flex:1;min-width:0}",
  ".chk_groupHead[data-fold]{cursor:pointer;width:100%;border:none;border-bottom:1px solid var(--chk-line-weak);font:inherit;text-align:left;color:inherit}",
  ".chk_groupHead[data-fold]:hover{background:var(--chk-hover)}",
  ".chk_groupHead[data-fold]:hover .chk_groupTitle{color:var(--chk-fg-secondary)}",
  ".chk_groupHead[data-fold]:focus-visible{outline:2px solid var(--chk-focus);outline-offset:-2px}",
  ".chk_group[data-collapsed]>.chk_groupHeadWrap>.chk_groupHead,.chk_group[data-collapsed]>.chk_groupHead,.chk_group[data-collapsed]>.chk_groupHeadWrap>.chk_groupEnd{border-bottom:none}",
  ".chk_groupEnd{display:flex;align-items:center;gap:var(--chk-sp2);padding:0 var(--chk-sp3);background:var(--chk-surface-sunken);border-bottom:1px solid var(--chk-line-weak)}",
  ".chk_nested{display:flex;flex-direction:column}",
  // 二级分组：嵌在一级分组里，不再有外框；标题行缩进、用面板底色。
  ".chk_group[data-depth='1']{border:none;border-radius:0;border-top:1px solid var(--chk-line-weak)}",
  ".chk_nested>.chk_group[data-depth='1']:first-child{border-top:none}",
  // 缩进规则：子级内容与父级标题文字对齐（折叠箭头 12px + 间距 8px = 20px 一级）。
  //   一级可折叠分组（技能的层级）：标题文字在 16+20，直接挂在它下面的行也缩到 16+20；
  //   二级分组（来源仓库 / 会话）：标题行缩到 16+20；可折叠的二级分组标题文字在 16+40，它的行缩到 16+40，
  //   不可折叠的二级分组（「运行中」的会话）没有箭头，行与标题文字同在 16+20。
  ".chk_group[data-depth='1']>.chk_groupHead,.chk_group[data-depth='1']>.chk_groupHeadWrap>.chk_groupHead{background:var(--chk-surface);padding-left:calc(var(--chk-sp4) + 20px);min-height:30px}",
  ".chk_group[data-foldable]:not([data-depth])>.chk_rows>.chk_row{padding-left:calc(var(--chk-sp4) + 20px)}",
  ".chk_group[data-depth='1'][data-foldable]>.chk_rows>.chk_row{padding-left:calc(var(--chk-sp4) + 40px)}",
  ".chk_group[data-depth='1']:not([data-foldable])>.chk_rows>.chk_row{padding-left:calc(var(--chk-sp4) + 20px)}",
  ".chk_rows{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}",
  ".chk_rowsEmpty{padding:var(--chk-sp4);font-size:var(--chk-fs-small);color:var(--chk-fg-tertiary)}",

  // ---- 行 ------------------------------------------------------------------
  ".chk_row{position:relative;display:flex;align-items:center;gap:var(--chk-sp3);min-height:var(--chk-row-h);padding:0 var(--chk-sp4);border-top:1px solid var(--chk-line-weak);outline:none}",
  ".chk_row:first-child{border-top:none}",
  ".chk_row[data-openable]{cursor:pointer}",
  ".chk_row[data-openable]:hover{background:var(--chk-hover)}",
  ".chk_row[data-openable]:focus-visible{box-shadow:inset 0 0 0 2px var(--chk-focus)}",
  ".chk_row[data-selected]{background:var(--chk-hover)}",
  ".chk_rowLeading{display:flex;align-items:center;flex:none}",
  ".chk_rowMain{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}",
  ".chk_rowTitleLine{display:flex;align-items:center;gap:var(--chk-sp2);min-width:0}",
  ".chk_rowTitle{font-size:var(--chk-fs-row-title);font-weight:500;color:var(--chk-fg-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
  // 行标题后的目录标签：等宽小字、最弱的说明色，没有边框与底色（比状态标记更弱）。
  // 字号比标题小：行盒与标题同高再下移 1px，让两者的基线大致对齐。
  ".chk_rowTag{flex:none;position:relative;top:1px;font-family:var(--chk-mono);font-size:11px;line-height:20px;color:var(--chk-fg-caption);white-space:nowrap}",
  ".chk_rowBadges{display:flex;align-items:center;gap:var(--chk-sp1);flex:none}",
  ".chk_rowSub{font-size:var(--chk-fs-row-sub);font-weight:400;color:var(--chk-fg-sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
  ".chk_rowSub[data-mono]{font-family:var(--chk-mono);font-size:var(--chk-fs-mono)}",
  ".chk_rowSub[data-tone=danger]{color:var(--chk-danger)}",
  ".chk_rowSub[data-tone=warn]{color:var(--chk-warn)}",
  ".chk_rowEnd{display:flex;align-items:center;gap:var(--chk-sp3);flex:none}",
  ".chk_rowActions{display:flex;align-items:center;gap:var(--chk-sp2);opacity:0;pointer-events:none;transition:opacity 120ms ease-out}",
  ".chk_row:hover .chk_rowActions,.chk_row:focus-within .chk_rowActions{opacity:1;pointer-events:auto}",
  ".chk_rowAction{cursor:pointer;background:0 0;border:none;border-radius:var(--chk-radius-control);padding:4px 6px;font:inherit;font-size:var(--chk-fs-small);color:var(--chk-fg-secondary)}",
  ".chk_rowAction:hover{background:var(--chk-hover);color:var(--chk-fg-primary)}",
  ".chk_rowAction[data-danger]{color:var(--chk-danger)}",
  ".chk_rowChevron{flex:none;width:12px;text-align:center;font-size:14px;line-height:1;color:var(--chk-fg-caption);opacity:0;transition:opacity 120ms ease-out}",
  ".chk_row:hover .chk_rowChevron,.chk_row:focus-visible .chk_rowChevron{opacity:.75}",
  ".chk_dragHandle{flex:none;display:flex;align-items:center;cursor:grab;color:var(--chk-fg-caption);opacity:0}",
  ".chk_row:hover .chk_dragHandle{opacity:.7}",
  ".chk_row[data-dragging]{opacity:.5}",

  // ---- 开关 ------------------------------------------------------------------
  // 宿主 Switch 只有 className 一个样式钩子（类名在产物里是哈希过的），DOM 固定是
  // <button role="switch"><span/></button>，所以这里按 role 与「唯一子元素」定位。
  // 作用域限定在能力中心页面与 kit 抽屉层内，**不影响 DSH 其他任何页面**。
  ".chk_scope button[role=switch],[data-dsh-capability-hub-view] button[role=switch]{width:var(--chk-switch-w);height:var(--chk-switch-h)}",
  ".chk_scope button[role=switch]>span,[data-dsh-capability-hub-view] button[role=switch]>span{width:var(--chk-switch-thumb);height:var(--chk-switch-thumb)}",
  ".chk_scope button[role=switch][aria-checked=true]>span,[data-dsh-capability-hub-view] button[role=switch][aria-checked=true]>span{transform:translateX(var(--chk-switch-travel))}",

  // ---- 标记与状态点 --------------------------------------------------------
  ".chk_badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:9px;border:1px solid var(--chk-line);background:0 0;font-size:var(--chk-fs-badge);font-weight:500;line-height:1;color:var(--chk-fg-tertiary);white-space:nowrap}",
  ".chk_badge[data-tone=accent]{color:var(--chk-accent);border-color:var(--chk-accent)}",
  ".chk_badge[data-tone=warn]{color:var(--chk-warn);border-color:var(--chk-warn)}",
  ".chk_badge[data-tone=danger]{color:var(--chk-danger);border-color:var(--chk-danger)}",
  ".chk_dot{display:inline-block;flex:none;width:var(--chk-dot);height:var(--chk-dot);border-radius:50%;background:var(--chk-idle)}",
  ".chk_dot[data-tone=idle]{background:var(--chk-idle)}",
  ".chk_dot[data-tone=active]{background:var(--chk-accent)}",
  ".chk_dot[data-tone=failed]{background:var(--chk-danger)}",
  ".chk_dot[data-tone=cooling]{background:var(--chk-warn)}",

  // ---- 列表脚注（「另有 N 个空的… · 显示」）---------------------------------
  ".chk_foot{display:flex;align-items:center;gap:var(--chk-sp2);flex:none;padding:0 2px}",
  ".chk_footText{font-size:var(--chk-fs-small);color:var(--chk-fg-caption)}",
  ".chk_footAction{cursor:pointer;border:none;background:none;padding:0;font:inherit;font-size:var(--chk-fs-small);color:var(--chk-fg-secondary);text-decoration:underline;text-underline-offset:2px;border-radius:var(--chk-radius-control)}",
  ".chk_footAction:hover{color:var(--chk-fg-primary)}",

  // ---- 横幅 ----------------------------------------------------------------
  ".chk_banner{display:flex;align-items:center;gap:var(--chk-sp3);flex:none;padding:var(--chk-sp2) var(--chk-sp4);border:1px solid var(--chk-line-weak);border-left:3px solid var(--chk-fg-tertiary);border-radius:var(--chk-radius-container);background:var(--chk-surface);font-size:var(--chk-fs-small);color:var(--chk-fg-secondary)}",
  ".chk_banner[data-tone=warn]{border-left-color:var(--chk-warn)}",
  ".chk_banner[data-tone=danger]{border-left-color:var(--chk-danger)}",
  ".chk_banner[data-tone=accent]{border-left-color:var(--chk-accent)}",
  ".chk_bannerBody{flex:1;min-width:0;line-height:18px}",
  ".chk_bannerAction{cursor:pointer;flex:none;background:0 0;border:none;padding:2px 4px;font:inherit;font-size:var(--chk-fs-small);color:var(--chk-fg-secondary);text-decoration:underline;text-underline-offset:2px;border-radius:var(--chk-radius-control)}",
  ".chk_bannerAction:hover{color:var(--chk-fg-primary);background:var(--chk-hover)}",

  // ---- 空状态 / 骨架屏 -----------------------------------------------------
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

  // ---- 抽屉 ----------------------------------------------------------------
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

  // ---- Section / KeyValue --------------------------------------------------
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

  // ---- 更多菜单 ------------------------------------------------------------
  ".chk_dangerButton{color:var(--chk-danger);opacity:.85}",
  ".chk_more{display:inline-flex}",
  ".chk_moreButton{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;background:0 0;border:1px solid var(--chk-line-weak);border-radius:var(--chk-radius-control);color:var(--chk-fg-secondary);font-size:14px;line-height:1;padding:0}",
  ".chk_moreButton:hover{background:var(--chk-hover);color:var(--chk-fg-primary)}",
  ".chk_iconButton{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;background:0 0;border:none;border-radius:var(--chk-radius-control);color:var(--chk-fg-tertiary);font-size:13px;line-height:1}",
  ".chk_iconButton:hover{background:var(--chk-hover);color:var(--chk-fg-primary)}",
  ".chk_iconButton:focus-visible{outline:2px solid var(--chk-focus);outline-offset:1px}",

  // ---- 预览面板（只在 ?hubKitPreview=1 时出现，见 preview.tsx）--------------
  ".chk_preview{display:flex;flex-direction:column;gap:var(--chk-sp5);flex:none;padding-bottom:var(--chk-sp5)}",
  ".chk_previewBand{display:flex;flex-direction:column;gap:var(--chk-sp3)}",
  ".chk_previewCaption{margin:0;font-size:var(--chk-fs-badge);font-weight:500;color:var(--chk-fg-caption);letter-spacing:.04em;text-transform:uppercase}",
  ".chk_previewNote{margin:0;font-size:var(--chk-fs-small);color:var(--chk-fg-tertiary);line-height:18px}",

  // ---- 动画 ----------------------------------------------------------------
  "@keyframes chk_slide{from{transform:translateX(100%)}to{transform:translateX(0)}}",
  "@keyframes chk_fade{from{opacity:0}to{opacity:1}}",
  "@keyframes chk_pulse{0%,100%{opacity:.45}50%{opacity:.9}}",
  "@media (prefers-reduced-motion:reduce){.chk_drawer,.chk_drawerMask{animation:none;transition:none}.chk_rowActions,.chk_rowChevron,.chk_sectionChevron{transition:none}.chk_skeletonBar{animation:none}}",
  "@media (max-width:720px){.chk_search{width:100%}.chk_toolbarEnd{width:100%}}",
].join("");

/** kit 的类名表（键是语义名）。 */
export const kit = {
  toolbar: PREFIX + "toolbar",
  toolbarStart: PREFIX + "toolbarStart",
  toolbarSpacer: PREFIX + "toolbarSpacer",
  toolbarAfterFilters: PREFIX + "toolbarAfterFilters",
  select: PREFIX + "select",
  check: PREFIX + "check",
  toolbarEnd: PREFIX + "toolbarEnd",
  search: PREFIX + "search",
  segments: PREFIX + "segments",
  segment: PREFIX + "segment",
  segmentCount: PREFIX + "segmentCount",
  surface: PREFIX + "surface",
  group: PREFIX + "group",
  groupHead: PREFIX + "groupHead",
  groupTitle: PREFIX + "groupTitle",
  groupMeta: PREFIX + "groupMeta",
  groupSpacer: PREFIX + "groupSpacer",
  groupCount: PREFIX + "groupCount",
  groupBadges: PREFIX + "groupBadges",
  groupHeadWrap: PREFIX + "groupHeadWrap",
  groupEnd: PREFIX + "groupEnd",
  nested: PREFIX + "nested",
  rows: PREFIX + "rows",
  rowsEmpty: PREFIX + "rowsEmpty",
  row: PREFIX + "row",
  rowLeading: PREFIX + "rowLeading",
  rowMain: PREFIX + "rowMain",
  rowTitleLine: PREFIX + "rowTitleLine",
  rowTitle: PREFIX + "rowTitle",
  rowTag: PREFIX + "rowTag",
  rowBadges: PREFIX + "rowBadges",
  rowSub: PREFIX + "rowSub",
  rowEnd: PREFIX + "rowEnd",
  rowActions: PREFIX + "rowActions",
  rowAction: PREFIX + "rowAction",
  rowChevron: PREFIX + "rowChevron",
  dragHandle: PREFIX + "dragHandle",
  badge: PREFIX + "badge",
  dot: PREFIX + "dot",
  foot: PREFIX + "foot",
  footText: PREFIX + "footText",
  footAction: PREFIX + "footAction",
  banner: PREFIX + "banner",
  bannerBody: PREFIX + "bannerBody",
  bannerAction: PREFIX + "bannerAction",
  empty: PREFIX + "empty",
  emptyTitle: PREFIX + "emptyTitle",
  emptyText: PREFIX + "emptyText",
  skeleton: PREFIX + "skeleton",
  skeletonRow: PREFIX + "skeletonRow",
  skeletonBar: PREFIX + "skeletonBar",
  skeletonStack: PREFIX + "skeletonStack",
  drawerLayer: PREFIX + "drawerLayer",
  drawerMask: PREFIX + "drawerMask",
  drawer: PREFIX + "drawer",
  drawerHead: PREFIX + "drawerHead",
  drawerHeadText: PREFIX + "drawerHeadText",
  drawerTitle: PREFIX + "drawerTitle",
  drawerSub: PREFIX + "drawerSub",
  drawerHeadEnd: PREFIX + "drawerHeadEnd",
  drawerBody: PREFIX + "drawerBody",
  drawerFoot: PREFIX + "drawerFoot",
  drawerFootSpacer: PREFIX + "drawerFootSpacer",
  section: PREFIX + "section",
  sectionHead: PREFIX + "sectionHead",
  sectionTitle: PREFIX + "sectionTitle",
  sectionChevron: PREFIX + "sectionChevron",
  sectionEnd: PREFIX + "sectionEnd",
  sectionBody: PREFIX + "sectionBody",
  kv: PREFIX + "kv",
  kvKey: PREFIX + "kvKey",
  kvValue: PREFIX + "kvValue",
  scope: PREFIX + "scope",
  preview: PREFIX + "preview",
  previewBand: PREFIX + "previewBand",
  previewCaption: PREFIX + "previewCaption",
  previewNote: PREFIX + "previewNote",
  dangerButton: PREFIX + "dangerButton",
  more: PREFIX + "more",
  moreButton: PREFIX + "moreButton",
  iconButton: PREFIX + "iconButton",
} as const;

/** 样式表的 id（幂等注入用）。 */
const TAG_ID = "dsh-capability-hub/kit-styles";

/** 把 kit 样式注入 <head>（幂等）。 */
export function injectKitStyles(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-capability-hub";
  tag.dataset.pluginCss = TAG_ID;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

export { CSS as KIT_CSS, TAG_ID as KIT_STYLE_TAG_ID, PREFIX as KIT_PREFIX };
