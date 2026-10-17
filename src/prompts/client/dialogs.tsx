/**
 * 提示词页的四个确认对话框：新建（选位置）、启停确认、回收站恢复确认、彻底删除 / 清空。
 *
 * 启停是**原地改名**：文件所在的层在 git 仓库里时，git 会显示文件被改名，所以 inGit 时确认框里多一句提示。
 * inGit 按**文件所在层**给（全局层恒 false：DSH 主目录不属于任何项目）。
 * 组件的任何异常都会被 index.tsx 的错误边界兜住，且这里不主动 throw。
 */
import * as React from "react";
import { Button, Modal, RiskConfirmation } from "@deepseek-ai/dsh-client-ui-primitives";
import type { FieldError } from "../../platform/contract/host.ts";
import { kit } from "../../kit/index.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { CreateOption } from "./view-model.ts";
import type { PromptCreateLocation, PromptFile, PromptTrashItem } from "../contract/prompts.ts";

/** 逐字段错误（服务端 VALIDATION 的 details）。 */
function FieldErrorList({ errors }: { errors: readonly FieldError[] }): React.ReactElement | null {
  if (errors.length === 0) return null;
  return (
    <div>
      {errors.map((entry) => (
        <p key={entry.path + entry.message} className={styles.fieldError}>
          {entry.path + "：" + entry.message}
        </p>
      ))}
    </div>
  );
}

export interface CreatePromptDialogProps {
  open: boolean;
  options: readonly CreateOption[];
  /** 选中的位置 */
  location: PromptCreateLocation | undefined;
  busy: boolean;
  error: string | undefined;
  fieldErrors: readonly FieldError[];
  onLocationChange(location: PromptCreateLocation): void;
  onConfirm(): void;
  onCancel(): void;
}

