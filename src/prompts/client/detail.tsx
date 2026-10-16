/**
 * 提示词详情抽屉（UI-DESIGN §6）：上面是完整路径与大小，正文是等宽多行文本框（可编辑），
 * 底部「保存」（有改动才可点）与「还原」（放弃未保存的改动）。
 *
 * 这个组件**只有渲染**：草稿与「能不能保存 / 还原」都在 prompts-store.ts 里（ADR-0005，
 * 规则写进可单测的状态仓库）。组件里没有 useState，也没有「原文到达时同步」的 effect ——
 * 那种写法在「先 patch loading 文档、再 patch 原文」时会漏掉（两次的 version 相同），
 * 文本框会停在空串上，而「保存」却是亮的，一点就把文件写成空。
 *
 * 冲突（409）：文件在别处被改过，正文里出现错误与「重新加载」——绝不用旧内容覆盖别人的改动。
 */
import * as React from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { Banner, Drawer, KeyValue, Section, kit } from "../../kit/index.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import { formatBytes } from "./view-model.ts";
import { docCanRevert, docCanSave, type PromptDoc } from "./prompts-store.ts";

export interface PromptDetailDrawerProps {
  doc: PromptDoc | undefined;
  saving: boolean;
  onDraft(text: string): void;
  onRevert(): void;
  onSave(): void;
  onReload(): void;
  onClose(): void;
}

/** 详情抽屉。 */
export function PromptDetailDrawer(props: PromptDetailDrawerProps): React.ReactElement | null {
  const doc = props.doc;
  if (doc === undefined) return null;
  const file = doc.file;
  const canSave = docCanSave(doc, props.saving);
  const canRevert = docCanRevert(doc, props.saving);
  return (
    <Drawer
      open
      title={file.name}
      subtitle={file.displayPath || file.path}
      subtitleTitle={file.path}
      testId="prompts-drawer"
      onClose={props.onClose}
      footer={
        <React.Fragment>
          <Button
            variant="ghost"
            size="sm"
            data-testid="prompts-revert"
            title={t("prompts.detail.revertTitle")}
            disabled={!canRevert}
            onClick={props.onRevert}
          >
            {t("prompts.detail.revert")}
          </Button>
          <span className={kit.drawerFootSpacer} />
          <Button variant="primary" size="sm" data-testid="prompts-save" disabled={!canSave} onClick={props.onSave}>
            {props.saving ? t("prompts.detail.saving") : t("prompts.detail.save")}
          </Button>
        </React.Fragment>
      }
    >
      <Section title={t("prompts.detail.overview")}>
        <KeyValue
          testId="prompts-detail-kv"
          items={[
            {
              label: t("prompts.detail.path"),
              value: file.path,
              mono: true,
              title: file.path,
              testId: "prompts-detail-path",
            },
            { label: t("prompts.detail.size"), value: formatBytes(file.size), testId: "prompts-detail-size" },
            {
              label: t("prompts.detail.state"),
              value: file.disabled ? t("prompts.detail.stateOff") : t("prompts.detail.stateOn"),
              testId: "prompts-detail-state",
            },
          ]}
        />
      </Section>
      {doc.conflict ? (
        <Banner
          tone="danger"
          testId="prompts-conflict"
          action={{ label: t("prompts.detail.reload"), onClick: props.onReload, testId: "prompts-reload" }}
        >
          {t("prompts.detail.conflict")}
        </Banner>
      ) : null}
      {doc.error === undefined || doc.conflict ? null : (
        <Banner tone="danger" testId="prompts-detail-error">
          {t("prompts.detail.openFailed", { message: doc.error })}
        </Banner>
      )}
      <Section title={t("prompts.detail.content")}>
        <div className={styles.editorWrap}>
          {doc.loading ? (
            <p className={styles.note} data-testid="prompts-editor-loading">
              {t("prompts.loading")}
            </p>
          ) : (
            // 原文没读到（读取失败）时只读：这时保存已经不可点，文本框也不该像是能编辑的。
            <textarea
              className={styles.editor}
              value={doc.draft}
              readOnly={!doc.loaded}
              spellCheck={false}
              aria-label={t("prompts.detail.content")}
              data-testid="prompts-editor"
              onChange={(event: { target: { value: string } }) => props.onDraft(event.target.value)}
            />
          )}
        </div>
      </Section>
    </Drawer>
  );
}
