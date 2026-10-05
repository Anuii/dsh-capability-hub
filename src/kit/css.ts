/**
 * 样式的写法（ADR-0004）：kit 每个组件旁边一个 `<组件>.styles.ts`，各标签页一个 `styles.ts`，
 * 都用 defineSheet() 声明「类名 + 规则」，用 injectStyleTag() 注入。
 *
 *   export const toolbarSheet = kitSheet(["toolbar", "segment"], [".chk_toolbar{…}", ".chk_segment{…}"]);
 *
 * 约定（UI-DESIGN §1）：
 *   - 每张样式有自己的类名前缀：kit = chk_，外壳 = ch_，技能页 = chsk_，MCP 页 = chmcp_，「运行中」= chrt_；
 *   - 颜色只用主题变量（kit 的 --chk-* token 在 tokens.styles.ts 里映射到 DSH 的 --dsw-*），绝不写死颜色；
 *   - 规则里直接写完整类名（.chk_toolbar），方便全文搜索；单测检查每个声明的类名都有规则。
 */

/** kit 的类名前缀。 */
export const KIT_PREFIX = "chk_";

/** 一张样式：语义名 → 类名，加上这些类的 CSS 文本。 */
export interface Sheet<K extends string> {
  classes: { readonly [P in K]: string };
  css: string;
}

export function defineSheet<K extends string>(prefix: string, names: readonly K[], rules: readonly string[]): Sheet<K> {
  const classes = {} as { [P in K]: string };
  for (const name of names) classes[name] = prefix + name;
  return { classes, css: rules.join("") };
}

/** kit 组件的样式（前缀 chk_）。 */
export function kitSheet<K extends string>(names: readonly K[], rules: readonly string[]): Sheet<K> {
  return defineSheet(KIT_PREFIX, names, rules);
}

/** 把一张样式插进 <head>（按 id 幂等；没有 document 时什么也不做，方便 node:test）。 */
export function injectStyleTag(id: string, css: string): void {
  if (typeof document === "undefined") return;
  if (document.querySelector("style[data-plugin-css=" + JSON.stringify(id) + "]") !== null) return;
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-capability-hub";
  tag.dataset.pluginCss = id;
  tag.textContent = css;
  document.head.appendChild(tag);
}
