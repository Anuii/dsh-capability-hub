/**
 * 「来源与更新」里的**来源**一段（详情抽屉内联，不再是弹窗）。
 *
 * UI-C 之后这一段只回答两件事，别的都删掉了：
 *   有来源 → 三行 KeyValue（来源 / 记录位置 / 更新时间）；检查更新与取消登记在下面那段里；
 *   无来源 → 一句「无来源」+ 两个文字按钮（推测来源 / 手动登记）；
 *   平铺 .md 技能 → 直接说明不支持，不发任何请求。
 *
 * 行里**不再**显示任何来源标记（UI-DESIGN §4：一行只说「这是什么、开没开」）。
 * 推测 / 登记 / 取消登记的流程在 source-flow.ts（可单测），这里只渲染。
 */

import * as React from "react";
import { Button, Checkbox, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, KeyValue, useStoreState } from "../../../kit/index.ts";
import { ensureSources, sourceFlowApi } from "./cache.ts";
import { createSourceFlow } from "./source-flow.ts";

import { remoteStore } from "./store.ts";
import { SkillUpdateSection } from "./update.tsx";
import {
  candidateKey,
  confidenceBadgeTone,
  confidenceLabel,
  findSourceFor,
  flatUnsupportedText,
  isFlatSkill,
  sourceRepoRef,
  sourceTitle,
  storeLabel,
} from "./model.ts";
import { formatDateTime } from "../format.ts";
import { styles } from "../styles.ts";
import { t } from "../strings.ts";
import type { SkillSummary } from "../../contract/local.ts";
import type { DiscoverCandidate } from "../../contract/remote.ts";

export interface SkillSourceSectionProps {
  skill: SkillSummary;
  workspace: string | undefined;
  /** 写操作完成后刷新列表 */
  onChanged?: () => void;
  /** 更新成功后打开回收站（UI 里那一条「旧版本已移入回收站」的后续动作） */
  onOpenTrash?: () => void;
}

