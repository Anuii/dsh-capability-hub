/**
 * MCP 服务器列表（UI-DESIGN §5）：一片 Surface + 若干行，行与行之间只有 1px 分隔线。
 *
 * 一行只说两件事：**这是什么**（状态点 + 名称 + 等宽的启动摘要）与**开没开**（行尾开关）。
 * 其他信息（工具缓存、最近失败、环境变量…）全在详情抽屉里。
 * 标记只在有事时出现：连接失败（红）、冷却中（琥珀），每行最多 2 个。
 *
 * 排序：悬停时行首出现拖动把手，HTML5 拖放（dragstart / dragover / drop 都冒泡到容器上，
 * 所以这里用事件委托，不需要 kit 暴露额外的 props）。**没有上移 / 下移按钮**。
 */

import * as React from "react";
import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, GripIcon, ListGroup, ListRow, ListSurface, StatusDot, kit } from "../shell/kit/index.ts";
import { activeInstanceCount, cooldownRemainingMs, rowSubtitleText, rowSubtitleTitle, serverStatusTone, statusTitle } from "./model.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { RuntimeServerView, RuntimeStatus, ServerView } from "./types.ts";

export interface ServerListProps {
  servers: readonly ServerView[];
  runtime: RuntimeStatus | undefined;
  busy: ReadonlySet<string>;
  /** 冷却倒计时用的当前时间（由外壳每秒推进一次）。 */
  now: number;
  onToggle(view: ServerView, disabled: boolean): void;
  onOpen(view: ServerView): void;
  onReorder(from: number, to: number): void;
}

function runtimeOf(runtime: RuntimeStatus | undefined, name: string): RuntimeServerView | undefined {
  return runtime?.servers.find((item) => item.name === name);
}

/** 拖动把手的节点（交给 kit 的行首插槽；只有它是 draggable，行本身不拖）。 */
function dragHandle(name: string): React.ReactElement {
  return React.createElement("span", {
    className: styles.grip,
    draggable: true,
    title: t("mcp.row.dragHint"),
    "data-testid": "mcp-grip-" + name,
  }, React.createElement(GripIcon, null));
}

function ServerRow(props: {
  view: ServerView;
  row: RuntimeServerView | undefined;
  instances: number;
  busy: boolean;
  now: number;
  onToggle(view: ServerView, disabled: boolean): void;
  onOpen(view: ServerView): void;
}): React.ReactElement {
  const view = props.view;
  const name = view.serverName;
  const row = props.row;
  const tone = serverStatusTone(row, props.instances, props.now);
  const cooling = cooldownRemainingMs(row?.lastFailure, props.now) > 0;
  const badges = row?.lastFailure === undefined
    ? []
    : [
        cooling
          ? React.createElement(Badge, { key: "cooling", tone: "warn", testId: "mcp-badge-cooling-" + name }, t("mcp.row.badgeCooling"))
          : React.createElement(Badge, { key: "failed", tone: "danger", testId: "mcp-badge-failed-" + name }, t("mcp.row.badgeFailed")),
      ];
  const dotTitle = statusTitle(tone);
  return React.createElement(ListRow, {
    testId: "mcp-row-" + name,
    title: name,
    subtitle: rowSubtitleText(view, row),
    subtitleTitle: rowSubtitleTitle(view),
    subtitleMono: true,
    leading: dotTitle === undefined
      ? tone
      : React.createElement("span", { title: dotTitle, "data-testid": "mcp-dot-" + name }, React.createElement(StatusDot, { tone })),
    badges,
    dragHandle: dragHandle(name),
    trailing: React.createElement(Switch, {
      checked: !view.disabled,
      disabled: props.busy,
      label: t("mcp.row.toggleLabel", { name }),
      onChange: (next: boolean) => props.onToggle(view, !next),
    }),
    onOpen: () => props.onOpen(view),
  });
}

export function ServerList(props: ServerListProps): React.ReactElement {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const fromRef = React.useRef<number | undefined>(undefined);
  const overRef = React.useRef<number | undefined>(undefined);

  /** 事件目标所在的行在列表里的下标。 */
  const indexOfTarget = (target: EventTarget | null): number | undefined => {
    if (!(target instanceof HTMLElement)) return undefined;
    const row = target.closest("." + kit.row);
    if (row === null || row.parentElement === null) return undefined;
    const index = Array.from(row.parentElement.children).indexOf(row);
    return index < 0 ? undefined : index;
  };

  const clearDragging = (): void => {
    fromRef.current = undefined;
    overRef.current = undefined;
    const host = containerRef.current;
    if (host === null) return;
    for (const node of Array.from(host.querySelectorAll("[data-dragging]"))) node.removeAttribute("data-dragging");
  };

  return React.createElement("div", {
    ref: containerRef,
    onDragStart: (event: React.DragEvent) => {
      const index = indexOfTarget(event.target);
      if (index === undefined) return;
      fromRef.current = index;
      overRef.current = index;
      const row = (event.target as HTMLElement).closest("." + kit.row);
      row?.setAttribute("data-dragging", "");
    },
    onDragOver: (event: React.DragEvent) => {
      if (fromRef.current === undefined) return;
      event.preventDefault();
      const index = indexOfTarget(event.target);
      if (index !== undefined) overRef.current = index;
    },
    onDrop: (event: React.DragEvent) => {
      const from = fromRef.current;
      const to = indexOfTarget(event.target) ?? overRef.current;
      event.preventDefault();
      clearDragging();
      if (from !== undefined && to !== undefined && from !== to) props.onReorder(from, to);
    },
    onDragEnd: clearDragging,
  },
  // 只有一组服务器时**不显示分组标题**：UI-C 起 ListGroup 的 title 可选，不传就只留面板外观
  // （圆角 / 边框 / 底色仍由 kit 给）。之前这里手写了一份 .chmcp_panel，已删掉。
  React.createElement(ListSurface, { testId: "mcp-list" },
    React.createElement(ListGroup, { testId: "mcp-group" },
      props.servers.map((view) => React.createElement(ServerRow, {
        key: view.serverName,
        view,
        row: runtimeOf(props.runtime, view.serverName),
        instances: activeInstanceCount(props.runtime, view.serverName),
        busy: props.busy.has(view.serverName),
        now: props.now,
        onToggle: props.onToggle,
        onOpen: props.onOpen,
      })))));
}
