/**
 * 回收站抽屉（UI-DESIGN §4）：列表行（名称、原因 · 时间）+ 悬停操作「恢复 / 彻底删除」，
 * 底部「清空回收站」（RiskConfirmation，由 index.tsx 的对话框承担）。
 *
 * 列表行用 kit 的 ListRow：未悬停时行上没有任何按钮，只在悬停时淡入两个文字操作。
 */
import * as React from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, Drawer, EmptyState, ListGroup, ListRow, ListSurface, kit } from "../../kit/index.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import { formatDateTime, sortTrash, trashReasonLabel } from "./format.ts";
import type { TrashItem } from "./types.ts";

export interface TrashDrawerProps {
  open: boolean;
  items: readonly TrashItem[];
  loading: boolean;
  error: string | undefined;
  /** 正在处理中的 trashId（按钮置灰） */
  busyIds: ReadonlySet<string>;
  purgingAll: boolean;
  onRestore(item: TrashItem): void;
  onPurgeOne(item: TrashItem): void;
  onPurgeAll(): void;
  onRefresh(): void;
  onClose(): void;
}

/** 回收站。 */
export function TrashDrawer(props: TrashDrawerProps): React.ReactElement {
  const items = sortTrash(props.items);
  return React.createElement(Drawer, {
    open: props.open,
    title: t("skills.trash.title"),
    testId: "skills-trash",
    onClose: props.onClose,
    footer: React.createElement(React.Fragment, null,
      React.createElement(Button, {
        variant: "ghost",
        size: "sm",
        className: kit.dangerButton,
        disabled: items.length === 0 || props.purgingAll,
        "data-testid": "skills-trash-purge-all",
        onClick: props.onPurgeAll,
      }, t("skills.trash.purgeAll")),
      React.createElement("span", { className: kit.drawerFootSpacer }),
      React.createElement("button", {
        type: "button",
        className: kit.iconButton,
        "data-testid": "skills-trash-refresh",
        onClick: props.onRefresh,
        title: t("skills.retry"),
      }, "\u21bb")),
  },
  props.error === undefined ? null : React.createElement("p", { className: styles.errorBox }, props.error),
  props.loading && items.length === 0 ? React.createElement("p", { className: styles.loading }, t("skills.loading")) : null,
  items.length === 0
    ? React.createElement(EmptyState, { testId: "skills-trash-empty", title: t("skills.trash.empty") })
    : React.createElement(ListSurface, { testId: "skills-trash-list" },
      React.createElement(ListGroup, { title: t("skills.trash.subtitle", { count: items.length }), testId: "skills-trash-group" },
      items.map((item) => React.createElement(ListRow, {
        key: item.trashId,
        testId: "skills-trash-row-" + item.trashId,
        title: item.name ?? item.dirName,
        subtitle: t("skills.trash.rowSub", { reason: trashReasonLabel(item.reason), time: formatDateTime(item.deletedAt) }),
        badges: item.hasLockEntry
          ? [React.createElement(Badge, { key: "lock", tone: "neutral", title: t("skills.trash.originalPath", { path: item.originalPath }) }, t("skills.trash.lock"))]
          : [],
        hoverActions: [
          {
            label: t("skills.trash.restore"),
            testId: "skills-trash-restore-" + item.trashId,
            onClick: () => props.onRestore(item),
          },
          {
            label: t("skills.trash.purge"),
            danger: true,
            testId: "skills-trash-purge-" + item.trashId,
            onClick: () => props.onPurgeOne(item),
          },
        ],
      })))));
}
