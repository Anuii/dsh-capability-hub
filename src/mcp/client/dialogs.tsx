/**
 * 删除服务器的二次确认（D-C5：删除是敏感操作，必须再确认一次）。
 */

import * as React from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { ServerView } from "./types.ts";

export interface DeleteServerDialogProps {
  server: ServerView | undefined;
  busy: boolean;
  onConfirm(server: ServerView): void;
  onCancel(): void;
}

export function DeleteServerDialog(props: DeleteServerDialogProps): React.ReactElement {
  const server = props.server;
  return React.createElement(Modal, {
    open: server !== undefined,
    onClose: props.onCancel,
    title: t("mcp.delete.title"),
    closeLabel: t("mcp.close"),
    description: server === undefined ? "" : t("mcp.delete.body", { name: server.serverName }),
    footer: [
      React.createElement(Button, { key: "cancel", "data-testid": "mcp-delete-cancel", onClick: props.onCancel }, t("mcp.delete.cancel")),
      React.createElement(Button, {
        key: "confirm",
        variant: "primary",
        "data-testid": "mcp-delete-confirm",
        disabled: props.busy,
        onClick: () => {
          if (server !== undefined) props.onConfirm(server);
        },
      }, t("mcp.delete.confirm")),
    ],
  }, React.createElement("div", { className: styles.dialogBody, "data-testid": "mcp-delete-dialog" },
    React.createElement("p", { className: styles.dialogText }, t("mcp.delete.body", { name: server?.serverName ?? "" }))));
}
