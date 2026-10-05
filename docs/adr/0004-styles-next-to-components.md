# ADR-0004：样式写在组件旁边，用同一个 defineSheet 声明

日期：2026-10-05 · 状态：已采纳

## 背景
客户端没有 CSS 加载器（产物是 DSH 的 `__ModuleLoader__` 格式），样式一直是 TS 里的字符串。到 0.3.4 时 kit 的全部样式挤在一个 340 行的 `styles.ts` 里，是最近改动最频繁的文件；外壳和三个标签页各自又手写了一遍「类名表（`x: PREFIX + "x"`）+ 注入 `<style>` 的函数」，共五份。

## 决定
- 样式仍写在 TS 里（单测在 node 下直接读，node 读不了 `.css`）。
- `src/kit/css.ts` 提供 `defineSheet(prefix, names, rules)`（返回类名表与 CSS 文本）、`kitSheet(names, rules)`（前缀 chk_）与 `injectStyleTag(id, css)`（按 id 幂等注入）。
- kit 每个组件旁边一个 `<组件>.styles.ts`（`Toolbar.styles.ts`、`ListSurface.styles.ts`……），全局 token 与开关缩放在 `tokens.styles.ts`，标签页直接用的原生控件在 `controls.styles.ts`；`styles.ts` 只按层叠顺序把它们合成一张 `<style>`。
- 外壳与各标签页的 `styles.ts` 改用 `defineSheet` / `injectStyleTag`，不再各写一份类名表与注入函数。
- 单测检查：每个声明的类名都有规则；每张 kit 样式片段只写自己声明的类（防止样式又散回别处）。

## 后果
- 改一个组件的样式只打开它旁边的文件。
- 拆分前后 CSS 规则集合相同（唯一变化：一条 prefers-reduced-motion 媒体查询按组件拆成四条）；四张标签页样式表逐字节相同。
