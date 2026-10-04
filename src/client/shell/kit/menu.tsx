/**
 * 菜单：宿主 primitives 的 Menu + MenuItemButton 的薄封装。
 *
 * 宿主 Menu 的用法（见 docs/PRIMITIVES.md P3 与 src/client/mcp/add-menu.tsx）：
 *   anchor 是就地渲染的触发元素，items 是数据行，children 是 MenuItemButton 组件行。
 *   我们没有数据行，一律用 children。
 */
import * as React from "react";
import { Button, Menu, MenuItemButton } from "@deepseek-ai/dsh-client-ui-primitives";
import { kit } from "./styles.ts";

/** 一条菜单项。 */
export interface MenuItem {
  /** 稳定 id（有 key 与 data-testid 双重用途）。 */
  id?: string;
  label: string;
  /** 次要说明，接在 label 后面。 */
  hint?: string;
  onClick?(): void;
  /** 危险操作用红色文字。 */
  danger?: boolean;
  disabled?: boolean;
  /** 在这一项之前画一条分隔线。 */
  separatorBefore?: boolean;
  /** 只读信息项：渲染成不可点的行。 */
  info?: boolean;
  testId?: string;
}

/**
 * 把 MenuItem[] 渲染成 MenuItemButton 子节点（供 Menu 与 MoreMenu 共用）。
 *
 * data-testid 为什么挂在**文字外面的 span** 上：宿主 MenuItemButton 不透传未知 props
 * （直接给它的 data-testid 会被丢掉），走查脚本就没法稳定点到一个菜单项。包一层 span 之后
 * testid 落在真实 DOM 上，点它等于点菜单项（事件冒泡回 MenuItemButton）。
 */
export function menuChildren(items: readonly MenuItem[], close: () => void): React.ReactElement[] {
  return items.map((item, index) => React.createElement(MenuItemButton, {
    key: item.id ?? String(index),
    disabled: item.disabled === true || item.info === true,
    danger: item.danger === true,
    separatorBefore: item.separatorBefore === true,
    onSelect: () => {
      close();
      item.onClick?.();
    },
  }, React.createElement("span", {
    "data-testid": item.testId ?? item.id,
  }, item.hint === undefined ? item.label : item.label + " \u00b7 " + item.hint)));
}

/** 工具栏右侧的「⋯」按钮 + 菜单。 */
export function MoreMenu(props: {
  items: readonly MenuItem[];
  /** 无障碍名（默认「更多操作」）。 */
  label: string;
  testId?: string;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const close = (): void => setOpen(false);
  return React.createElement("span", { className: kit.more, "data-testid": props.testId },
    React.createElement(Menu, {
      open,
      onClose: close,
      side: "bottom",
      align: "end",
      anchor: React.createElement("button", {
        type: "button",
        className: kit.moreButton,
        "aria-label": props.label,
        title: props.label,
        "data-testid": props.testId === undefined ? undefined : props.testId + "-button",
        onClick: () => setOpen((prev) => !prev),
      }, "\u22ef"),
    },
    menuChildren(props.items, close)));
}

/** 主按钮的分支：label + 下拉菜单。 */
export function PrimaryMenuButton(props: {
  label: string;
  items: readonly MenuItem[];
  menuLabel: string;
  testId?: string;
}): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const close = (): void => setOpen(false);
  return React.createElement("span", { className: kit.more, "data-testid": props.testId },
    React.createElement(Menu, {
      open,
      onClose: close,
      side: "bottom",
      align: "end",
      anchor: React.createElement(Button, {
        variant: "primary",
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "data-testid": props.testId === undefined ? undefined : props.testId + "-button",
        onClick: () => setOpen((prev) => !prev),
      }, props.label + " \u25be"),
    },
    menuChildren(props.items, close)));
}
