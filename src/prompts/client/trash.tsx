/**
 * 回收站抽屉（UI-DESIGN §6）：列出旧版本（路径、时间、大小），每项悬停「恢复 / 彻底删除」，
 * 底部「清空」。行用 kit 的 ListRow：未悬停时行上没有任何按钮。
 */
import * as React from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { Drawer, EmptyState, ListGroup, ListRow, ListSurface, kit } from "../../kit/index.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import { formatBytes, formatDateTime } from "./view-model.ts";
import type { PromptTrashItem } from "../contract/prompts.ts";

export interface PromptTrashDrawerProps {
  open: boolean;
  items: readonly PromptTrashItem[];
  loading: boolean;
  error: string | undefined;
  /** 正在处理中的 trashId（按钮置灰） */
  busyIds: ReadonlySet<string>;
  purgingAll: boolean;
  onRestore(item: PromptTrashItem): void;
  onPurgeOne(item: PromptTrashItem): void;
  onPurgeAll(): void;
  onRefresh(): void;
  onClose(): void;
}

/** 回收站里的原因文字。 */
function trashReasonLabel(reason: PromptTrashItem["reason"]): string {
  return reason === "restore" ? t("prompts.trash.reason.restore") : t("prompts.trash.reason.save");
}

/** 回收站。 */
export function PromptTrashDrawer(props: PromptTrashDrawerProps): React.ReactElement {
  const items = props.items;
  return (
    <Drawer
      open={props.open}
      title={t("prompts.trash.title")}
      subtitle={t("prompts.trash.subtitle", { count: items.length })}
      testId="prompts-trash"
      onClose={props.onClose}
      footer={
        <React.Fragment>
          <Button
            variant="ghost"
            size="sm"
            className={kit.dangerButton}
            disabled={items.length === 0 || props.purgingAll}
            data-testid="prompts-trash-purge-all"
            onClick={props.onPurgeAll}
          >
            {t("prompts.trash.purgeAll")}
          </Button>
          <span className={kit.drawerFootSpacer} />
          <button
            type="button"
            className={kit.iconButton}
            data-testid="prompts-trash-refresh"
            onClick={props.onRefresh}
            title={t("prompts.refresh")}
          >
            {"\u21bb"}
          </button>
        </React.Fragment>
      }
    >
      {props.error === undefined ? null : <p className={styles.errorBox}>{props.error}</p>}
      {props.loading && items.length === 0 ? <p className={styles.note}>{t("prompts.loading")}</p> : null}
      {items.length === 0 ? (
        <EmptyState testId="prompts-trash-empty" title={t("prompts.trash.empty")} />
      ) : (
        <ListSurface testId="prompts-trash-list">
          <ListGroup testId="prompts-trash-group">
            {items.map((item) => (
              <ListRow
                key={item.trashId}
                testId={"prompts-trash-row-" + item.trashId}
                title={item.displayPath}
                subtitleMono
                subtitle={t("prompts.trash.rowSub", {
                  reason: trashReasonLabel(item.reason),
                  time: formatDateTime(item.savedAt),
                  size: formatBytes(item.size),
                })}
                hoverActions={[
                  {
                    label: t("prompts.trash.restore"),
                    testId: "prompts-trash-restore-" + item.trashId,
                    onClick: () => props.onRestore(item),
                  },
                  {
                    label: t("prompts.trash.purge"),
                    danger: true,
                    testId: "prompts-trash-purge-" + item.trashId,
                    onClick: () => props.onPurgeOne(item),
                  },
                ]}
              />
            ))}
          </ListGroup>
        </ListSurface>
      )}
    </Drawer>
  );
}
