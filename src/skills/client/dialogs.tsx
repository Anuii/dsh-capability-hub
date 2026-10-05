/**
 * 技能页的四个确认对话框：删除单个技能、彻底删除一条、清空回收站、恢复冲突时替换。
 *
 * 详情抽屉底部的「删除」与回收站行上的「彻底删除 / 清空回收站」都会打开这里的某一个。
 * 组件的任何异常都会被 index.tsx 的错误边界兜住，且这里不主动 throw。
 */

import * as React from "react";
import type { FieldError } from "../../platform/contract/host.ts";
import { Button, Modal, RiskConfirmation } from "@deepseek-ai/dsh-client-ui-primitives";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import { displayName, fileName, isFlatSkill } from "./format.ts";
import type { SkillSummary, TrashItem } from "../contract/local.ts";

/** 逐字段错误（服务端 VALIDATION 的 details）。 */
function FieldErrorList({ errors }: { errors: readonly FieldError[] }): React.ReactElement | null {
  if (errors.length === 0) return null;
  return (
    <div className={styles.form}>
      {errors.map((entry) => (
        <p key={entry.path + entry.message} className={styles.fieldError}>{`${entry.path}：${entry.message}`}</p>
      ))}
    </div>
  );
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
  return (
    <Modal
      open
      onClose={props.onCancel}
      title={t("skills.delete.title")}
      closeLabel={t("skills.close")}
      footer={[
        <Button key="cancel" variant="outline" data-testid="skills-delete-cancel" onClick={props.onCancel}>
          {t("skills.cancel")}
        </Button>,
        <Button
          key="ok"
          variant="primary"
          data-testid="skills-delete-confirm"
          onClick={props.onConfirm}
          disabled={props.busy}
        >
          {t("skills.delete.confirm")}
        </Button>,
      ]}
    >
      <div className={styles.modalBody} data-testid="skills-delete-dialog">
        {/* 平铺 .md 技能是一个文件（不是目录），文案要说实话 */}
        <p className={styles.note} data-testid="skills-delete-body">
          {isFlatSkill(skill) ? t("skills.delete.bodyFlat", { name }) : t("skills.delete.body", { name })}
        </p>
        {skill.rootId === "user-agents" && !isFlatSkill(skill) ? (
          <p className={styles.note}>{t("skills.delete.lock")}</p>
        ) : null}
        <p className={styles.code} data-testid="skills-delete-path">
          {skill.path}
        </p>
        <FieldErrorList errors={props.errors} />
      </div>
    </Modal>
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
  return (
    <Modal
      open
      onClose={props.onCancel}
      title={t("skills.trash.purgeOne.title")}
      closeLabel={t("skills.close")}
      footer={[
        <Button key="cancel" variant="outline" data-testid="skills-purge-one-cancel" onClick={props.onCancel}>
          {t("skills.cancel")}
        </Button>,
        <Button
          key="ok"
          variant="primary"
          data-testid="skills-purge-one-confirm"
          onClick={props.onConfirm}
          disabled={props.busy}
        >
          {t("skills.trash.purgeConfirm")}
        </Button>,
      ]}
    >
      <div className={styles.modalBody} data-testid="skills-purge-one-dialog">
        <p className={styles.note}>{t("skills.trash.purgeOne.body", { name })}</p>
        <p className={styles.code}>{item.originalPath}</p>
      </div>
    </Modal>
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
  return (
    <RiskConfirmation
      open
      title={t("skills.trash.purgeAll.title")}
      description={t("skills.trash.purgeAll.body", { count: props.count })}
      acknowledgeLabel={t("skills.trash.purgeAck")}
      cancelLabel={t("skills.cancel")}
      closeLabel={t("skills.close")}
      confirmLabel={t("skills.trash.purgeConfirm")}
      acknowledged={props.acknowledged}
      disabled={props.busy}
      onAcknowledgedChange={props.onAcknowledgedChange}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
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
  return (
    <Modal
      open
      onClose={props.onCancel}
      title={t("skills.trash.conflict.title")}
      closeLabel={t("skills.close")}
      description={name}
      footer={[
        <Button key="cancel" variant="outline" data-testid="skills-restore-cancel" onClick={props.onCancel}>
          {t("skills.cancel")}
        </Button>,
        <Button
          key="ok"
          variant="primary"
          data-testid="skills-restore-confirm"
          onClick={props.onConfirm}
          disabled={props.busy}
        >
          {t("skills.trash.conflict.confirm")}
        </Button>,
      ]}
    >
      <div className={styles.modalBody} data-testid="skills-restore-conflict-dialog">
        <p className={styles.note}>{t("skills.trash.conflict.body", { path: item.originalPath })}</p>
        <p className={styles.code}>{fileName(item.originalPath)}</p>
        <FieldErrorList errors={props.errors} />
      </div>
    </Modal>
  );
}
