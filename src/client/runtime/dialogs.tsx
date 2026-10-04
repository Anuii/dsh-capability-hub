/**
 * 断开实例的二次确认（D-E1：断开是破坏性操作，必须再确认一次）。
 *
 * 两种目标共用这一个对话框：
 *   - 服务器行：该服务器在**全部会话**里的实例（不带 sessionId）；
 *   - 实例行：某个会话里的那一个实例（带 sessionId）。
 */

import * as React from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";

export interface DisconnectTarget {
  name: string;
  /** 省略 = 该服务器的全部会话。 */
  sessionId?: string;
}

export interface DisconnectDialogProps {
  target: DisconnectTarget | undefined;
  busy: boolean;
  onConfirm(target: DisconnectTarget): void;
  onCancel(): void;
}

export function DisconnectDialog(props: DisconnectDialogProps): React.ReactElement {
  const target = props.target;
  const targetText = target === undefined
    ? ""
    : target.sessionId === undefined
      ? t("runtime.dialog.targetServer", { name: target.name })
      : t("runtime.dialog.targetInstance", { sessionId: short(target.sessionId), name: target.name });
  return React.createElement(Modal, {
    open: target !== undefined,
    onClose: props.onCancel,
    title: t("runtime.dialog.title"),
    closeLabel: t("runtime.close"),
    footer: [
      React.createElement(Button, { key: "cancel", "data-testid": "runtime-disconnect-cancel", onClick: props.onCancel }, t("runtime.dialog.cancel")),
      React.createElement(Button, {
        key: "confirm",
        variant: "primary",
        "data-testid": "runtime-disconnect-confirm",
        disabled: props.busy,
        onClick: () => {
          if (target !== undefined) props.onConfirm(target);
        },
      }, t("runtime.dialog.confirm")),
    ],
  }, React.createElement("div", { className: styles.dialogBody, "data-testid": "runtime-disconnect-dialog" },
    React.createElement("p", { className: styles.dialogText }, t("runtime.dialog.body", { target: targetText })),
    React.createElement("p", { className: styles.small }, targetText)));
}

function short(sessionId: string): string {
  return sessionId.length <= 16 ? sessionId : sessionId.slice(0, 8) + "…" + sessionId.slice(-4);
}
