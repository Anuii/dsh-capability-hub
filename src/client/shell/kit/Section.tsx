/**
 * 详情里的 Section 与 KeyValue（UI-DESIGN §3）。
 *
 * Section：小号次要色标题 + 可选折叠 + 右侧动作（end）。
 * KeyValue：两列网格，label 次要色、value 次要色偏亮，mono 用等宽。
 */
import * as React from "react";
import { kit } from "./styles.ts";
import { SectionChevron } from "./icons.tsx";

/** 一个可折叠的小节。 */
export function Section(props: {
  title: React.ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  end?: React.ReactNode;
  children?: React.ReactNode;
  testId?: string;
}): React.ReactElement {
  const [open, setOpen] = React.useState<boolean>(props.defaultCollapsed !== true);
  const collapsible = props.collapsible === true;
  const expanded = collapsible ? open : true;
  const title = collapsible
    ? React.createElement("button", {
      type: "button",
      className: kit.sectionTitle,
      "data-collapsible": "",
      "aria-expanded": expanded,
      "data-testid": props.testId === undefined ? undefined : props.testId + "-toggle",
      onClick: () => setOpen((prev) => !prev),
    },
    React.createElement(SectionChevron, { open: expanded, className: kit.sectionChevron }),
    React.createElement("span", null, props.title))
    : React.createElement("span", { className: kit.sectionTitle }, props.title);
  return React.createElement("section", {
    className: kit.section,
    "data-testid": props.testId,
  },
  React.createElement("div", { className: kit.sectionHead },
    title,
    props.end === undefined ? null : React.createElement("span", { className: kit.sectionEnd }, props.end)),
  expanded
    ? React.createElement("div", { className: kit.sectionBody }, props.children)
    : null);
}

/** 一项键值。 */
export interface KeyValueItem {
  label: React.ReactNode;
  value: React.ReactNode;
  /** 等宽（路径 / 命令 / id）。 */
  mono?: boolean;
  /** 悬停提示（值很长时给完整内容）。 */
  title?: string;
  testId?: string;
}

/** 键值网格。 */
export function KeyValue(props: {
  items: readonly KeyValueItem[];
  testId?: string;
}): React.ReactElement {
  return React.createElement("dl", { className: kit.kv, "data-testid": props.testId },
    props.items.flatMap((item, index) => [
      React.createElement("dt", { key: "k" + String(index), className: kit.kvKey }, item.label),
      React.createElement("dd", {
        key: "v" + String(index),
        className: kit.kvValue,
        "data-mono": item.mono === true ? "" : undefined,
        title: item.title,
        "data-testid": item.testId,
      }, item.value),
    ]));
}
