/**
 * 工具栏（UI-DESIGN §3 的 Toolbar）：一行里放齐「搜索 / 筛选分段 / 主按钮 / ⋯」。
 *
 * 布局：start · 搜索 · 分段 · [弹性空白] · end · 主按钮 · ⋯
 * 只有主按钮用强调色，其余全是中性灰。
 */
import * as React from "react";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { kit } from "./styles.ts";
import { MoreMenu, PrimaryMenuButton, type MenuItem } from "./menu.tsx";
import { filterTestId, type FilterItem } from "./pure.ts";

/** 工具栏的 props。 */
export interface ToolbarProps {
  /** 搜索框；不要搜索框就省略。 */
  search?: { value: string; onChange(value: string): void; placeholder?: string; testId?: string };
  /** 筛选分段。 */
  filters?: { items: readonly FilterItem[]; value: string; onChange(id: string): void; label?: string };
  /** 紧跟在筛选分段之后的额外筛选（例如技能页的「目录」下拉）。 */
  afterFilters?: React.ReactNode;
  /** 主按钮：直接执行，或者展开一个菜单。 */
  primary?: { label: string; onClick(): void; testId?: string } | { label: string; menu: readonly MenuItem[]; testId?: string };
  /** 右侧「⋯」。 */
  more?: readonly MenuItem[];
  /** 最左侧（筛选分段之前）的额外内容。 */
  start?: React.ReactNode;
  /** 最右侧（主按钮之前）的额外内容。 */
  end?: React.ReactNode;
  testId?: string;
}

/** 一行工具栏。 */
export function Toolbar(props: ToolbarProps): React.ReactElement {
  const { search, filters, primary, more } = props;
  const primaryHasMenu = primary !== undefined && "menu" in primary;
  return React.createElement("div", { className: kit.toolbar, "data-testid": props.testId },
    props.start === undefined ? null : React.createElement("span", { className: kit.toolbarStart }, props.start),
    search === undefined
      ? null
      : React.createElement("span", { className: kit.search },
        React.createElement(Input, {
          value: search.value,
          placeholder: search.placeholder,
          "aria-label": search.placeholder,
          "data-testid": search.testId,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => search.onChange(event.target.value),
        })),
    filters === undefined
      ? null
      : React.createElement("div", {
        className: kit.segments,
        role: "group",
        "aria-label": filters.label,
      }, filters.items.map((item) => React.createElement("button", {
        key: item.id,
        type: "button",
        className: kit.segment,
        "data-active": filters.value === item.id ? "" : undefined,
        "aria-pressed": filters.value === item.id,
        "data-testid": filterTestId(props.testId, item.id),
        onClick: () => filters.onChange(item.id),
      },
      React.createElement("span", null, item.label),
      item.count === undefined ? null : React.createElement("span", { className: kit.segmentCount }, String(item.count))))),
    props.afterFilters === undefined ? null : React.createElement("span", { className: kit.toolbarAfterFilters }, props.afterFilters),
    React.createElement("span", { className: kit.toolbarSpacer }),
    props.end === undefined ? null : React.createElement("span", { className: kit.toolbarEnd }, props.end),
    primary === undefined
      ? null
      : primaryHasMenu
        ? React.createElement(PrimaryMenuButton, {
          label: primary.label,
          items: (primary as { menu: readonly MenuItem[] }).menu,
          menuLabel: primary.label,
          testId: primary.testId,
        })
        : React.createElement(Button, {
          variant: "primary",
          "data-testid": primary.testId,
          onClick: (primary as { onClick(): void }).onClick,
        }, primary.label),
    more === undefined || more.length === 0
      ? null
      : React.createElement(MoreMenu, { items: more, label: props.testId === undefined ? "更多操作" : props.testId + "-more", testId: props.testId === undefined ? undefined : props.testId + "-more" }));
}
