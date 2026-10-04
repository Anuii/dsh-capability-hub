/**
 * MCP 标签页自己的样式（只用量表变量 --dsw-*，暗色/亮色主题自动适配）。
 *
 * UI-B 起：列表、工具栏、抽屉、标记、横幅、空状态、骨架屏全部来自 kit
 * （src/client/shell/kit/，前缀 chk_），这里只保留 kit 不提供的部分：
 * 详情抽屉里的内容排布、表单字段排版、JSON 文本框、intake 视图与设置抽屉。
 *
 * 与 shell/styles.ts 一致：客户端产物没有 CSS 加载器，所以把 CSS 作为字符串打进
 * bundle，再插一个 <style> 标签（幂等）。类名统一 chmcp_ 前缀，避免和别的标签页打架。
 */

const PREFIX = "chmcp_";

const CSS = [
  // 标签正文：一行工具栏 + 列表，间距走 16 的阶梯。
  ".chmcp_root{display:flex;flex-direction:column;gap:16px;min-height:0}",
  ".chmcp_note{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
  ".chmcp_failure{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));overflow-wrap:anywhere}",
  ".chmcp_cooldown{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}",
  ".chmcp_value{margin:0;font-family:var(--ds-font-family-code,\"Cascadia Mono\",Consolas,Menlo,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
  ".chmcp_valueMasked{opacity:.7}",
  ".chmcp_mono{font-family:var(--ds-font-family-code,\"Cascadia Mono\",Consolas,Menlo,ui-monospace,monospace);font-size:12px}",
  ".chmcp_cacheLine{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
  ".chmcp_muted{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
  ".chmcp_secretHead{display:flex;align-items:center;gap:8px;min-height:22px}",
  ".chmcp_secretGrid{display:grid;grid-template-columns:112px 1fr;gap:6px 12px;min-width:0}",
  ".chmcp_secretKey{font-family:var(--ds-font-family-code,\"Cascadia Mono\",Consolas,Menlo,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
  ".chmcp_secretValue{font-family:var(--ds-font-family-code,\"Cascadia Mono\",Consolas,Menlo,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
  ".chmcp_textButton{cursor:pointer;background:0 0;border:none;border-radius:6px;padding:4px 6px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary)}",
  ".chmcp_textButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
  ".chmcp_textButton:disabled{cursor:default;opacity:.5}",
  ".chmcp_toolList{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}",
  ".chmcp_toolItem{font-family:var(--ds-font-family-code,\"Cascadia Mono\",Consolas,Menlo,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
  ".chmcp_stack{display:flex;flex-direction:column;gap:8px;min-width:0}",
  ".chmcp_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
  ".chmcp_spacer{flex:1}",
  ".chmcp_grip{display:inline-flex;align-items:center;cursor:grab}",

  // 表单：字段外壳 + 各种编辑器。
  ".chmcp_form{display:flex;flex-direction:column;gap:16px;min-width:0}",
  ".chmcp_formFields{display:flex;flex-direction:column;gap:14px;min-width:0}",
  ".chmcp_field{display:flex;flex-direction:column;gap:6px;min-width:0}",
  ".chmcp_fieldHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
  ".chmcp_fieldLabel{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary)}",
  ".chmcp_fieldBadges{display:flex;align-items:center;gap:6px;margin-left:auto}",
  ".chmcp_fieldError{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));overflow-wrap:anywhere}",
  ".chmcp_hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
  ".chmcp_control{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}",
  ".chmcp_controlGrow{flex:1;min-width:200px}",
  ".chmcp_recordRow{display:flex;align-items:center;gap:6px;min-width:0}",
  ".chmcp_recordKey{width:180px;flex:none}",
  ".chmcp_recordValue{flex:1;min-width:160px}",
  ".chmcp_select{padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:12px}",
  ".chmcp_commandBox{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}",
  ".chmcp_commandOk{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
  ".chmcp_commandWarn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-primary));overflow-wrap:anywhere}",
  ".chmcp_serverErrors{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}",
  ".chmcp_serverErrorItem{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));overflow-wrap:anywhere}",
  ".chmcp_actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
  ".chmcp_small{font-size:11px;color:var(--dsw-alias-label-tertiary)}",

  // JSON 编辑（抽屉里）。
  ".chmcp_json{display:flex;flex-direction:column;gap:16px;min-width:0}",
  ".chmcp_jsonTextarea{width:100%;min-height:340px;box-sizing:border-box;resize:vertical;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,\"Cascadia Mono\",Consolas,Menlo,ui-monospace,monospace);font-size:12px;line-height:18px}",
  ".chmcp_jsonErrors{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}",
  ".chmcp_jsonErrorRow{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));overflow-wrap:anywhere}",
  ".chmcp_jsonErrorPath{font-weight:600}",

  // 全局设置抽屉。
  ".chmcp_settings{display:flex;flex-direction:column;gap:16px;min-width:0}",
  ".chmcp_settingRow{display:flex;flex-direction:column;gap:6px;min-width:0}",

  // intake（粘贴 JSON / 预设模板 / 导入）：模态框里的三个视图。
  ".chmcp_intakeModal{width:min(760px,100%)}",
  ".chmcp_intakeBody{display:flex;flex-direction:column;gap:12px;min-width:0}",
  ".chmcp_intakeToolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
  ".chmcp_intakeHint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
  ".chmcp_pasteRows{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}",
  ".chmcp_pasteRow{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}",
  ".chmcp_pasteRowHead{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
  ".chmcp_pasteRowSummary{margin:0;font-family:var(--ds-font-family-code,\"Cascadia Mono\",Consolas,Menlo,ui-monospace,monospace);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
  ".chmcp_warnList{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}",
  ".chmcp_warnItem{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
  ".chmcp_resultOk{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}",
  ".chmcp_resultFail{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}",
  ".chmcp_presetList{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px}",
  ".chmcp_presetCard{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}",
  ".chmcp_presetTitle{margin:0;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary)}",
  ".chmcp_presetDesc{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
  ".chmcp_presetFoot{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
  ".chmcp_importSection{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}",
  ".chmcp_importHead{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
  ".chmcp_importTitle{margin:0;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary)}",
  ".chmcp_importList{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}",
  ".chmcp_importRow{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1)}",
  ".chmcp_importRow:first-child{border-top:none;padding-top:0}",
  ".chmcp_importMeta{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}",
  ".chmcp_importResult{display:flex;flex-direction:column;gap:4px}",
  ".chmcp_skippedRow{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}",

  // 对话框（删除确认）。
  ".chmcp_dialogBody{display:flex;flex-direction:column;gap:10px;max-height:60vh;overflow:auto}",
  ".chmcp_dialogText{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
].join("");

