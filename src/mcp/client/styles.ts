/**
 * MCP 标签页自己的样式（只用量表变量 --dsw-*，暗色/亮色主题自动适配）。
 *
 * UI-B 起：列表、工具栏、抽屉、标记、横幅、空状态、骨架屏全部来自 kit
 * （src/kit/，前缀 chk_），这里只保留 kit 不提供的部分：
 * 详情抽屉里的内容排布、字段排版、JSON 文本框与 intake（粘贴 JSON）视图。
 *
 * 与 shell/styles.ts 一致：客户端产物没有 CSS 加载器，所以把 CSS 作为字符串打进
 * bundle，再插一个 <style> 标签（幂等）。类名统一 chmcp_ 前缀，避免和别的标签页打架。
 */

import { defineSheet, injectStyleTag } from "../../kit/css.ts";

const mcpSheet = defineSheet(
  "chmcp_",
  [
    "root",
    "note",
    "failure",
    "valueMasked",
    "cacheLine",
    "muted",
    "secretHead",
    "secretGrid",
    "secretKey",
    "secretValue",
    "textButton",
    "toolList",
    "toolItem",
    "stack",
    "spacer",
    "grip",
    "field",
    "fieldLabel",
    "fieldError",
    "hint",
    "control",
    "actions",
    "small",
    "json",
    "jsonTextarea",
    "jsonErrors",
    "jsonErrorRow",
    "jsonErrorPath",
    "intakeModal",
    "intakeBody",
    "intakeToolbar",
    "intakeHint",
    "pasteRows",
    "pasteRow",
    "pasteRowHead",
    "pasteRowSummary",
    "warnList",
    "warnItem",
    "resultOk",
    "resultFail",
    "dialogBody",
    "dialogText",
  ],
  [
    // 标签正文：一行工具栏 + 列表，间距走 16 的阶梯。
    ".chmcp_root{display:flex;flex-direction:column;gap:16px;min-height:0}",
    ".chmcp_note{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
    ".chmcp_failure{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));overflow-wrap:anywhere}",
    ".chmcp_valueMasked{opacity:.7}",
    ".chmcp_cacheLine{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
    ".chmcp_muted{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
    ".chmcp_secretHead{display:flex;align-items:center;gap:8px;min-height:22px}",
    ".chmcp_secretGrid{display:grid;grid-template-columns:112px 1fr;gap:6px 12px;min-width:0}",
    '.chmcp_secretKey{font-family:var(--ds-font-family-code,"Cascadia Mono",Consolas,Menlo,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
    '.chmcp_secretValue{font-family:var(--ds-font-family-code,"Cascadia Mono",Consolas,Menlo,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
    ".chmcp_textButton{cursor:pointer;background:0 0;border:none;border-radius:6px;padding:4px 6px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary)}",
    ".chmcp_textButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
    ".chmcp_textButton:disabled{cursor:default;opacity:.5}",
    ".chmcp_toolList{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}",
    '.chmcp_toolItem{font-family:var(--ds-font-family-code,"Cascadia Mono",Consolas,Menlo,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
    ".chmcp_stack{display:flex;flex-direction:column;gap:8px;min-width:0}",
    ".chmcp_spacer{flex:1}",
    ".chmcp_grip{display:inline-flex;align-items:center;cursor:grab}",

    // 字段外壳与编辑器容器。
    ".chmcp_field{display:flex;flex-direction:column;gap:6px;min-width:0}",
    ".chmcp_fieldLabel{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary)}",
    ".chmcp_fieldError{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));overflow-wrap:anywhere}",
    ".chmcp_hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
    ".chmcp_control{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}",
    ".chmcp_actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
    ".chmcp_small{font-size:11px;color:var(--dsw-alias-label-tertiary)}",

    // JSON 编辑（抽屉里）。
    ".chmcp_json{display:flex;flex-direction:column;gap:16px;min-width:0}",
    '.chmcp_jsonTextarea{width:100%;min-height:340px;box-sizing:border-box;resize:vertical;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,"Cascadia Mono",Consolas,Menlo,ui-monospace,monospace);font-size:12px;line-height:18px}',
    ".chmcp_jsonErrors{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}",
    ".chmcp_jsonErrorRow{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));overflow-wrap:anywhere}",
    ".chmcp_jsonErrorPath{font-weight:600}",

    // intake（粘贴 JSON）：模态框里的视图。
    ".chmcp_intakeModal{width:min(760px,100%)}",
    ".chmcp_intakeBody{display:flex;flex-direction:column;gap:12px;min-width:0}",
    ".chmcp_intakeToolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
    ".chmcp_intakeHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
    ".chmcp_pasteRows{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}",
    ".chmcp_pasteRow{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}",
    ".chmcp_pasteRowHead{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
    '.chmcp_pasteRowSummary{margin:0;font-family:var(--ds-font-family-code,"Cascadia Mono",Consolas,Menlo,ui-monospace,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
    ".chmcp_warnList{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}",
    ".chmcp_warnItem{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
    ".chmcp_resultOk{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}",
    ".chmcp_resultFail{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}",
    // 对话框（删除确认）。
    ".chmcp_dialogBody{display:flex;flex-direction:column;gap:10px;max-height:60vh;overflow:auto}",
    ".chmcp_dialogText{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
  ],
);

/** 类名表。 */
export const styles = mcpSheet.classes;

const CSS = mcpSheet.css;

/** 把 MCP 页样式注入 <head>（幂等）。 */
export function injectMcpStyles(): void {
  injectStyleTag("dsh-capability-hub/mcp-styles", CSS);
}

export { CSS as MCP_CSS };
