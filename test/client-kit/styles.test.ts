/**
 * kit / 外壳样式的三道防线（在没有浏览器的情况下，这是最划算的检查）：
 *   1. 组件里引用的每一个 kit.x / styles.x 都真的存在（拼错 = 静默无样式）；
 *   2. 样式表里每个类名都有对应规则（防止死类名）；
 *   3. CSS 里不出现硬编码颜色 —— 全是 --dsw-* 主题变量（否则暗色主题会崩）。
 * 另外守两条 UI-DESIGN 的硬规则：不使用绿色；token 选择器同时覆盖 portal 出来的抽屉。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KIT_CSS, kit } from "../../src/client/shell/kit/styles.ts";
import { CSS as SHELL_CSS, styles } from "../../src/client/shell/styles.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.resolve(here, "..", "..", "src", "client", "shell");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const files = sourceFiles(shellDir).map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));

test("组件里引用的 kit.x 都存在于 kit 样式表", () => {
  const known = new Set(Object.keys(kit));
  const missing: string[] = [];
  for (const { file, text } of files) {
    for (const match of text.matchAll(/\bkit\.([A-Za-z0-9_]+)/g)) {
      if (!known.has(match[1])) missing.push(path.basename(file) + " -> kit." + match[1]);
    }
  }
  assert.deepEqual([...new Set(missing)].sort(), []);
});

test("组件里引用的 styles.x 都存在于外壳样式表", () => {
  const known = new Set(Object.keys(styles));
  const missing: string[] = [];
  for (const { file, text } of files) {
    for (const match of text.matchAll(/(?<!["/])styles\.([A-Za-z0-9_]+)/g)) {
      if (!known.has(match[1])) missing.push(path.basename(file) + " -> styles." + match[1]);
    }
  }
  assert.deepEqual([...new Set(missing)].sort(), []);
});

test("kit 样式表里每个类名都有 CSS 规则", () => {
  const dead = Object.entries(kit)
    .filter(([, className]) => !KIT_CSS.includes("." + className + "{") && !KIT_CSS.includes("." + className + " ") && !KIT_CSS.includes("." + className + ","))
    .map(([key, className]) => key + " (" + className + ")");
  assert.deepEqual(dead.sort(), []);
});

test("外壳样式表里每个类名都有 CSS 规则", () => {
  const dead = Object.entries(styles)
    .filter(([, className]) => !SHELL_CSS.includes("." + className + "{") && !SHELL_CSS.includes("." + className + " "))
    .map(([key, className]) => key + " (" + className + ")");
  assert.deepEqual(dead.sort(), []);
});

test("kit 的 CSS 只用主题变量，没有硬编码颜色", () => {
  const hardcoded = KIT_CSS.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
  assert.deepEqual(hardcoded, [], "kit 的 CSS 里出现了硬编码颜色，请改用 --dsw-* 变量");
  const plainColors = KIT_CSS.match(/:(?!\s*var\()\s*(red|blue|green|black|white|gray|grey)\b/g) ?? [];
  assert.deepEqual(plainColors, []);
});

test("外壳的 CSS 只用主题变量，没有硬编码颜色", () => {
  const hardcoded = SHELL_CSS.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g) ?? [];
  assert.deepEqual(hardcoded, []);
});

test("不使用绿色（UI-DESIGN §0.4：只用强调色 / 红 / 琥珀）", () => {
  for (const css of [KIT_CSS, SHELL_CSS]) {
    assert.equal(/success|green/i.test(css), false, "出现了绿色系 token");
  }
});

test("token 选择器同时覆盖页面根与 portal 出去的抽屉层", () => {
  assert.ok(KIT_CSS.includes("[data-dsh-capability-hub-view],.chk_scope{"));
  assert.ok(KIT_CSS.includes("." + kit.scope + "{") || KIT_CSS.includes(",." + kit.scope + "{"));
});

test("kit 的类名带 chk_ 前缀，外壳带 ch_ 前缀，互不冲突", () => {
  for (const className of Object.values(kit)) assert.ok(className.startsWith("chk_"), className);
  for (const className of Object.values(styles)) assert.ok(className.startsWith("ch_"), className);
  const overlap = Object.values(kit).filter((name) => Object.values(styles).includes(name));
  assert.deepEqual(overlap, []);
});

test("kit 覆盖了 UI-DESIGN §1 的关键容器", () => {
  const keys = ["surface", "group", "row", "badge", "dot", "drawer", "drawerMask", "section", "kv", "empty", "skeleton", "banner", "toolbar", "search", "segments"] as const;
  for (const key of keys) assert.ok(KIT_CSS.includes("." + kit[key] + "{") || KIT_CSS.includes("." + kit[key] + " "), key);
});

test("尊重 prefers-reduced-motion", () => {
  assert.ok(KIT_CSS.includes("@media (prefers-reduced-motion:reduce)"));
});

test("等宽字体用 DSH 自己的代码字体变量，不退到泛型 monospace", () => {
  assert.ok(KIT_CSS.includes("--chk-mono:var(--ds-font-family-code,"));
  assert.equal(KIT_CSS.includes("--dsw-font-family-mono"), false, "--dsw-font-family-mono 并不存在");
  assert.ok(SHELL_CSS.includes("var(--ds-font-family-code,"));
  // 兜底里仍然要有真正的等宽候选，防止变量缺失时落到比例字体
  assert.ok(KIT_CSS.includes("Consolas"));
  assert.ok(KIT_CSS.includes("ui-monospace"));
});

test("所有行都是 52px（没有副标题的行不再矮一截）", () => {
  assert.ok(KIT_CSS.includes("--chk-row-h:52px"));
  assert.equal(KIT_CSS.includes("row-h-compact"), false);
  assert.equal(KIT_CSS.includes("data-compact"), false);
  const listSurface = fs.readFileSync(path.join(shellDir, "kit", "ListSurface.tsx"), "utf8");
  assert.equal(listSurface.includes("data-compact"), false);
});

test("开关的缩小只作用于能力中心作用域内", () => {
  const switchRules = KIT_CSS.split("}").filter((rule) => rule.includes("button[role=switch]"));
  assert.equal(switchRules.length, 3, "应当有三条（轨道尺寸 / 滑块尺寸 / 打开态位移）");
  for (const rule of switchRules) {
    assert.ok(
      rule.includes("[data-dsh-capability-hub-view] button[role=switch]") || rule.startsWith(".chk_scope button[role=switch]"),
      "开关规则必须限定在 [data-dsh-capability-hub-view] 或 .chk_scope 之内：" + rule,
    );
    assert.ok(/chk-switch-(w|h|thumb|travel)/.test(rule));
  }
  // 36x20 -> 29x16，约 80%
  assert.ok(KIT_CSS.includes("--chk-switch-w:29px"));
  assert.ok(KIT_CSS.includes("--chk-switch-h:16px"));
  assert.ok(KIT_CSS.includes("--chk-switch-thumb:12px"));
  assert.ok(KIT_CSS.includes("--chk-switch-travel:13px"));
});

test("可折叠小节的折角是 12px SVG，展开时旋转 90 度", () => {
  assert.ok(KIT_CSS.includes("." + kit.sectionChevron + "{"));
  assert.ok(KIT_CSS.includes("." + kit.sectionChevron + "[data-open]{transform:rotate(90deg)}"));
  assert.ok(KIT_CSS.includes("width:12px;height:12px"));
  const icons = fs.readFileSync(path.join(shellDir, "kit", "icons.tsx"), "utf8");
  assert.ok(icons.includes("SectionChevron"));
  assert.ok(icons.includes('d: "M4.5 2.5 L8 6 L4.5 9.5"'));
  const section = fs.readFileSync(path.join(shellDir, "kit", "Section.tsx"), "utf8");
  assert.ok(section.includes("SectionChevron"));
  assert.equal(section.includes("DisclosureGlyph"), false);
});

test("抽屉底部只放真正的操作（不放多余的「关闭」）", () => {
  const drawer = fs.readFileSync(path.join(shellDir, "kit", "Drawer.tsx"), "utf8");
  assert.ok(drawer.includes("props.footer === undefined"));
  const preview = fs.readFileSync(path.join(shellDir, "kit", "preview.tsx"), "utf8");
  assert.equal(preview.includes('"关闭"'), false, "抽屉底部不应再有「关闭」按钮（已有 × 与 Esc）");
});


/* ---------------- UI-C 增量 ---------------- */