/** 类名表。 */
export const styles = {
  root: PREFIX + "root",
  note: PREFIX + "note",
  failure: PREFIX + "failure",
  cooldown: PREFIX + "cooldown",
  value: PREFIX + "value",
  valueMasked: PREFIX + "valueMasked",
  mono: PREFIX + "mono",
  cacheLine: PREFIX + "cacheLine",
  muted: PREFIX + "muted",
  secretHead: PREFIX + "secretHead",
  secretGrid: PREFIX + "secretGrid",
  secretKey: PREFIX + "secretKey",
  secretValue: PREFIX + "secretValue",
  textButton: PREFIX + "textButton",
  toolList: PREFIX + "toolList",
  toolItem: PREFIX + "toolItem",
  stack: PREFIX + "stack",
  row: PREFIX + "row",
  spacer: PREFIX + "spacer",
  grip: PREFIX + "grip",
  form: PREFIX + "form",
  formFields: PREFIX + "formFields",
  field: PREFIX + "field",
  fieldHead: PREFIX + "fieldHead",
  fieldLabel: PREFIX + "fieldLabel",
  fieldBadges: PREFIX + "fieldBadges",
  fieldError: PREFIX + "fieldError",
  hint: PREFIX + "hint",
  control: PREFIX + "control",
  controlGrow: PREFIX + "controlGrow",
  recordRow: PREFIX + "recordRow",
  recordKey: PREFIX + "recordKey",
  recordValue: PREFIX + "recordValue",
  select: PREFIX + "select",
  commandBox: PREFIX + "commandBox",
  commandOk: PREFIX + "commandOk",
  commandWarn: PREFIX + "commandWarn",
  serverErrors: PREFIX + "serverErrors",
  serverErrorItem: PREFIX + "serverErrorItem",
  actions: PREFIX + "actions",
  small: PREFIX + "small",
  json: PREFIX + "json",
  jsonTextarea: PREFIX + "jsonTextarea",
  jsonErrors: PREFIX + "jsonErrors",
  jsonErrorRow: PREFIX + "jsonErrorRow",
  jsonErrorPath: PREFIX + "jsonErrorPath",
  settings: PREFIX + "settings",
  settingRow: PREFIX + "settingRow",
  intakeModal: PREFIX + "intakeModal",
  intakeBody: PREFIX + "intakeBody",
  intakeToolbar: PREFIX + "intakeToolbar",
  intakeHint: PREFIX + "intakeHint",
  pasteRows: PREFIX + "pasteRows",
  pasteRow: PREFIX + "pasteRow",
  pasteRowHead: PREFIX + "pasteRowHead",
  pasteRowSummary: PREFIX + "pasteRowSummary",
  warnList: PREFIX + "warnList",
  warnItem: PREFIX + "warnItem",
  resultOk: PREFIX + "resultOk",
  resultFail: PREFIX + "resultFail",
  presetList: PREFIX + "presetList",
  presetCard: PREFIX + "presetCard",
  presetTitle: PREFIX + "presetTitle",
  presetDesc: PREFIX + "presetDesc",
  presetFoot: PREFIX + "presetFoot",
  importSection: PREFIX + "importSection",
  importHead: PREFIX + "importHead",
  importTitle: PREFIX + "importTitle",
  importList: PREFIX + "importList",
  importRow: PREFIX + "importRow",
  importMeta: PREFIX + "importMeta",
  importResult: PREFIX + "importResult",
  skippedRow: PREFIX + "skippedRow",
  dialogBody: PREFIX + "dialogBody",
  dialogText: PREFIX + "dialogText",
} as const;

/** 把 MCP 页样式注入 <head>（幂等）。 */
export function injectMcpStyles(): void {
  if (typeof document === "undefined") return;
  const tagId = "dsh-capability-hub/mcp-styles";
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-capability-hub";
  tag.dataset.pluginCss = tagId;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

export { CSS as MCP_CSS };
