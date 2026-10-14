/**
 * MCP 服务器列表（UI-DESIGN §5）：一片 Surface + 若干行，行与行之间只有 1px 分隔线。
 *
 * 一行只说两件事：**这是什么**（状态点 + 名称 + 等宽的启动摘要与工具数）与**开没开**（行尾开关）。
 * 其他信息（工具清单、环境变量、失败原因…）全在详情抽屉里。标记只在有事时出现：连接失败 / 未连接（红）。
 *
 * 排序：悬停时行首出现拖动把手，HTML5 拖放（dragstart / dragover / drop 都冒泡到容器上，
 * 所以这里用事件委托，不需要 kit 暴露额外的 props）。**没有上移 / 下移按钮**。
 */

import * as React from "react";
import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, GripIcon, ListGroup, ListRow, ListSurface, StatusDot, kit } from "../../kit/index.ts";
import { rowSubtitleText, rowSubtitleTitle, serverStatusTone, statusTitle } from "./view-model.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { RuntimeServerView } from "../contract/runtime.ts";
import type { ServerView } from "../contract/config.ts";

export interface ServerListProps {
  servers: readonly ServerView[];
  rows: ReadonlyMap<string, RuntimeServerView>;
  busy: ReadonlySet<string>;
  onToggle(view: ServerView, disabled: boolean): void;
  onOpen(view: ServerView): void;
  onReorder(from: number, to: number): void;
}

/** 拖动把手的节点（交给 kit 的行首插槽；只有它是 draggable，行本身不拖）。 */
function dragHandle(name: string): React.ReactElement {
  return (
    <span className={styles.grip} draggable title={t("mcp.row.dragHint")} data-testid={"mcp-grip-" + name}>
      <GripIcon />
    </span>
  );
}

function ServerRow(props: {
  view: ServerView;
  row: RuntimeServerView | undefined;
  busy: boolean;
  onToggle(view: ServerView, disabled: boolean): void;
  onOpen(view: ServerView): void;
}): React.ReactElement {
  const view = props.view;
  const name = view.serverName;
  const row = props.row;
  const tone = serverStatusTone(view, row);
  const badges =
    view.disabled || row === undefined
      ? []
      : row.state === "failed"
        ? [
            <Badge key="failed" tone="danger" testId={"mcp-badge-failed-" + name}>
              {t("mcp.row.badgeFailed")}
            </Badge>,
          ]
        : row.state === "disconnected"
          ? [
              <Badge key="disconnected" tone="danger" testId={"mcp-badge-disconnected-" + name}>
                {t("mcp.row.badgeDisconnected")}
              </Badge>,
            ]
          : [];
  const dotTitle = statusTitle(tone);
  return (
    <ListRow
      testId={"mcp-row-" + name}
      title={name}
      subtitle={rowSubtitleText(view, row)}
      subtitleTitle={rowSubtitleTitle(view)}
      subtitleMono
      leading={
        dotTitle === undefined ? (
          tone
        ) : (
          <span title={dotTitle} data-testid={"mcp-dot-" + name}>
            <StatusDot tone={tone} />
          </span>
        )
      }
      badges={badges}
      dragHandle={dragHandle(name)}
      trailing={
        <Switch
          checked={!view.disabled}
          disabled={props.busy}
          label={t("mcp.row.toggleLabel", { name })}
          onChange={(next: boolean) => props.onToggle(view, !next)}
        />
      }
      onOpen={() => props.onOpen(view)}
    />
  );
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

  return (
    <div
      ref={containerRef}
      onDragStart={(event: React.DragEvent) => {
        const index = indexOfTarget(event.target);
        if (index === undefined) return;
        fromRef.current = index;
        overRef.current = index;
        const row = (event.target as HTMLElement).closest("." + kit.row);
        row?.setAttribute("data-dragging", "");
      }}
      onDragOver={(event: React.DragEvent) => {
        if (fromRef.current === undefined) return;
        event.preventDefault();
        const index = indexOfTarget(event.target);
        if (index !== undefined) overRef.current = index;
      }}
      onDrop={(event: React.DragEvent) => {
        const from = fromRef.current;
        const to = indexOfTarget(event.target) ?? overRef.current;
        event.preventDefault();
        clearDragging();
        if (from !== undefined && to !== undefined && from !== to) props.onReorder(from, to);
      }}
      onDragEnd={clearDragging}
    >
      {/* 只有一组服务器时不显示分组标题：ListGroup 的 title 不传就只留面板外观。 */}
      <ListSurface testId="mcp-list">
        <ListGroup testId="mcp-group">
          {props.servers.map((view) => (
            <ServerRow
              key={view.serverName}
              view={view}
              row={props.rows.get(view.serverName)}
              busy={props.busy.has(view.serverName)}
              onToggle={props.onToggle}
              onOpen={props.onOpen}
            />
          ))}
        </ListGroup>
      </ListSurface>
    </div>
  );
}
