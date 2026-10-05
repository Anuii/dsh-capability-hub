/**
 * 外壳样式：类名 + 一段 CSS 字符串（与主题变量配合）。
 *
 * 为什么不用 .css 文件：客户端产物由 esbuild 打成单个 JS 文件、以经典 <script> 投递，
 * 没有 CSS 加载器。社区插件的做法也是把 CSS 作为字符串打进 bundle 再插 <style>
 * （见 @linxin666/dsh-client-ui-skill-explorer/lib/client.js:371-380）。
 *
 * 【UI-0 变更】外壳只负责「页头 + 标签 + 内容容器」；列表、抽屉、标记、横幅等
 * 一律来自 kit（src/kit/，前缀 chk_）。这里保留的是页面骨架与
 * 诊断模态框内部的排版。
 *
 * 颜色一律用 DSH 主题变量（--dsw-*），绝不写死。
 */

import { defineSheet, injectStyleTag } from "../../kit/css.ts";

const shellSheet = defineSheet(
  "ch_",
  [
    "page",
    "header",
    "headerBar",
    "title",
    "infoButton",
    "tabBar",
    "tab",
    "tabDot",
    "content",
    "tabPane",
    "diagModal",
    "diagContent",
    "diagBody",
    "placeholder",
    "placeholderText",
    "button",
    "muted",
    "error",
    "kv",
    "kvKey",
    "kvValue",
  ],
  [
    // 页面骨架：页头（标题 + ⓘ）+ 下划线式标签 + 内容区。
    ".ch_page{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);overflow:hidden}",
    // 宽屏时页头与正文都限制在 1140px 以内（左对齐）：描述不会被拉得过长，开关也不会离名称太远。
    ".ch_header{flex:none;display:flex;flex-direction:column;gap:14px;padding:18px 20px 0;width:100%;max-width:1180px;box-sizing:border-box}",
    ".ch_headerBar{display:flex;align-items:center;gap:8px}",
    ".ch_title{margin:0;flex:1;min-width:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}",
    ".ch_infoButton{cursor:pointer;flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;background:0 0;border:none;border-radius:6px;color:var(--dsw-alias-label-tertiary);font-size:15px;line-height:1}",
    ".ch_infoButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
    ".ch_infoButton:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
    ".ch_tabBar{display:flex;gap:20px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
    ".ch_tab{cursor:pointer;white-space:nowrap;background:0 0;border:none;border-bottom:2px solid transparent;padding:0 0 9px;margin-bottom:-1px;font:inherit;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
    ".ch_tab:hover{color:var(--dsw-alias-label-primary)}",
    ".ch_tab[data-active]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:500}",
    ".ch_tab:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:2px}",
    ".ch_tab{display:inline-flex;align-items:center;gap:5px}",
    ".ch_tabDot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}",
    // 内容区：横幅在最上，下面是真正可滚动的标签正文。
    ".ch_content{flex:1;min-height:0;display:flex;flex-direction:column;gap:12px;padding:12px 20px 20px;overflow:hidden;width:100%;max-width:1180px;box-sizing:border-box}",
    ".ch_tabPane{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;overflow:auto}",
    ".ch_tabPane[hidden]{display:none}",
    // 诊断模态框正文。
    // 诊断模态框：宿主 Modal 默认很窄，等宽的路径列会被折成好几行，给个下限。
    ".ch_diagModal{min-width:560px;max-width:calc(100vw - 96px)}",
    ".ch_diagContent{min-width:0}",
    ".ch_diagBody{display:flex;flex-direction:column;gap:8px;min-width:0}",
    // 插件管理页那一行的配置视图（config-button.tsx）。它不在能力中心页面里，
    // 拿不到 kit 的 --chk-* token，所以就这么三行朴素样式。
    ".ch_placeholder{display:flex;flex-direction:column;gap:10px;padding:14px 0}",
    ".ch_placeholderText{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}",
    ".ch_button{cursor:pointer;align-self:flex-start;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;color:var(--dsw-alias-label-primary);font-size:12px;padding:5px 12px}",
    ".ch_button:hover{background:var(--dsw-alias-interactive-bg-hover)}",
    ".ch_muted{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
    ".ch_error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}",
    ".ch_kv{display:grid;grid-template-columns:112px 1fr;gap:4px 10px;margin:0}",
    ".ch_kvKey{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
    // 等宽用 DSH 自己的代码字体变量（--ds- 前缀，主题 base.css 的 :root 里定义）；
    // 退回泛型 monospace 会在中文系统上落到中文等宽字体，字距松散。
    '.ch_kvValue{margin:0;font-size:12px;font-family:var(--ds-font-family-code,"Cascadia Mono",Consolas,Menlo,ui-monospace,monospace);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
  ],
);

/** 类名表。 */
export const styles = shellSheet.classes;

const CSS = shellSheet.css;

/** 把样式注入 <head>（幂等）。 */
export function injectStyles(): void {
  injectStyleTag("dsh-capability-hub/styles", CSS);
}

export { CSS };
