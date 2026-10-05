/**
 * 列表：ListSurface / ListGroup / ListRow —— UI-DESIGN §1。
 *
 * 视觉规则（这一层是「安静」的主要载体）：
 *   - 一个圆角面板装若干行，**不给每行套卡片**；行与行之间只有 1px 最弱分隔线；
 *   - 行高 52px（两行字）／44px（只有标题）；
 *   - 悬停时背景提亮一级 + 行尾出现淡色「›」+ 悬停操作淡入；
 *   - 未悬停时行上可见的交互控件不超过 1 个（就是 trailing 里的开关）。
 */
import * as React from "react";
import { kit } from "./styles.ts";
import { clampBadges, passthroughAttrs, rowKeyDecision } from "./pure.ts";
import { StatusDot, type StatusTone } from "./Badge.tsx";
import { ChevronGlyph, GripIcon, SectionChevron } from "./icons.tsx";

/** 列表容器：一个圆角面板，纵向排若干 ListGroup。 */
export function ListSurface(props: {
  children?: React.ReactNode;
  testId?: string;
}): React.ReactElement {
  return React.createElement("div", { className: kit.surface, "data-testid": props.testId }, props.children);
}

/**
 * 分组：标题行（次要色小字 + 等宽 meta + 右侧计数 / 标记）+ 行容器。
 *
 * `title` 可选：**不传时整条标题行都不渲染**，但面板外观（圆角 / 边框 / 底色）照旧——
 * MCP 页只有一组服务器，标题行纯属噪音（UI-DESIGN §1「一处一事」）。
 */
export function ListGroup(props: {
  title?: React.ReactNode;
  /** 等宽路径等次要信息。 */
  meta?: string;
  /** meta 的悬停提示（完整路径）；省略时用 meta 本身。 */
  metaTitle?: string;
  /** 没有 meta 时，把说明挂到整条标题行上（例如「DSH 内置」根的真实路径）。 */
  headTitle?: string;
  count?: number | string;
  badges?: React.ReactNode;
  /** 标题行最右侧的控件（例如刷新按钮）；点击不会触发折叠。 */
  end?: React.ReactNode;
  /**
   * 可折叠：给了 onToggle，标题行就是一个按钮（Tab 聚焦、Enter/Space 切换、aria-expanded），
   * 折叠时不渲染内容。展开状态由调用方持有（expanded，缺省视为展开）。
   */
  expanded?: boolean;
  onToggle?(): void;
  /** children 是若干子分组（嵌套的 ListGroup），而不是行。 */
  nested?: boolean;
  /** 嵌套层级：1 = 二级分组（无外框、标题行缩进、底色更浅）。 */
  depth?: 0 | 1;
  children?: React.ReactNode;
  testId?: string;
}): React.ReactElement {
  const foldable = props.onToggle !== undefined;
  const expanded = props.expanded !== false;
  const stop = (event: React.SyntheticEvent): void => event.stopPropagation();
  const headParts = [
    foldable ? React.createElement(SectionChevron, { key: "chevron", open: expanded, className: kit.sectionChevron }) : null,
    React.createElement("span", { key: "title", className: kit.groupTitle }, props.title),
    props.meta === undefined ? null : React.createElement("span", {
      key: "meta",
      className: kit.groupMeta,
      title: props.metaTitle ?? props.meta,
    }, props.meta),
    React.createElement("span", { key: "spacer", className: kit.groupSpacer }),
    props.badges === undefined ? null : React.createElement("span", { key: "badges", className: kit.groupBadges }, props.badges),
    props.count === undefined ? null : React.createElement("span", { key: "count", className: kit.groupCount }, String(props.count)),
  ];
  const headTitle = props.meta === undefined ? props.headTitle : undefined;
  const head = props.title === undefined
    ? null
    : foldable
      ? React.createElement("div", { className: kit.groupHeadWrap },
        React.createElement("button", {
          type: "button",
          className: kit.groupHead,
          "data-fold": "",
          "aria-expanded": expanded,
          title: headTitle,
          "data-testid": props.testId === undefined ? undefined : props.testId + "-toggle",
          onClick: () => props.onToggle?.(),
        }, headParts),
        props.end === undefined ? null : React.createElement("span", { className: kit.groupEnd, onClick: stop, onKeyDown: stop }, props.end))
      : React.createElement("header", { className: kit.groupHead, title: headTitle },
        headParts,
        props.end === undefined ? null : React.createElement("span", { className: kit.groupEnd }, props.end));
  const body = !expanded
    ? null
    : props.nested === true
      ? React.createElement("div", { className: kit.nested }, props.children)
      : React.createElement("ul", { className: kit.rows },
        props.children,
        React.Children.count(props.children) === 0
          ? React.createElement("li", { className: kit.rowsEmpty }, "\u2014")
          : null);
  return React.createElement("section", {
    className: kit.group,
    "data-testid": props.testId,
    "data-depth": props.depth === 1 ? "1" : undefined,
    "data-collapsed": expanded ? undefined : "",
  }, head, body);
}

/**
 * 列表脚注：一行次要色小字 + 一个可选的文字按钮。
 * 技能页用它显示「另有 N 个空的技能目录 · 显示 / 隐藏」（UI-DESIGN §4）。
 */
