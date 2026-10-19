/**
 * 「⋯ → GitHub 镜像…」对话框（D-B18）：技能页的工具栏菜单里打开。
 *
 * 自上而下：一句说明（三层意思：只作用于下载 / 检查更新不走镜像 / 镜像可见可改且不带令牌）、
 * 一个输入框（打开时填入当前值）、输入框下方的两行网络状态（D-B19：直连 / 镜像能力，网络问题
 * 只在这里如实写出，不往外弹错误横幅）、自检结果、底部「测试 / 保存 / 取消」。
 *
 * 规则全在 mirror-model.ts（可单测）：菜单标签、自检文案、两行状态文案、Toast 文案、首尾空白。
 * 本文件只渲染；任何异常由 index.tsx 的错误边界兜住，这里不主动 throw。
 */

import * as React from "react";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { useStoreState } from "../../../kit/index.ts";
import { directStatusLine, mirrorCapabilityLine, mirrorTestText } from "./mirror-model.ts";
import type { MirrorStore } from "./mirror-model.ts";
import { styles } from "../styles.ts";
import { t } from "../strings.ts";

export interface MirrorDialogProps {
  store: MirrorStore;
  /** 保存成功（对话框已关）时把 Toast 文案交给标签页 */
  onSaved(text: string): void;
}

/** 技能页的「GitHub 镜像」对话框。 */
export function MirrorDialog(props: MirrorDialogProps): React.ReactElement | null {
  const { store } = props;
  const state = useStoreState(store.state);
  if (!state.open) return null;

  const resultText = state.result === undefined ? undefined : mirrorTestText(state.result);
  const directLine = directStatusLine(state.directStatus);

  return (
    <Modal
      open
      onClose={() => store.close()}
      title={t("skills.remote.mirror.title")}
      closeLabel={t("skills.close")}
      footer={[
        <Button key="cancel" variant="outline" data-testid="skills-mirror-cancel" onClick={() => store.close()}>
          {t("skills.cancel")}
        </Button>,
        <Button
          key="test"
          variant="outline"
          data-testid="skills-mirror-test"
          disabled={state.testing || state.busy}
          onClick={() => void store.test()}
        >
          {state.testing ? t("skills.remote.mirror.testing") : t("skills.remote.mirror.test")}
        </Button>,
        <Button
          key="save"
          variant="primary"
          data-testid="skills-mirror-save"
          disabled={state.busy || state.testing}
          onClick={() => {
            void store.save().then((text) => {
              if (text !== undefined) props.onSaved(text);
            });
          }}
        >
          {state.busy ? t("skills.remote.mirror.saving") : t("skills.remote.mirror.save")}
        </Button>,
      ]}
    >
      <div className={styles.modalBody} data-testid="skills-mirror-dialog">
        <p className={styles.note}>{t("skills.remote.mirror.body")}</p>
        <label className={styles.form}>
          <span className={styles.fieldLabel}>{t("skills.remote.mirror.label")}</span>
          <Input
            value={state.input}
            placeholder={t("skills.remote.mirror.placeholder")}
            aria-label={t("skills.remote.mirror.label")}
            data-testid="skills-mirror-input"
            onChange={(event: { target: { value: string } }) => store.setInput(event.target.value)}
          />
        </label>
        {/* 空输入 = 清除镜像（改回直连）：不额外加说明行，一句就够 */}
        <p className={styles.note}>{t("skills.remote.mirror.emptyHint")}</p>
        {/* D-B19：两行网络状态。直连只在探测过之后出现；镜像恒有一行（未探测 / 未配置就照实写）。 */}
        {directLine === undefined ? null : (
          <p className={styles.note} data-testid="skills-mirror-direct">
            {directLine}
          </p>
        )}
        <p className={styles.note} data-testid="skills-mirror-capability">
          {mirrorCapabilityLine(state.mirrorCapabilities)}
        </p>
        {resultText === undefined ? null : (
          <p className={state.result?.ok === true ? styles.note : styles.errorBox} data-testid="skills-mirror-result">
            {resultText}
          </p>
        )}
        {state.error === undefined ? null : (
          <p className={styles.errorBox} data-testid="skills-mirror-error">
            {state.error}
          </p>
        )}
        {state.errors.map((entry) => (
          <p key={entry.path + entry.message} className={styles.fieldError}>
            {entry.path + "：" + entry.message}
          </p>
        ))}
      </div>
    </Modal>
  );
}
