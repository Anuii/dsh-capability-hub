/**
 * 技能页的四个确认对话框：删除单个技能、彻底删除一条、清空回收站、恢复冲突时替换。
 *
 * 详情抽屉底部的「删除」与回收站行上的「彻底删除 / 清空回收站」都会打开这里的某一个。
 * 组件的任何异常都会被 index.tsx 的错误边界兜住，且这里不主动 throw。
 */

import * as React from "react";
import { Button, Modal, RiskConfirmation } from "@deepseek-ai/dsh-client-ui-primitives";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import { displayName, fileName, isFlatSkill, type FieldError } from "./format.ts";
import type { SkillSummary, TrashItem } from "../contract/local.ts";

/** 逐字段错误（服务端 VALIDATION 的 details）。 */
function FieldErrorList({ errors }: { errors: readonly FieldError[] }): React.ReactElement | null {
  if (errors.length === 0) return null;
  return React.createElement("div", { className: styles.form },
    errors.map((entry) =>
      React.createElement("p", { key: entry.field + entry.message, className: styles.fieldError }, `${entry.field}：${entry.message}`),
    ));
}

export interface DeleteSkillDialogProps {
  skill: SkillSummary | undefined;
  busy: boolean;
  errors: readonly FieldError[];
  onConfirm: () => void;
  onCancel: () => void;
}

/** 删除确认：说明「整个目录（或那个 .md 文件）移入回收站，可恢复」。 */
export function DeleteSkillDialog(props: DeleteSkillDialogProps): React.ReactElement | null {
  const { skill } = props;
  if (skill === undefined) return null;
  const name = displayName(skill).text;
  return React.createElement(
    Modal,
    {
      open: true,
      onClose: props.onCancel,
      title: t("skills.delete.title"),
      closeLabel: t("skills.close"),
      footer: [
        React.createElement(
          Button,
          { key: "cancel", variant: "outline", "data-testid": "skills-delete-cancel", onClick: props.onCancel },
          t("skills.cancel"),
        ),
        React.createElement(
          Button,
          {
            key: "ok",
            variant: "primary",
            "data-testid": "skills-delete-confirm",
            onClick: props.onConfirm,
            disabled: props.busy,
          },
          t("skills.delete.confirm"),
        ),
      ],
    },
    React.createElement(
      "div",
      { className: styles.modalBody, "data-testid": "skills-delete-dialog" },
      // 平铺 .md 技能是一个文件（不是目录），文案要说实话
      React.createElement(
        "p",
        { className: styles.note, "data-testid": "skills-delete-body" },
        isFlatSkill(skill) ? t("skills.delete.bodyFlat", { name }) : t("skills.delete.body", { name }),
      ),
      skill.rootId === "user-agents" && !isFlatSkill(skill)
        ? React.createElement("p", { className: styles.note }, t("skills.delete.lock"))
        : null,
      React.createElement("p", { className: styles.code, "data-testid": "skills-delete-path" }, skill.path),
      React.createElement(FieldErrorList, { errors: props.errors }),
    ),
  );
}

export interface PurgeOneDialogProps {
  item: TrashItem | undefined;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 回收站单条彻底删除。 */
export function PurgeOneDialog(props: PurgeOneDialogProps): React.ReactElement | null {
  const { item } = props;
  if (item === undefined) return null;
  const name = item.name ?? item.dirName;
  return React.createElement(
    Modal,
    {
      open: true,
      onClose: props.onCancel,
      title: t("skills.trash.purgeOne.title"),
      closeLabel: t("skills.close"),
      footer: [
        React.createElement(
          Button,
          { key: "cancel", variant: "outline", "data-testid": "skills-purge-one-cancel", onClick: props.onCancel },
          t("skills.cancel"),
        ),
        React.createElement(
          Button,
          {
            key: "ok",
            variant: "primary",
            "data-testid": "skills-purge-one-confirm",
            onClick: props.onConfirm,
            disabled: props.busy,
          },
          t("skills.trash.purgeConfirm"),
        ),
      ],
    },
    React.createElement(
      "div",
      { className: styles.modalBody, "data-testid": "skills-purge-one-dialog" },
      React.createElement("p", { className: styles.note }, t("skills.trash.purgeOne.body", { name })),
      React.createElement("p", { className: styles.code }, item.originalPath),
    ),
  );
}

export interface PurgeAllDialogProps {
  open: boolean;
  count: number;
  acknowledged: boolean;
  busy: boolean;
  onAcknowledgedChange: (next: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 清空回收站：危险操作，用宿主的 RiskConfirmation（勾选后才能确认）。 */
export function PurgeAllDialog(props: PurgeAllDialogProps): React.ReactElement | null {
  if (!props.open) return null;
  return React.createElement(RiskConfirmation, {
    open: true,
    title: t("skills.trash.purgeAll.title"),
    description: t("skills.trash.purgeAll.body", { count: props.count }),
    acknowledgeLabel: t("skills.trash.purgeAck"),
    cancelLabel: t("skills.cancel"),
    closeLabel: t("skills.close"),
    confirmLabel: t("skills.trash.purgeConfirm"),
    acknowledged: props.acknowledged,
    disabled: props.busy,
    onAcknowledgedChange: props.onAcknowledgedChange,
    onCancel: props.onCancel,
    onConfirm: props.onConfirm,
  });
}

export interface RestoreConflictDialogProps {
  item: TrashItem | undefined;
  busy: boolean;
  errors: readonly FieldError[];
  onConfirm: () => void;
  onCancel: () => void;
}

/** 恢复冲突：原路径已存在，问用户是否用回收站里的版本覆盖（POST replace:true）。 */
export function RestoreConflictDialog(props: RestoreConflictDialogProps): React.ReactElement | null {
  const { item } = props;
  if (item === undefined) return null;
  const name = item.name ?? item.dirName;
  return React.createElement(
    Modal,
    {
      open: true,
      onClose: props.onCancel,
      title: t("skills.trash.conflict.title"),
      closeLabel: t("skills.close"),
      description: name,
      footer: [
        React.createElement(
          Button,
          { key: "cancel", variant: "outline", "data-testid": "skills-restore-cancel", onClick: props.onCancel },
          t("skills.cancel"),
        ),
        React.createElement(
          Button,
          {
            key: "ok",
            variant: "primary",
            "data-testid": "skills-restore-confirm",
            onClick: props.onConfirm,
            disabled: props.busy,
          },
          t("skills.trash.conflict.confirm"),
        ),
      ],
    },
    React.createElement(
      "div",
      { className: styles.modalBody, "data-testid": "skills-restore-conflict-dialog" },
      React.createElement("p", { className: styles.note }, t("skills.trash.conflict.body", { path: item.originalPath })),
      React.createElement("p", { className: styles.code }, fileName(item.originalPath)),
      React.createElement(FieldErrorList, { errors: props.errors }),
    ),
  );
}
