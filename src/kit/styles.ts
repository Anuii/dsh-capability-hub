/**
 * kit 的样式表：把各组件旁边的 *.styles.ts 合成一张 <style>（ADR-0004）。
 *
 * 顺序就是层叠顺序：token 在最前，组件之后。kit 的样式表与外壳的样式表是两张 <style>（id 不同），
 * 两边都可以独立热更新。
 */

import { KIT_PREFIX, injectStyleTag } from "./css.ts";
import { tokensSheet } from "./tokens.styles.ts";
import { toolbarSheet } from "./Toolbar.styles.ts";
import { controlsSheet } from "./controls.styles.ts";
import { listSurfaceSheet } from "./ListSurface.styles.ts";
import { badgeSheet } from "./Badge.styles.ts";
import { feedbackSheet } from "./Feedback.styles.ts";
import { drawerSheet } from "./Drawer.styles.ts";
import { sectionSheet } from "./Section.styles.ts";
import { menuSheet } from "./menu.styles.ts";
import { previewSheet } from "./preview.styles.ts";

const SHEETS = [
  tokensSheet,
  toolbarSheet,
  controlsSheet,
  listSurfaceSheet,
  badgeSheet,
  feedbackSheet,
  drawerSheet,
  sectionSheet,
  menuSheet,
  previewSheet,
] as const;

const CSS = SHEETS.map((entry) => entry.css).join("");

/** kit 的类名表（键是语义名）。 */
export const kit = {
  ...tokensSheet.classes,
  ...toolbarSheet.classes,
  ...controlsSheet.classes,
  ...listSurfaceSheet.classes,
  ...badgeSheet.classes,
  ...feedbackSheet.classes,
  ...drawerSheet.classes,
  ...sectionSheet.classes,
  ...menuSheet.classes,
  ...previewSheet.classes,
};

/** 样式表的 id（幂等注入用）。 */
const TAG_ID = "dsh-capability-hub/kit-styles";

/** 把 kit 样式注入 <head>（幂等）。 */
export function injectKitStyles(): void {
  injectStyleTag(TAG_ID, CSS);
}

/** 每张样式片段（单测检查「每个声明的类名都有规则、规则只写自己的类」）。 */
export const KIT_SHEETS = SHEETS;

export { CSS as KIT_CSS, TAG_ID as KIT_STYLE_TAG_ID, KIT_PREFIX };
