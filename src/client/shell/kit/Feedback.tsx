/**
 * 反馈类组件：横幅 / 空状态 / 骨架屏 —— UI-DESIGN §1、§2。
 *
 * 骨架屏用灰条而不是转圈；空状态是一句标题 + 一句说明 + 一个按钮。
 */
import * as React from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { kit } from "./styles.ts";
import { SKELETON_ROWS } from "./pure.ts";

/** 横幅的语义色调。 */
export type BannerTone = "neutral" | "warn" | "danger" | "accent";

/**
 * 一条横幅。**只在需要时出现**：一切正常时画面上没有它。
 * 左侧色条表达 tone，正文是次要色，右侧最多一个动作。
 */
export function Banner(props: {
  children?: React.ReactNode;
  tone?: BannerTone;
  action?: { label: string; onClick(): void; testId?: string };
  testId?: string;
}): React.ReactElement {
  return React.createElement("div", {
    className: kit.banner,
    "data-tone": props.tone ?? "neutral",
    role: "status",
    "data-testid": props.testId,
  },
  React.createElement("span", { className: kit.bannerBody }, props.children),
  props.action === undefined ? null : React.createElement("button", {
    type: "button",
    className: kit.bannerAction,
    "data-testid": props.action.testId,
    onClick: props.action.onClick,
  }, props.action.label));
}

/** 居中空状态：一句标题 + 一句说明 + 一个按钮。 */
export function EmptyState(props: {
  title: string;
  description?: string;
  action?: { label: string; onClick(): void; testId?: string };
  testId?: string;
}): React.ReactElement {
  return React.createElement("div", { className: kit.empty, "data-testid": props.testId },
    React.createElement("p", { className: kit.emptyTitle }, props.title),
    props.description === undefined ? null : React.createElement("p", { className: kit.emptyText }, props.description),
    props.action === undefined ? null : React.createElement(Button, {
      variant: "outline",
      size: "sm",
      "data-testid": props.action.testId,
      onClick: props.action.onClick,
    }, props.action.label));
}

/** 加载占位：默认 6 行灰条，不用转圈。 */
export function SkeletonRows(props: {
  rows?: number;
  testId?: string;
}): React.ReactElement {
  const rows = props.rows ?? SKELETON_ROWS;
  const items: React.ReactElement[] = [];
  for (let index = 0; index < rows; index += 1) {
    items.push(React.createElement("div", { className: kit.skeletonRow, key: index },
      React.createElement("span", { className: kit.skeletonBar, "data-w": "title" }),
      React.createElement("span", { className: kit.skeletonStack },
        React.createElement("span", { className: kit.skeletonBar, "data-w": "sub" }))));
  }
  return React.createElement("div", {
    className: kit.skeleton,
    "aria-busy": "true",
    "data-testid": props.testId,
  }, items);
}
