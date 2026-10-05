/**
 * 技能标签页自己的样式（只用量表变量 --dsw-*，暗色/亮色主题自动适配）。
 *
 * UI-A 起：列表 / 工具栏 / 抽屉 / 标记 / 空状态 / 骨架屏 **全部由 kit 提供**
 * （src/kit/，类名前缀 chk_），这里只剩 kit 没有的形态：
 *   - 详情抽屉里的诊断清单、文件清单、SKILL.md 代码块容器；
 *   - 「添加技能」抽屉里自己拼的表单行、勾选清单、候选清单；
 *   - 一处错误提示与分组底部那一行小字。
 *
 * 与 shell/styles.ts 一样：客户端产物没有 CSS 加载器，所以把 CSS 作为字符串打进
 * bundle，再插一个 <style> 标签（幂等）。类名统一 chsk_ 前缀，避免和别的标签页打架。
 */

import { defineSheet, injectStyleTag } from "../../kit/css.ts";

const skillsSheet = defineSheet(
  "chsk_",
  [
    "root",
    "errorBox",
    "treeNote",
    "repoEdit",
    "scanMeta",
    "scrollBox",
    "groupStack",
    "loading",
    "note",
    "diag",
    "diagRow",
    "diagText",
    "code",
    "codeWrap",
    "files",
    "fileRow",
    "fileName",
    "fileDir",
    "fileSize",
    "pathWrap",
    "slotRow",
    "form",
    "inlineRow",
    "grow",
    "fieldLabel",
    "chips",
    "repoRow",
    "repoGrow",
    "refGrow",
    "chip",
    "chipRemove",
    "browseList",
    "browseRow",
    "browseMain",
    "candidate",
    "candidateMain",
    "candidateLabel",
    "resultList",
    "resultRow",
    "modalBody",
    "fieldError",
  ],
  [
    // flex:none 很关键：外壳的 .ch_content 是 flex 容器，默认 flex-shrink:1 会把列表压扁。
    ".chsk_root{display:flex;flex-direction:column;gap:16px;min-height:0;flex:none}",
    ".chsk_errorBox{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary,var(--dsw-alias-border-l2));border-radius:10px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));word-break:break-word}",
    ".chsk_loading{margin:0;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}",
    ".chsk_note{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-word}",
    // 列表底部那一行「另有 N 个空的技能目录 · 显示」已经收进 kit 的 ListFoot（.chk_foot）。
    // 详情：按 4/8/12/16 的阶梯排
    ".chsk_diag{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}",
    ".chsk_diagRow{display:flex;align-items:flex-start;gap:8px;font-size:12.5px;line-height:18px}",
    ".chsk_diagText{flex:1;min-width:0;color:var(--dsw-alias-label-secondary);word-break:break-word}",
    ".chsk_code{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-family)}",
    ".chsk_codeWrap{max-height:340px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}",
    ".chsk_files{max-height:260px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:6px 10px}",
    ".chsk_fileRow{display:flex;align-items:center;gap:8px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}",
    ".chsk_fileName{flex:1;min-width:0;word-break:break-all;font-family:var(--dsw-font-family)}",
    ".chsk_fileDir{color:var(--dsw-alias-label-primary);font-weight:600}",
    ".chsk_fileSize{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
    // 路径整段换行显示（不截断、不渐隐）
    ".chsk_pathWrap{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family);word-break:break-all;white-space:normal}",
    // 详情小节里的一行动作按钮
    ".chsk_slotRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
    // 添加技能抽屉：表单
    ".chsk_form{display:flex;flex-direction:column;gap:12px}",
    ".chsk_inlineRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
    ".chsk_grow{flex:1;min-width:160px}",
    // 添加技能抽屉：一行里「占满剩余宽度 + 固定 140px + 按钮靠右」，全部落在 8px 网格上
    ".chsk_repoRow{display:flex;align-items:center;gap:8px}",
    ".chsk_repoGrow{display:flex;flex:1 1 auto;min-width:0}",
    ".chsk_repoGrow>span{flex:1;min-width:0}",
    ".chsk_repoGrow input{width:100%}",
    ".chsk_refGrow{display:flex;flex:0 0 140px;width:140px;min-width:0}",
    ".chsk_refGrow>span{flex:1;min-width:0}",
    ".chsk_refGrow input{width:100%}",
    // 常用仓库胶囊：× 只在悬停 / 聚焦时出现（预置与自定义一样，保留删除能力）
    ".chsk_chip{display:inline-flex;align-items:center;gap:2px}",
    ".chsk_chipRemove{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:none;background:none;border-radius:6px;font:inherit;font-size:12px;line-height:1;color:var(--dsw-alias-label-tertiary);opacity:0;transition:opacity 120ms ease-out}",
    ".chsk_chip:hover .chsk_chipRemove,.chsk_chip:focus-within .chsk_chipRemove{opacity:1}",
    ".chsk_chipRemove:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
    ".chsk_fieldLabel{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
    ".chsk_chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}",
    // 勾选清单 / 候选清单
    ".chsk_browseList{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;max-height:320px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px}",
    ".chsk_browseRow{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1)}",
    ".chsk_browseRow:first-child{border-top:none}",
    ".chsk_browseMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
    ".chsk_candidate{display:flex;flex-direction:column;gap:4px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1)}",
    ".chsk_candidateMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
    // 候选行的勾选框标签：不许它吃掉整行宽度（标签可能是很长的候选键）
    ".chsk_candidateLabel{flex:none;max-width:240px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}",
    ".chsk_resultList{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}",
    ".chsk_resultRow{display:flex;align-items:center;gap:8px;font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary);padding:2px 0}",
    // 宿主 Modal 的内容区（对话框用）
    ".chsk_modalBody{display:flex;flex-direction:column;gap:10px;max-height:60vh;overflow:auto}",
    ".chsk_fieldError{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}",
    // 技能树里的一行说明（没有工作区 / 该层级还没有技能）：与行同样的左右留白、次要色小字。
    ".chsk_treeNote{padding:12px 16px 12px 36px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-border-l1)}",
    ".chsk_treeNote:first-child{border-top:none}",
    // 仓库列表里就地展开的编辑行（分支 · 子目录 · 取消 · 保存）。
    ".chsk_repoEdit{display:flex;align-items:center;gap:8px;padding:8px 16px;border-top:1px solid var(--dsw-alias-border-l1);list-style:none}",
    // 搜索结果的固定高度滚动框（约 4 行）：结果再多也不把下面的内容顶出视野。
    ".chsk_scrollBox{max-height:232px;overflow:auto;border-radius:10px}",
    // 汇总里一个仓库分组 + 它的「再显示 200 个」：贴在一起，组与组之间的距离由 ListSurface 给。
    ".chsk_groupStack{display:flex;flex-direction:column;gap:8px}",
    // 汇总发现工具栏右侧的「上次扫描」小字。
    ".chsk_scanMeta{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
  ],
);

/** 类名表。 */
export const styles = skillsSheet.classes;

const CSS = skillsSheet.css;

/** 把技能页样式注入 <head>（幂等）。 */
export function injectSkillsStyles(): void {
  injectStyleTag("dsh-capability-hub/skills-styles", CSS);
}

export { CSS as SKILLS_CSS };