export function ListFoot(props: {
  text: React.ReactNode;
  action?: { label: string; onClick(): void; testId?: string; expanded?: boolean };
  testId?: string;
  textTestId?: string;
}): React.ReactElement {
  return React.createElement("div", { className: kit.foot, "data-testid": props.testId },
    React.createElement("span", { className: kit.footText, "data-testid": props.textTestId }, props.text),
    props.action === undefined
      ? null
      : React.createElement("button", {
        type: "button",
        className: kit.footAction,
        "data-testid": props.action.testId,
        "aria-expanded": props.action.expanded === true,
        onClick: props.action.onClick,
      }, props.action.label));
}

/** 行尾的悬停操作。 */
export interface RowAction {
  label: string;
  onClick(): void;
  danger?: boolean;
  testId?: string;
}

/** 一行。 */
export interface ListRowProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** 副标题用等宽字体（路径 / 命令）。 */
  subtitleMono?: boolean;
  /** 副标题的语义色（默认次要色；失败用红、冷却用琥珀）。 */
  subtitleTone?: "default" | "danger" | "warn";
  /** 行首：StatusTone 时渲染状态点，ReactNode 时原样渲染。 */
  leading?: StatusTone | React.ReactNode;
  badges?: React.ReactNode[];
  /**
   * 标题后的一枚淡色小标签（技能所在的技能目录，如 .agents）：比状态标记更弱——
   * 不是描边胶囊、不计入「每行最多 2 个标记」、不带颜色；title 放完整路径。
   */
  tag?: { text: string; title?: string; testId?: string };
  trailing?: React.ReactNode;
  hoverActions?: RowAction[];
  /** 传入任意节点即渲染成拖动把手（MCP 页用）。 */
  dragHandle?: boolean | React.ReactNode;
  onOpen?(): void;
  selected?: boolean;
  testId?: string;
  /**
   * 透传到行元素的额外属性。**只放行 data-* 与 aria-***（见 pure.ts 的 passthroughAttrs）：
   * 走查脚本用 data-* 定位、无障碍用 aria-*，别的键（onClick / className / style）
   * 会绕开 kit 的约定，一律忽略。
   */
  attrs?: Readonly<Record<string, string>>;
}

function isStatusTone(value: unknown): value is StatusTone {
  return value === "idle" || value === "active" || value === "failed" || value === "cooling";
}

/** 一行：整行可点开详情，行尾的控件不会触发 onOpen。 */
export function ListRow(props: ListRowProps): React.ReactElement {
  const openable = props.onOpen !== undefined;
  const stop = (event: React.SyntheticEvent): void => event.stopPropagation();
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (!openable) return;
    if (rowKeyDecision(event.key).kind !== "open") return;
    event.preventDefault();
    props.onOpen?.();
  };
  const badges = clampBadges(props.badges);
  return React.createElement("li", {
    className: kit.row,
    "data-testid": props.testId,
    "data-openable": openable ? "" : undefined,
    "data-selected": props.selected === true ? "" : undefined,
    role: openable ? "button" : undefined,
    tabIndex: openable ? 0 : undefined,
    onClick: openable ? () => props.onOpen?.() : undefined,
    onKeyDown,
    ...passthroughAttrs(props.attrs),
  },
  props.dragHandle === undefined || props.dragHandle === false
    ? null
    : React.createElement("span", {
      className: kit.dragHandle,
      onClick: stop,
      "data-testid": props.testId === undefined ? undefined : props.testId + "-drag",
    }, React.isValidElement(props.dragHandle) ? props.dragHandle : React.createElement(GripIcon, null)),
  props.leading === undefined
    ? null
    : React.createElement("span", { className: kit.rowLeading },
      isStatusTone(props.leading) ? React.createElement(StatusDot, { tone: props.leading }) : props.leading),
  React.createElement("span", { className: kit.rowMain },
    React.createElement("span", { className: kit.rowTitleLine },
      React.createElement("span", { className: kit.rowTitle, title: typeof props.title === "string" ? props.title : undefined }, props.title),
      props.tag === undefined
        ? null
        : React.createElement("span", { className: kit.rowTag, title: props.tag.title, "data-testid": props.tag.testId }, props.tag.text),
      badges.length === 0
        ? null
        : React.createElement("span", { className: kit.rowBadges }, badges)),
    props.subtitle === undefined
      ? null
      : React.createElement("span", {
        className: kit.rowSub,
        "data-mono": props.subtitleMono === true ? "" : undefined,
        "data-tone": props.subtitleTone ?? "default",
        title: typeof props.subtitle === "string" ? props.subtitle : undefined,
      }, props.subtitle)),
  React.createElement("span", { className: kit.rowEnd, onClick: stop, onKeyDown: stop },
    props.hoverActions === undefined || props.hoverActions.length === 0
      ? null
      : React.createElement("span", { className: kit.rowActions },
        props.hoverActions.map((action, index) => React.createElement("button", {
          key: action.testId ?? String(index),
          type: "button",
          className: kit.rowAction,
          "data-danger": action.danger === true ? "" : undefined,
          "data-testid": action.testId,
          title: action.label,
          onClick: (event: React.MouseEvent) => {
            event.stopPropagation();
            action.onClick();
          },
        }, action.label))),
    props.trailing),
  openable ? React.createElement(ChevronGlyph, { className: kit.rowChevron }) : null);
}
