/**
 * 提示词标签页自己的样式（只用量表变量 --dsw-*，暗色/亮色主题自动适配）。
 *
 * 列表 / 工具栏 / 抽屉 / 标记 / 横幅 / 空状态 / 骨架屏全部来自 kit（src/kit/，前缀 chk_），
 * 这里只保留 kit 没有的形态：详情抽屉里的等宽文本框、新建对话框里的位置选项、分组里的一行说明。
 * 类名统一 chpr_ 前缀，避免和别的标签页打架。
 */

import { defineSheet, injectStyleTag } from "../../kit/css.ts";

const promptsSheet = defineSheet(
  "chpr_",
  [
    "root",
    "note",
    "errorBox",
    "treeNote",
    "editorWrap",
    "editor",
    "dialogBody",
    "optionRow",
    "optionMain",
    "optionTitle",
    "optionHint",
    "optionOff",
    "fieldError",
  ],
  [
    // 标签正文：工具栏 + 列表 + 底部合计，间距走 16 的阶梯。
    ".chpr_root{display:flex;flex-direction:column;gap:16px;min-height:0;flex:none}",
    ".chpr_note{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-word}",
    ".chpr_errorBox{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary,var(--dsw-alias-border-l2));border-radius:10px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));word-break:break-word}",
    // 分组里的一行说明（没有工作区 / 这一组还没有提示词）：与行同样的左右留白。
    ".chpr_treeNote{padding:12px 16px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l1);list-style:none}",
    ".chpr_treeNote:first-child{border-top:none}",
    // 详情抽屉：等宽多行文本框（与 MCP 的 JSON 编辑同一形态）。
    ".chpr_editorWrap{display:flex;flex-direction:column;gap:8px;min-width:0}",
    '.chpr_editor{width:100%;min-height:340px;box-sizing:border-box;resize:vertical;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,"Cascadia Mono",Consolas,Menlo,ui-monospace,monospace);font-size:12px;line-height:18px}',
    // 新建对话框：位置选项。
    ".chpr_dialogBody{display:flex;flex-direction:column;gap:10px;max-height:60vh;overflow:auto}",
    ".chpr_optionRow{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;cursor:pointer}",
    ".chpr_optionRow[data-disabled]{cursor:default;opacity:.55}",
    ".chpr_optionMain{display:flex;flex-direction:column;gap:2px;min-width:0}",
    ".chpr_optionTitle{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
    ".chpr_optionHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}",
    ".chpr_optionOff{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
    ".chpr_fieldError{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}",
  ],
);

/** 类名表。 */
export const styles = promptsSheet.classes;

const CSS = promptsSheet.css;

/** 把提示词页样式注入 <head>（幂等）。 */
export function injectPromptsStyles(): void {
  injectStyleTag("dsh-capability-hub/prompts-styles", CSS);
}

export { CSS as PROMPTS_CSS };
