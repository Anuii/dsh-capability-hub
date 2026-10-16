/**
 * 提示词详情抽屉（UI-DESIGN §6）：上面是完整路径与大小，正文是等宽多行文本框（可编辑），
 * 底部「保存」（有改动才可点）与「还原」（放弃未保存的改动）。
 *
 * 冲突（409）：文件在别处被改过，正文里出现错误与「重新加载」——绝不用旧内容覆盖别人的改动。
 */
import * as React from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { Banner, Drawer, KeyValue, Section, kit } from "../../kit/index.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import { formatBytes } from "./view-model.ts";
import type { PromptDoc } from "./prompts-store.ts";

export interface PromptDetailDrawerProps {
  doc: PromptDoc | undefined;
  busy: boolean;
  saving: boolean;
  onSave(content: string): void;
  onReload(): void;
  onClose(): void;
}

/** 详情抽屉。 */
export function PromptDetailDrawer(props: PromptDetailDrawerProps): React.ReactElement | null {
  const doc = props.doc;
  const [text, setText] = React.useState<string>("");
  // 换了一份文件、或保存 / 重新加载之后（版本变了）：正文跟着宿主给的原文走。
  const stamp = doc === undefined ? "" : doc.file.id + "\u0000" + doc.version;
  React.useEffect(() => {
    setText(doc?.content ?? "");
  }, [stamp]);
  if (doc === undefined) return null;
  const changed = text !== doc.content;
  const file = doc.file;
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
            disabled={!changed || props.saving}
            onClick={() => setText(doc.content)}
          >
            {t("prompts.detail.revert")}
          </Button>
          <span className={kit.drawerFootSpacer} />
          <Button
            variant="primary"
            size="sm"
            data-testid="prompts-save"
            disabled={!changed || props.saving || doc.loading || doc.conflict}
            onClick={() => props.onSave(text)}
          >
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
            <textarea
              className={styles.editor}
              value={text}
              spellCheck={false}
              aria-label={t("prompts.detail.content")}
              data-testid="prompts-editor"
              onChange={(event: { target: { value: string } }) => setText(event.target.value)}
            />
          )}
        </div>
      </Section>
    </Drawer>
  );
}