test("ListGroup 的 title 可选：不传时整条标题行都不渲染", () => {
  const listSurface = fs.readFileSync(path.join(shellDir, "kit", "ListSurface.tsx"), "utf8");
  assert.ok(listSurface.includes("title?: React.ReactNode"), "title 必须是可选的");
  assert.ok(listSurface.includes("props.title === undefined"), "不传 title 时要跳过标题行");
  // 面板外观（圆角面板本体）仍然由 .chk_group 给
  assert.ok(KIT_CSS.includes("." + kit.group + "{"));
});

test("ListFoot 是 kit 的组件；技能页 0.3.0 起用目录筛选取代「空目录」脚注", () => {
  const listSurface = fs.readFileSync(path.join(shellDir, "kit", "ListSurface.tsx"), "utf8");
  assert.ok(listSurface.includes("export function ListFoot"));
  assert.ok(KIT_CSS.includes("." + kit.foot + "{"));
  assert.ok(KIT_CSS.includes("." + kit.footText + "{"));
  assert.ok(KIT_CSS.includes("." + kit.footAction + "{"));
  const skillsList = fs.readFileSync(path.resolve(shellDir, "..", "skills", "list.tsx"), "utf8");
  assert.equal(skillsList.includes("listFootAction"), false, "技能页不该再手写脚注按钮");
  assert.ok(skillsList.includes("DirFilter"), "空目录改由「目录」筛选呈现（D-B15）");
});