/** 新建 AGENTS.md：先选位置（全局 / 项目根 / 当前工作区），不可用的置灰并说明原因。 */
export function CreatePromptDialog(props: CreatePromptDialogProps): React.ReactElement | null {
  if (!props.open) return null;
  const chosen = props.options.find((item) => item.location === props.location);
  const usable = chosen !== undefined && !chosen.disabled;
  return (
    <Modal
      open
      onClose={props.onCancel}
      title={t("prompts.createDialog.title")}
      closeLabel={t("prompts.close")}
      footer={[
        <Button key="cancel" variant="outline" data-testid="prompts-create-cancel" onClick={props.onCancel}>
          {t("prompts.cancel")}
        </Button>,
        <Button
          key="ok"
          variant="primary"
          data-testid="prompts-create-confirm"
          disabled={props.busy || !usable}
          onClick={props.onConfirm}
        >
          {props.busy ? t("prompts.createDialog.creating") : t("prompts.createDialog.confirm")}
        </Button>,
      ]}
    >
      <div className={styles.dialogBody} data-testid="prompts-create-dialog">
        <p className={styles.note}>{t("prompts.createDialog.hint")}</p>
        <div role="radiogroup" aria-label={t("prompts.createDialog.location")}>
          {props.options.map((option) => (
            <label
              key={option.location}
              className={styles.optionRow}
              data-disabled={option.disabled ? "" : undefined}
              data-testid={option.testId}
            >
              <input
                type="radio"
                name="prompts-create-location"
                className={kit.check}
                checked={props.location === option.location}
                disabled={option.disabled || props.busy}
                aria-label={option.label}
                onChange={() => props.onLocationChange(option.location)}
              />
              <span className={styles.optionMain}>
                <span className={styles.optionTitle}>{option.label}</span>
                {option.hint === "" ? null : <span className={styles.optionHint}>{option.hint}</span>}
                {option.reason === undefined ? null : (
                  <span className={styles.optionOff} data-testid={option.testId + "-reason"}>
                    {option.reason}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
        {props.error === undefined ? null : (
          <p className={styles.fieldError} data-testid="prompts-create-error">
            {props.error}
          </p>
        )}
        <FieldErrorList errors={props.fieldErrors} />
      </div>
    </Modal>
  );
}

export interface TogglePromptDialogProps {
  file: PromptFile | undefined;
  /** 目标状态：true = 要启用，false = 要停用 */
  next: boolean | undefined;
  /** 文件所在的层在 git 仓库里：改名会被 git 记下来（全局层恒 false） */
  inGit: boolean;
  busy: boolean;
  error: string | undefined;
  onConfirm(): void;
  onCancel(): void;
}

/** 启停确认：说明「原地改名」，在 git 仓库里多一句提示。 */
export function TogglePromptDialog(props: TogglePromptDialogProps): React.ReactElement | null {
  const { file, next } = props;
  if (file === undefined || next === undefined) return null;
  const enable = next;
  return (
    <Modal
      open
      onClose={props.onCancel}
      title={enable ? t("prompts.toggle.titleOn") : t("prompts.toggle.titleOff")}
      closeLabel={t("prompts.close")}
      footer={[
        <Button key="cancel" variant="outline" data-testid="prompts-toggle-cancel" onClick={props.onCancel}>
          {t("prompts.cancel")}
        </Button>,
        <Button
          key="ok"
          variant="primary"
          data-testid="prompts-toggle-confirm"
          disabled={props.busy}
          onClick={props.onConfirm}
        >
          {enable ? t("prompts.toggle.confirmOn") : t("prompts.toggle.confirmOff")}
        </Button>,
      ]}
    >
      <div className={styles.dialogBody} data-testid="prompts-toggle-dialog">
        <p className={styles.note} data-testid="prompts-toggle-body">
          {enable ? t("prompts.toggle.bodyOn", { name: file.name }) : t("prompts.toggle.bodyOff", { name: file.name })}
        </p>
        {props.inGit ? (
          <p className={styles.note} data-testid="prompts-toggle-git">
            {t("prompts.toggle.git")}
          </p>
        ) : null}
        <p className={styles.optionHint}>{file.path}</p>
        {props.error === undefined ? null : (
          <p className={styles.fieldError} data-testid="prompts-toggle-error">
            {props.error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export interface RestorePromptDialogProps {
  item: PromptTrashItem | undefined;
  busy: boolean;
  error: string | undefined;
  onConfirm(): void;
  onCancel(): void;
}

/** 恢复确认：写回这一版，文件里现在的内容也会进回收站。 */
export function RestorePromptDialog(props: RestorePromptDialogProps): React.ReactElement | null {
  const { item } = props;
  if (item === undefined) return null;
  return (
    <Modal
      open
      onClose={props.onCancel}
      title={t("prompts.trash.restoreTitle")}
      closeLabel={t("prompts.close")}
      footer={[
        <Button key="cancel" variant="outline" data-testid="prompts-restore-cancel" onClick={props.onCancel}>
          {t("prompts.cancel")}
        </Button>,
        <Button
          key="ok"
          variant="primary"
          data-testid="prompts-restore-confirm"
          disabled={props.busy}
          onClick={props.onConfirm}
        >
          {t("prompts.trash.restoreConfirm")}
        </Button>,
      ]}
    >
      <div className={styles.dialogBody} data-testid="prompts-restore-dialog">
        <p className={styles.note}>{t("prompts.trash.restoreBody", { path: item.displayPath })}</p>
        <p className={styles.optionHint}>{item.displayPath}</p>
        {props.error === undefined ? null : <p className={styles.fieldError}>{props.error}</p>}
      </div>
    </Modal>
  );
}

export interface PurgeOnePromptDialogProps {
  item: PromptTrashItem | undefined;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** 回收站单条彻底删除。 */
export function PurgeOnePromptDialog(props: PurgeOnePromptDialogProps): React.ReactElement | null {
  const { item } = props;
  if (item === undefined) return null;
  return (
    <Modal
      open
      onClose={props.onCancel}
      title={t("prompts.trash.purgeOneTitle")}
      closeLabel={t("prompts.close")}
      footer={[
        <Button key="cancel" variant="outline" data-testid="prompts-purge-one-cancel" onClick={props.onCancel}>
          {t("prompts.cancel")}
        </Button>,
        <Button
          key="ok"
          variant="primary"
          data-testid="prompts-purge-one-confirm"
          disabled={props.busy}
          onClick={props.onConfirm}
        >
          {t("prompts.trash.purgeConfirm")}
        </Button>,
      ]}
    >
      <div className={styles.dialogBody} data-testid="prompts-purge-one-dialog">
        <p className={styles.note}>{t("prompts.trash.purgeOneBody", { path: item.displayPath })}</p>
      </div>
    </Modal>
  );
}

export interface PurgeAllPromptsDialogProps {
  open: boolean;
  count: number;
  acknowledged: boolean;
  busy: boolean;
  onAcknowledgedChange(next: boolean): void;
  onConfirm(): void;
  onCancel(): void;
}

/** 清空回收站：危险操作，用宿主的 RiskConfirmation（勾选后才能确认）。 */
export function PurgeAllPromptsDialog(props: PurgeAllPromptsDialogProps): React.ReactElement | null {
  if (!props.open) return null;
  return (
    <RiskConfirmation
      open
      title={t("prompts.trash.purgeAllTitle")}
      description={t("prompts.trash.purgeAllBody", { count: props.count })}
      acknowledgeLabel={t("prompts.trash.purgeAck")}
      cancelLabel={t("prompts.cancel")}
      closeLabel={t("prompts.close")}
      confirmLabel={t("prompts.trash.purgeConfirm")}
      acknowledged={props.acknowledged}
      disabled={props.busy}
      onAcknowledgedChange={props.onAcknowledgedChange}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  );
}
