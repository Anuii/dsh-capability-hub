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
import { ChevronGlyph, GripIcon } from "./icons.tsx";

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
  children?: React.ReactNode;
  testId?: string;
}): React.ReactElement {
  const head = props.title === undefined
    ? null
    : React.createElement("header", { className: kit.groupHead, title: props.meta === undefined ? props.headTitle : undefined },
      React.createElement("span", { className: kit.groupTitle }, props.title),
      props.meta === undefined ? null : React.createElement("span", {
        className: kit.groupMeta,
        title: props.metaTitle ?? props.meta,
      }, props.meta),
      React.createElement("span", { className: kit.groupSpacer }),
      props.badges === undefined ? null : React.createElement("span", { className: kit.groupBadges }, props.badges),
      props.count === undefined ? null : React.createElement("span", { className: kit.groupCount }, String(props.count)));
  return React.createElement("section", { className: kit.group, "data-testid": props.testId },
    head,
    React.createElement("ul", { className: kit.rows },
      props.children,
      React.Children.count(props.children) === 0
        ? React.createElement("li", { className: kit.rowsEmpty }, "\u2014")
        : null));
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
