/**
 * 技能标签页自己的样式（只用量表变量 --dsw-*，暗色/亮色主题自动适配）。
 *
 * UI-A 起：列表 / 工具栏 / 抽屉 / 标记 / 空状态 / 骨架屏 **全部由 kit 提供**
 * （src/client/shell/kit/，类名前缀 chk_），这里只剩 kit 没有的形态：
 *   - 详情抽屉里的诊断清单、文件清单、SKILL.md 代码块容器；
 *   - 「添加技能」抽屉里自己拼的表单行、勾选清单、候选清单；
 *   - 一处错误提示与分组底部那一行小字。
 *
 * 与 shell/styles.ts 一样：客户端产物没有 CSS 加载器，所以把 CSS 作为字符串打进
 * bundle，再插一个 <style> 标签（幂等）。类名统一 chsk_ 前缀，避免和别的标签页打架。
 */

const PREFIX = "chsk_";

const CSS = [
  // flex:none 很关键：外壳的 .ch_content 是 flex 容器，默认 flex-shrink:1 会把列表压扁。
  `.${PREFIX}root{display:flex;flex-direction:column;gap:16px;min-height:0;flex:none}`,
  `.${PREFIX}errorBox{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary,var(--dsw-alias-border-l2));border-radius:10px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));word-break:break-word}`,
  `.${PREFIX}loading{margin:0;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}`,
  `.${PREFIX}note{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}`,
  // 列表底部那一行「另有 N 个空的技能目录 · 显示」已经收进 kit 的 ListFoot（.chk_foot）。
  // 详情：按 4/8/12/16 的阶梯排
  `.${PREFIX}diag{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}`,
  `.${PREFIX}diagRow{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;line-height:18px}`,
  `.${PREFIX}diagText{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);word-break:break-word}`,
  `.${PREFIX}code{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-family)}`,
  `.${PREFIX}codeWrap{max-height:340px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}`,
  `.${PREFIX}files{max-height:260px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:6px 10px}`,
  `.${PREFIX}fileRow{display:flex;align-items:center;gap:8px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}`,
  `.${PREFIX}fileName{flex:1;min-width:0;word-break:break-all;font-family:var(--dsw-font-family)}`,
  `.${PREFIX}fileDir{color:var(--dsw-alias-label-primary);font-weight:600}`,
  `.${PREFIX}fileSize{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}`,
  // 路径整段换行显示（不截断、不渐隐）
  `.${PREFIX}pathWrap{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family);word-break:break-all;white-space:normal}`,
  // 详情小节里的一行动作按钮
  `.${PREFIX}slotRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}`,
  // 添加技能抽屉：表单
  `.${PREFIX}form{display:flex;flex-direction:column;gap:12px}`,
  `.${PREFIX}inlineRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}`,
  `.${PREFIX}grow{flex:1;min-width:160px}`,
  // 添加技能抽屉：一行里「占满剩余宽度 + 固定 140px + 按钮靠右」，全部落在 8px 网格上
  `.${PREFIX}repoRow{display:flex;align-items:center;gap:8px}`,
  `.${PREFIX}repoGrow{display:flex;flex:1 1 auto;min-width:0}`,
  `.${PREFIX}repoGrow>span{flex:1;min-width:0}`,
  `.${PREFIX}repoGrow input{width:100%}`,
  `.${PREFIX}refGrow{display:flex;flex:0 0 140px;width:140px;min-width:0}`,
  `.${PREFIX}refGrow>span{flex:1;min-width:0}`,
  `.${PREFIX}refGrow input{width:100%}`,
  // 常用仓库胶囊：× 只在悬停 / 聚焦时出现（预置与自定义一样，保留删除能力）
  `.${PREFIX}chip{display:inline-flex;align-items:center;gap:2px}`,
  `.${PREFIX}chipRemove{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:none;background:none;border-radius:6px;font:inherit;font-size:12px;line-height:1;color:var(--dsw-alias-label-tertiary);opacity:0;transition:opacity 120ms ease-out}`,
  `.${PREFIX}chip:hover .${PREFIX}chipRemove,.${PREFIX}chip:focus-within .${PREFIX}chipRemove{opacity:1}`,
  `.${PREFIX}chipRemove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
  `.${PREFIX}fieldLabel{font-size:12px;color:var(--dsw-alias-label-tertiary)}`,
  `.${PREFIX}chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}`,
  // 勾选清单 / 候选清单
  `.${PREFIX}browseList{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;max-height:320px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}`,
  `.${PREFIX}browseRow{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1)}`,
  `.${PREFIX}browseRow:first-child{border-top:none}`,
  `.${PREFIX}browseMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}`,
  `.${PREFIX}candidate{display:flex;flex-direction:column;gap:4px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1)}`,
  `.${PREFIX}candidateMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}`,
  // 候选行的勾选框标签：不许它吃掉整行宽度（标签可能是很长的候选键）
  `.${PREFIX}candidateLabel{flex:none;max-width:240px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}`,
  `.${PREFIX}resultList{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}`,
  `.${PREFIX}resultRow{display:flex;align-items:center;gap:8px;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary);padding:2px 0}`,
  // 宿主 Modal 的内容区（对话框用）
  `.${PREFIX}modalBody{display:flex;flex-direction:column;gap:10px;max-height:60vh;overflow:auto}`,
  `.${PREFIX}fieldError{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}`,
].join("");

/** 类名表。 */
export const styles = {
  root: PREFIX + "root",
  errorBox: PREFIX + "errorBox",
  loading: PREFIX + "loading",
  note: PREFIX + "note",
  diag: PREFIX + "diag",
  diagRow: PREFIX + "diagRow",
  diagText: PREFIX + "diagText",
  code: PREFIX + "code",
  codeWrap: PREFIX + "codeWrap",
  files: PREFIX + "files",
  fileRow: PREFIX + "fileRow",
  fileName: PREFIX + "fileName",
  fileDir: PREFIX + "fileDir",
  fileSize: PREFIX + "fileSize",
  pathWrap: PREFIX + "pathWrap",
  slotRow: PREFIX + "slotRow",
  form: PREFIX + "form",
  inlineRow: PREFIX + "inlineRow",
  grow: PREFIX + "grow",
  fieldLabel: PREFIX + "fieldLabel",
  chips: PREFIX + "chips",
  repoRow: PREFIX + "repoRow",
  repoGrow: PREFIX + "repoGrow",
  refGrow: PREFIX + "refGrow",
  chip: PREFIX + "chip",
  chipRemove: PREFIX + "chipRemove",
  browseList: PREFIX + "browseList",
  browseRow: PREFIX + "browseRow",
  browseMain: PREFIX + "browseMain",
  candidate: PREFIX + "candidate",
  candidateMain: PREFIX + "candidateMain",
  candidateLabel: PREFIX + "candidateLabel",
  resultList: PREFIX + "resultList",
  resultRow: PREFIX + "resultRow",
  modalBody: PREFIX + "modalBody",
  fieldError: PREFIX + "fieldError",
} as const;

/** 把技能页样式注入 <head>（幂等）。 */
export function injectSkillsStyles(): void {
  if (typeof document === "undefined") return;
  const tagId = "dsh-capability-hub/skills-styles";
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-capability-hub";
  tag.dataset.pluginCss = tagId;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

export { CSS as SKILLS_CSS };
