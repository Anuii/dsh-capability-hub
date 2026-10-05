/**
 * 「来源与更新」里的**来源**一段（详情抽屉内联，不再是弹窗）。
 *
 * UI-C 之后这一段只回答两件事，别的都删掉了：
 *   有来源 → 三行 KeyValue（来源 / 记录位置 / 更新时间）；检查更新与取消登记在下面那段里；
 *   无来源 → 一句「无来源」+ 两个文字按钮（推测来源 / 手动登记）；
 *   平铺 .md 技能 → 直接说明不支持，不发任何请求。
 *
 * 行里**不再**显示任何来源标记（UI-DESIGN §4：一行只说「这是什么、开没开」）。
 */

import * as React from "react";
import type { FieldError } from "../../../platform/contract/host.ts";
import { Button, Checkbox, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, KeyValue } from "../../../kit/index.ts";
import { ensureSources, reloadSources } from "./cache.ts";
import { discoverSources, registerSource, unregisterSource } from "./data.ts";
import { useRemoteState } from "./use-store.ts";
import { remoteStore } from "./store.ts";
import { SkillUpdateSection } from "./update.tsx";
import {
  candidateKey,
  candidateSkillPath,
  confidenceBadgeTone,
  confidenceLabel,
  findSourceFor,
  flatUnsupportedText,
  isFlatSkill,
  sourceRepoRef,
  sourceTitle,
  storeLabel,
} from "./model.ts";
import { errorMessage, fieldErrors, formatDateTime } from "../format.ts";
import { styles } from "../styles.ts";
import { t } from "../strings.ts";
import type { SkillSummary } from "../../contract/local.ts";
import type { DiscoverCandidate } from "../../contract/remote.ts";

type Step = "view" | "discover" | "manual" | "unregister";

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
  const state = useRemoteState();
  const [step, setStep] = React.useState<Step>("view");
  const [candidates, setCandidates] = React.useState<DiscoverCandidate[] | undefined>(undefined);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set<string>());
  const [busy, setBusy] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [errors, setErrors] = React.useState<readonly FieldError[]>([]);
  const [done, setDone] = React.useState<string | undefined>(undefined);
  const [repo, setRepo] = React.useState<string>("");
  const [ref, setRef] = React.useState<string>("");
  const [skillPath, setSkillPath] = React.useState<string>("");

  React.useEffect(() => {
    void ensureSources(workspace);
  }, [workspace]);

  const flat = isFlatSkill(skill);
  const entry = findSourceFor(skill, state.sources);

  if (flat) {
    return (
      <p className={styles.note} data-testid={"skills-remote-flat-source-" + skill.id}>
        {flatUnsupportedText()}
      </p>
    );
  }

  const back = (): void => {
    setStep("view");
    setCandidates(undefined);
    setSelected(new Set<string>());
    setError(undefined);
    setErrors([]);
  };

  const runDiscover = (): void => {
    setStep("discover");
    setDone(undefined);
    setBusy(true);
    setError(undefined);
    setErrors([]);
    void discoverSources([skill.id], workspace).then(
      (list) => {
        setCandidates(list);
        setSelected(new Set(list.map((item) => candidateKey(item))));
        setBusy(false);
      },
      (failure: unknown) => {
        setCandidates([]);
        setErrors(fieldErrors(failure));
        setError(errorMessage(failure));
        setBusy(false);
      },
    );
  };

  const doRegister = (input: { repo: string; ref?: string; skillPath?: string }): void => {
    setDone(undefined);
    setBusy(true);
    setError(undefined);
    setErrors([]);
    void registerSource({ skillId: skill.id, ...input }, workspace).then(
      (stored) => {
        remoteStore.upsertSource(stored);
        setBusy(false);
        setStep("view");
        setCandidates(undefined);
        setDone(t("skills.remote.source.registered", { repo: sourceRepoRef(stored) }));
        props.onChanged?.();
      },
      (failure: unknown) => {
        setErrors(fieldErrors(failure));
        setError(errorMessage(failure));
        setBusy(false);
      },
    );
  };

  const doRegisterSelected = (): void => {
    const picked = (candidates ?? []).filter((item) => selected.has(candidateKey(item)));
    const first = picked[0];
    if (first === undefined) {
      setError(t("skills.remote.source.pickOne"));
      return;
    }
    doRegister({
      repo: first.repo,
      ...(first.ref === undefined ? {} : { ref: first.ref }),
      skillPath: candidateSkillPath(first, skill.dirName),
    });
  };

  const doUnregister = (): void => {
    setDone(undefined);
    setBusy(true);
    setError(undefined);
    setErrors([]);
    void unregisterSource(skill.id, workspace).then(
      () => {
        remoteStore.removeSource(skill.id);
        setBusy(false);
        setStep("view");
        setDone(t("skills.remote.source.unregisterDone"));
        props.onChanged?.();
        void reloadSources(workspace);
      },
      (failure: unknown) => {
        setErrors(fieldErrors(failure));
        setError(errorMessage(failure));
        setBusy(false);
      },
    );
  };

  const openManual = (): void => {
    setStep("manual");
    setError(undefined);
    setErrors([]);
    setRepo(entry?.repo ?? "");
    setRef(entry?.ref ?? "");
    // 默认给「<目录名>/SKILL.md」：仓库根级的 SKILL.md 会被宿主派生成错误的 skillId，
    // 界面上也说不清是哪个技能，所以默认写成带目录的形式（用户可改）。
    setSkillPath(entry?.skillPath ?? `${skill.dirName}/SKILL.md`);
  };

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
        onClick={runDiscover}
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
        onClick={openManual}
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
                  onChange={(next: boolean) =>
                    setSelected((previous) => {
                      const set = new Set(previous);
                      if (next) set.add(candidateKey(candidate));
                      else set.delete(candidateKey(candidate));
                      return set;
                    })
                  }
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
        onClick={back}
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
        onClick={doRegisterSelected}
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
            value={repo}
            placeholder={t("skills.install.repoPlaceholder")}
            data-testid="skills-remote-manual-repo"
            onChange={(event: { target: { value: string } }) => setRepo(event.target.value)}
          />,
        )}
        {field(
          t("skills.remote.form.ref"),
          <Input
            value={ref}
            placeholder={t("skills.install.refPlaceholder")}
            data-testid="skills-remote-manual-ref"
            onChange={(event: { target: { value: string } }) => setRef(event.target.value)}
          />,
        )}
        {field(
          t("skills.remote.form.skillPath"),
          <Input
            value={skillPath}
            data-testid="skills-remote-manual-skillpath"
            onChange={(event: { target: { value: string } }) => setSkillPath(event.target.value)}
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
        onClick={back}
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
        onClick={() => {
          if (repo.trim() === "") {
            setErrors([{ path: "repo", message: t("skills.remote.form.required") }]);
            return;
          }
          doRegister({ repo, ref, skillPath });
        }}
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
        onClick={back}
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
        onClick={doUnregister}
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
        onUnregister={() => {
          setStep("unregister");
          setError(undefined);
          setErrors([]);
        }}
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