/** 来源那一段。 */
export function SkillSourceSection(props: SkillSourceSectionProps): React.ReactElement {
  const { skill, workspace } = props;
  const state = useStoreState(remoteStore.state);
  const onChanged = React.useRef(props.onChanged);
  onChanged.current = props.onChanged;
  // 一个技能一份流程：列表重读后 skill 对象会换，但只要还是这个技能，流程（与「已登记」那句结果）就不重置
  const { id: skillId, dirName } = skill;
  const flow = React.useMemo(
    () =>
      createSourceFlow(sourceFlowApi, {
        skill: { id: skillId, dirName },
        workspace,
        onChanged: () => onChanged.current?.(),
      }),
    [skillId, dirName, workspace],
  );
  const { step, candidates, selected, busy, error, errors, done, manual } = useStoreState(flow.state);

  React.useEffect(() => {
    void ensureSources(workspace);
  }, [workspace]);

  const entry = findSourceFor(skill, state.sources);

  if (isFlatSkill(skill)) {
    return (
      <p className={styles.note} data-testid={"skills-remote-flat-source-" + skill.id}>
        {flatUnsupportedText()}
      </p>
    );
  }

  const body: React.ReactNode[] = [];
  if (state.sourcesError !== undefined) {
    body.push(
      <p key="err" className={styles.errorBox}>
        {t("skills.remote.source.loadFailed", { message: state.sourcesError })}
      </p>,
    );
  } else if (!state.sourcesLoaded) {
    body.push(
      <p key="loading" className={styles.loading}>
        {t("skills.remote.source.loading")}
      </p>,
    );
  } else if (entry === undefined) {
    // 无来源：这里只有这**一句**（UI-C 之前这句解释与下面按钮上的「无来源」各出现一次）。
    body.push(
      <p key="none" className={styles.note} data-testid={"skills-remote-source-none-" + skill.id}>
        {t("skills.remote.update.status.noSource")}
      </p>,
    );
  } else {
    body.push(
      <KeyValue
        key="kv"
        testId={"skills-remote-source-kv-" + skill.id}
        items={[
          {
            label: t("skills.remote.source.origin"),
            value: sourceRepoRef(entry),
            mono: true,
            title: sourceTitle(entry),
            testId: "skills-remote-source-repo-" + skill.id,
          },
          { label: t("skills.remote.source.store"), value: storeLabel(entry.store) },
          {
            label: t("skills.remote.source.updatedAt"),
            value: entry.updatedAt === undefined ? t("skills.detail.none") : formatDateTime(entry.updatedAt),
          },
        ]}
      />,
    );
    if (entry.orphan === true) {
      body.push(
        <p key="orphan" className={styles.note}>
          {t("skills.remote.source.orphan")}
        </p>,
      );
    }
  }

  const actions: React.ReactNode[] = [];
  // 「推测来源 / 手动登记」只在**无来源**时出现；有来源时想换来源先取消登记（下面那段里）。
  if (state.sourcesLoaded && state.sourcesError === undefined && step === "view" && entry === undefined) {
    actions.push(
      <Button
        key="discover"
        size="sm"
        variant="ghost"
        disabled={busy}
        data-testid="skills-remote-source-discover"
        onClick={() => void flow.discover()}
      >
        {t("skills.remote.source.discover")}
      </Button>,
    );
    actions.push(
      <Button
        key="manual"
        size="sm"
        variant="ghost"
        disabled={busy}
        data-testid="skills-remote-source-manual"
        onClick={() => flow.openManual(entry)}
      >
        {t("skills.remote.source.manual")}
      </Button>,
    );
  }

  if (step === "discover") {
    const list = candidates ?? [];
    body.push(
      <div key="discover" className={styles.inlineRow} data-testid="skills-remote-candidates">
        {busy && candidates === undefined ? (
          <p className={styles.loading}>{t("skills.remote.source.discovering")}</p>
        ) : list.length === 0 ? (
          <p className={styles.note} data-testid="skills-remote-no-candidate">
            {t("skills.remote.source.noCandidate")}
          </p>
        ) : (
          <div className={styles.candidate} data-testid="skills-remote-candidate-list">
            {list.map((candidate) => (
              <div
                key={candidateKey(candidate)}
                className={styles.resultRow}
                data-testid={"skills-remote-candidate-" + candidate.skillId}
              >
                <Checkbox
                  checked={selected.has(candidateKey(candidate))}
                  label={candidate.skillId}
                  className={styles.candidateLabel}
                  onChange={(next: boolean) => flow.toggleCandidate(candidate, next)}
                />
                <Badge tone={confidenceBadgeTone(candidate.confidence)}>{confidenceLabel(candidate.confidence)}</Badge>
                <span className={styles.candidateMain}>
                  <span className={styles.note}>{`${sourceRepoRef(candidate)} · ${candidate.skillPath}`}</span>
                  <span className={styles.code}>{candidate.reason}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>,
    );
    actions.length = 0;
    actions.push(
      <Button
        key="cancel"
        size="sm"
        variant="outline"
        disabled={busy}
        data-testid="skills-remote-register-cancel"
        onClick={() => flow.back()}
      >
        {t("skills.cancel")}
      </Button>,
    );
    actions.push(
      <Button
        key="ok"
        size="sm"
        variant="primary"
        disabled={busy || selected.size === 0}
        data-testid="skills-remote-register-confirm"
        onClick={() => void flow.registerSelected()}
      >
        {t("skills.remote.source.register")}
      </Button>,
    );
  }

  if (step === "manual") {
    const field = (label: string, node: React.ReactNode): React.ReactNode => (
      <label className={styles.form} key={label}>
        <span className={styles.fieldLabel}>{label}</span>
        {node}
      </label>
    );
    body.push(
      <div key="manual" className={styles.form} data-testid="skills-remote-manual-form">
        {field(
          t("skills.remote.form.repo"),
          <Input
            value={manual.repo}
            placeholder={t("skills.install.repoPlaceholder")}
            data-testid="skills-remote-manual-repo"
            onChange={(event: { target: { value: string } }) => flow.setManual("repo", event.target.value)}
          />,
        )}
        {field(
          t("skills.remote.form.ref"),
          <Input
            value={manual.ref}
            placeholder={t("skills.install.refPlaceholder")}
            data-testid="skills-remote-manual-ref"
            onChange={(event: { target: { value: string } }) => flow.setManual("ref", event.target.value)}
          />,
        )}
        {field(
          t("skills.remote.form.skillPath"),
          <Input
            value={manual.skillPath}
            data-testid="skills-remote-manual-skillpath"
            onChange={(event: { target: { value: string } }) => flow.setManual("skillPath", event.target.value)}
          />,
        )}
      </div>,
    );
    actions.length = 0;
    actions.push(
      <Button
        key="cancel"
        size="sm"
        variant="outline"
        disabled={busy}
        data-testid="skills-remote-manual-cancel"
        onClick={() => flow.back()}
      >
        {t("skills.cancel")}
      </Button>,
    );
    actions.push(
      <Button
        key="ok"
        size="sm"
        variant="primary"
        disabled={busy}
        data-testid="skills-remote-manual-confirm"
        onClick={() => void flow.submitManual()}
      >
        {t("skills.remote.form.submit")}
      </Button>,
    );
  }

  if (step === "unregister") {
    body.push(
      <p key="unreg" className={styles.note} data-testid="skills-remote-unregister-body">
        {t("skills.remote.source.unregisterBody")}
      </p>,
    );
    actions.length = 0;
    actions.push(
      <Button
        key="cancel"
        size="sm"
        variant="outline"
        disabled={busy}
        data-testid="skills-remote-unregister-cancel"
        onClick={() => flow.back()}
      >
        {t("skills.cancel")}
      </Button>,
    );
    actions.push(
      <Button
        key="ok"
        size="sm"
        variant="primary"
        disabled={busy}
        data-testid="skills-remote-unregister-confirm"
        onClick={() => void flow.unregister()}
      >
        {t("skills.remote.source.unregister")}
      </Button>,
    );
  }

  if (done !== undefined) {
    body.push(
      <p key="done" className={styles.note} data-testid={"skills-remote-source-done-" + skill.id}>
        {done}
      </p>,
    );
  }
  if (error !== undefined) {
    body.push(
      <p key="error" className={styles.errorBox} data-testid="skills-remote-source-error">
        {error}
      </p>,
    );
  }
  for (const entryError of errors) {
    body.push(
      <p
        key={"fe-" + entryError.path + entryError.message}
        className={styles.fieldError}
      >{`${entryError.path}：${entryError.message}`}</p>,
    );
  }

  // 有来源、且停在「查看」这一步时才把「更新」那段接在下面：
  // 调步骤（推测 / 手动 / 取消登记）时它会让位给表单，避免两排按钮打架。
  if (step === "view") {
    body.push(
      <SkillUpdateSection
        key="update"
        skill={skill}
        workspace={workspace}
        hasSource={entry !== undefined && state.sourcesLoaded && state.sourcesError === undefined}
        {...(props.onChanged === undefined ? {} : { onChanged: props.onChanged })}
        {...(props.onOpenTrash === undefined ? {} : { onOpenTrash: props.onOpenTrash })}
        onUnregister={() => flow.askUnregister()}
      />,
    );
  }

  return (
    <div className={styles.form} data-testid={"skills-remote-source-panel-" + skill.id}>
      {body}
      {actions.length === 0 ? null : <div className={styles.slotRow}>{actions}</div>}
    </div>
  );
}
