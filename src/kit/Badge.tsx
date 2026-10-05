/**
 * 标记（Badge）与状态点（StatusDot）—— UI-DESIGN §1。
 *
 * 两者都是**只在有事时才出现**的元素：正常数据下画面上几乎没有它们。
 */
import * as React from "react";
import { kit } from "./styles.ts";

/** 标记的语义色调：neutral（灰）/ accent（强调）/ warn（琥珀）/ danger（红）。 */
export type BadgeTone = "neutral" | "accent" | "warn" | "danger";

/** 状态点的语义色调：idle（灰）/ active（强调）/ failed（红）/ cooling（琥珀）。 */
export type StatusTone = "idle" | "active" | "failed" | "cooling";

/** 小号描边胶囊。 */
export function Badge(props: {
  children?: React.ReactNode;
  tone?: BadgeTone;
  /** 悬停提示（例如「被 X 遮蔽」）。 */
  title?: string;
  testId?: string;
}): React.ReactElement {
  return (
    <span className={kit.badge} data-tone={props.tone ?? "neutral"} title={props.title} data-testid={props.testId}>
      {props.children}
    </span>
  );
}

/** 直径 7px 的状态点；无障碍名由调用方通过 title 给出。 */
export function StatusDot(props: { tone: StatusTone; title?: string; testId?: string }): React.ReactElement {
  return (
    <span
      className={kit.dot}
      data-tone={props.tone}
      aria-hidden="true"
      title={props.title}
      data-testid={props.testId}
    />
  );
}
