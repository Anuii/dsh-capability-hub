/**
 * 运行态标签自己的样式（只用主题变量 --dsw-*，暗色/亮色主题自动适配）。
 *
 * UI-B 起：工具栏、列表、行、抽屉、标记、状态点、横幅、骨架屏全部来自 kit
 * （src/kit/，前缀 chk_），这里只保留 kit 不提供的几处：
 * 行里的「自动刷新」小字、刷新图标按钮、子代理会话的缩进、抽屉里的失败与冷却文字。
 *
 * 与 shell/styles.ts 一致：把 CSS 作为字符串打进 bundle，再插一个 <style> 标签（幂等）。
 * 类名统一 chrt_ 前缀，避免和别的标签页打架。
 */

const PREFIX = "chrt_";

const CSS = [
  ".chrt_root{display:flex;flex-direction:column;gap:16px;min-height:0}",
  ".chrt_note{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
  ".chrt_autoRefresh{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
  ".chrt_switch{display:inline-flex;align-items:center;gap:8px}",
  ".chrt_switchLabel{cursor:pointer;background:0 0;border:none;padding:0;font:inherit;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
  ".chrt_switchLabel:hover{color:var(--dsw-alias-label-primary)}",
  ".chrt_switchLabel:disabled{cursor:default;color:var(--dsw-alias-label-tertiary)}",
  ".chrt_switchLabel:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:4px}",
  ".chrt_iconButton{cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;background:0 0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-secondary)}",
  ".chrt_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
  ".chrt_iconButton:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}",
  ".chrt_iconButton[disabled]{cursor:default;opacity:.5}",
  // 子代理会话缩进显示在父会话下（UI-DESIGN §6）。
  ".chrt_subGroup{margin-left:24px}",
  ".chrt_failure{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));overflow-wrap:anywhere}",
  ".chrt_cooldown{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-secondary))}",
  ".chrt_stack{display:flex;flex-direction:column;gap:6px;min-width:0}",
  ".chrt_dialogBody{display:flex;flex-direction:column;gap:10px;max-height:60vh;overflow:auto}",
  ".chrt_dialogText{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}",
  ".chrt_small{font-size:11px;color:var(--dsw-alias-label-tertiary)}",
  // 「运行中」区域（MCP 页底部）：与上方服务器列表隔开一段；空状态与横幅的内边距。
  ".chrt_region{display:flex;flex-direction:column;margin-top:8px}",
  ".chrt_empty{margin:0;padding:12px 16px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
  ".chrt_pad{padding:12px 16px}",
  ".chrt_quiet{margin:0;padding:0 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);cursor:default}",
].join("");

/** 类名表。 */
export const styles = {
  root: PREFIX + "root",
  note: PREFIX + "note",
  autoRefresh: PREFIX + "autoRefresh",
  switch: PREFIX + "switch",
  switchLabel: PREFIX + "switchLabel",
  iconButton: PREFIX + "iconButton",
  subGroup: PREFIX + "subGroup",
  failure: PREFIX + "failure",
  cooldown: PREFIX + "cooldown",
  stack: PREFIX + "stack",
  dialogBody: PREFIX + "dialogBody",
  dialogText: PREFIX + "dialogText",
  small: PREFIX + "small",
  region: PREFIX + "region",
  empty: PREFIX + "empty",
  pad: PREFIX + "pad",
  quiet: PREFIX + "quiet",
} as const;

/** 把运行态页样式注入 <head>（幂等）。 */
export function injectRuntimeStyles(): void {
  if (typeof document === "undefined") return;
  const tagId = "dsh-capability-hub/runtime-styles";
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-capability-hub";
  tag.dataset.pluginCss = tagId;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

export { CSS as RUNTIME_CSS };