test("可折叠分组：标题行是按钮、带 aria-expanded，二级分组无外框", () => {
  const listSurface = fs.readFileSync(path.join(shellDir, "kit", "ListSurface.tsx"), "utf8");
  assert.ok(listSurface.includes('"aria-expanded": expanded'));
  assert.ok(KIT_CSS.includes("." + kit.groupHead + "[data-fold]{cursor:pointer"));
  assert.ok(KIT_CSS.includes("." + kit.group + "[data-depth='1']{border:none"));
  assert.ok(KIT_CSS.includes("." + kit.rowTag + "{"), "目录标签有自己的最弱样式");
});

test("菜单项的 data-testid 挂在包文字的 span 上（宿主 MenuItemButton 不透传未知 props）", () => {
  const menu = fs.readFileSync(path.join(shellDir, "kit", "menu.tsx"), "utf8");
  assert.ok(menu.includes('React.createElement("span", {'), "菜单项文字要包一层 span");
  assert.ok(menu.includes('"data-testid": item.testId ?? item.id'), "testid 挂在 span 上");
  // MenuItemButton 自己不再收到未知属性
  assert.equal(/React\.createElement\(MenuItemButton, \{[^}]*data-testid/s.test(menu), false);
});

test("刷新字形收进 kit，运行态不再自己画一份", () => {
  const icons = fs.readFileSync(path.join(shellDir, "kit", "icons.tsx"), "utf8");
  assert.ok(icons.includes("export function RefreshIcon"));
  const runtime = fs.readFileSync(path.resolve(shellDir, "..", "runtime", "index.tsx"), "utf8");
  assert.ok(runtime.includes("RefreshIcon"));
  assert.equal(runtime.includes("RefreshGlyph"), false, "运行态手写的刷新 SVG 应当删掉");
  assert.equal(/React\.createElement\("svg"/.test(runtime), false, "运行态里不该再有手写 SVG");
});

test("抽屉副标题单行截断（完整内容走 title 提示）", () => {
  const rule = KIT_CSS.split("}").find((part) => part.startsWith("." + kit.drawerSub + "{"));
  assert.ok(rule !== undefined, "要有 .chk_drawerSub 规则");
  assert.ok(rule.includes("white-space:nowrap"));
  assert.ok(rule.includes("text-overflow:ellipsis"));
  assert.ok(rule.includes("overflow:hidden"));
  const drawer = fs.readFileSync(path.join(shellDir, "kit", "Drawer.tsx"), "utf8");
  assert.ok(drawer.includes("props.subtitleTitle ?? props.subtitle"), "title 要用 subtitleTitle 兜底");
});

/** 把两个 sRGB 颜色按 ratio 混在一起（等价于 CSS 的 color-mix(in srgb, a ratio, b)）。 */
function mixHex(a: string, b: string, ratio: number): string {
  const parse = (hex: string): number[] => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const to = (x: number): string => Math.round(x).toString(16).padStart(2, "0");
  return "#" + to(ar * ratio + br * (1 - ratio)) + to(ag * ratio + bg * (1 - ratio)) + to(ab * ratio + bb * (1 - ratio));
}

/** WCAG 2.x 相对亮度。 */
function luminance(hex: string): number {
  const parts = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = parts.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

test("行副标题色：比次级色更弱，亮暗两套仍然 ≥ 4.5:1（WCAG AA 小字）", () => {
  // 取值链（PRIMITIVES.md §P4；面板底 = .chk_group 的 --chk-surface = --dsw-alias-bg-layer-1）：
  //   亮：label-tertiary = bluish-600 #81858c，label-primary = bluish-1000 #0f1115，底 = bluish-00 #ffffff
  //   暗：label-tertiary = bluish-400 #adb2b8，label-primary = bluish-50 #f9fafb，底 = bluish-875 #232324
  // --chk-fg-sub = color-mix(in srgb, var(--dsw-alias-label-tertiary) 85%, var(--dsw-alias-label-primary))
  assert.ok(KIT_CSS.includes("--chk-fg-sub:color-mix(in srgb, var(--dsw-alias-label-tertiary) 85%, var(--dsw-alias-label-primary))"));
  const lightSub = mixHex("#81858c", "#0f1115", 0.85);
  const darkSub = mixHex("#adb2b8", "#f9fafb", 0.85);
  assert.equal(lightSub, "#70747a");
  assert.equal(darkSub, "#b8bdc2");
  assert.ok(contrast(lightSub, "#ffffff") >= 4.5, "亮色 " + lightSub + " on #ffffff = " + contrast(lightSub, "#ffffff").toFixed(2));
  assert.ok(contrast(darkSub, "#232324") >= 4.5, "暗色 " + darkSub + " on #232324 = " + contrast(darkSub, "#232324").toFixed(2));
  // 直接用 tertiary 在亮色下不达标（3.71:1）—— 这就是为什么混了 15% 的主文字色
  assert.ok(contrast("#81858c", "#ffffff") < 4.5);
  // 「更弱一级」确实更弱：副标题对比度低于次级色，暗色同理
  assert.ok(contrast(lightSub, "#ffffff") < contrast("#61666b", "#ffffff"));
  assert.ok(contrast(darkSub, "#232324") < contrast("#cfd3d6", "#232324"));
  const rule = KIT_CSS.split("}").find((part) => part.startsWith("." + kit.rowSub + "{"));
  assert.ok(rule !== undefined && rule.includes("color:var(--chk-fg-sub)"), "行副标题要用 --chk-fg-sub");
});
test("骨架屏是灰条而不是转圈", () => {
  assert.equal(/animation:[^;}]*spin/i.test(KIT_CSS), false);
  assert.ok(KIT_CSS.includes("." + kit.skeletonBar + "{"));
});
