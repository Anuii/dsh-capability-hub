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
import { errorMessage, fieldErrors, formatDateTime, type FieldError } from "../format.ts";
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
    return React.createElement("p", { className: styles.note, "data-testid": "skills-remote-flat-source-" + skill.id }, flatUnsupportedText());
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
    body.push(React.createElement("p", { key: "err", className: styles.errorBox }, t("skills.remote.source.loadFailed", { message: state.sourcesError })));
  } else if (!state.sourcesLoaded) {
    body.push(React.createElement("p", { key: "loading", className: styles.loading }, t("skills.remote.source.loading")));
  } else if (entry === undefined) {
    // 无来源：这里只有这**一句**（UI-C 之前这句解释与下面按钮上的「无来源」各出现一次）。
    body.push(React.createElement("p", { key: "none", className: styles.note, "data-testid": "skills-remote-source-none-" + skill.id }, t("skills.remote.update.status.noSource")));
  } else {
    body.push(React.createElement(KeyValue, {
      key: "kv",
      testId: "skills-remote-source-kv-" + skill.id,
      items: [
        { label: t("skills.remote.source.origin"), value: sourceRepoRef(entry), mono: true, title: sourceTitle(entry), testId: "skills-remote-source-repo-" + skill.id },
        { label: t("skills.remote.source.store"), value: storeLabel(entry.store) },
        { label: t("skills.remote.source.updatedAt"), value: entry.updatedAt === undefined ? t("skills.detail.none") : formatDateTime(entry.updatedAt) },
      ],
    }));
    if (entry.orphan === true) {
      body.push(React.createElement("p", { key: "orphan", className: styles.note }, t("skills.remote.source.orphan")));
    }
  }

  const actions: React.ReactNode[] = [];
  // 「推测来源 / 手动登记」只在**无来源**时出现；有来源时想换来源先取消登记（下面那段里）。
  if (state.sourcesLoaded && state.sourcesError === undefined && step === "view" && entry === undefined) {
    actions.push(React.createElement(Button, {
      key: "discover",
      size: "sm",
      variant: "ghost",
      disabled: busy,
      "data-testid": "skills-remote-source-discover",
      onClick: runDiscover,
    }, t("skills.remote.source.discover")));
    actions.push(React.createElement(Button, {
      key: "manual",
      size: "sm",
      variant: "ghost",
      disabled: busy,
      "data-testid": "skills-remote-source-manual",
      onClick: openManual,
    }, t("skills.remote.source.manual")));
  }

  if (step === "discover") {
    const list = candidates ?? [];
    body.push(React.createElement("div", { key: "discover", className: styles.inlineRow, "data-testid": "skills-remote-candidates" },
      busy && candidates === undefined
        ? React.createElement("p", { className: styles.loading }, t("skills.remote.source.discovering"))
        : list.length === 0
          ? React.createElement("p", { className: styles.note, "data-testid": "skills-remote-no-candidate" }, t("skills.remote.source.noCandidate"))
          : React.createElement("div", { className: styles.candidate, "data-testid": "skills-remote-candidate-list" },
            list.map((candidate) => React.createElement("div", { key: candidateKey(candidate), className: styles.resultRow, "data-testid": "skills-remote-candidate-" + candidate.skillId },
              React.createElement(Checkbox, {
                checked: selected.has(candidateKey(candidate)),
                label: candidate.skillId,
                className: styles.candidateLabel,
                onChange: (next: boolean) =>
                  setSelected((previous) => {
                    const set = new Set(previous);
                    if (next) set.add(candidateKey(candidate));
                    else set.delete(candidateKey(candidate));
                    return set;
                  }),
              }),
              React.createElement(Badge, { tone: confidenceBadgeTone(candidate.confidence) }, confidenceLabel(candidate.confidence)),
              React.createElement("span", { className: styles.candidateMain },
                React.createElement("span", { className: styles.note }, `${sourceRepoRef(candidate)} · ${candidate.skillPath}`),
                React.createElement("span", { className: styles.code }, candidate.reason)))))));
    actions.length = 0;
    actions.push(React.createElement(Button, { key: "cancel", size: "sm", variant: "outline", disabled: busy, "data-testid": "skills-remote-register-cancel", onClick: back }, t("skills.cancel")));
    actions.push(React.createElement(Button, {
      key: "ok",
      size: "sm",
      variant: "primary",
      disabled: busy || selected.size === 0,
      "data-testid": "skills-remote-register-confirm",
      onClick: doRegisterSelected,
    }, t("skills.remote.source.register")));
  }

  if (step === "manual") {
    const field = (label: string, node: React.ReactNode): React.ReactNode =>
      React.createElement("label", { className: styles.form, key: label },
        React.createElement("span", { className: styles.fieldLabel }, label),
        node);
    body.push(React.createElement("div", { key: "manual", className: styles.form, "data-testid": "skills-remote-manual-form" },
      field(t("skills.remote.form.repo"), React.createElement(Input, {
        value: repo,
        placeholder: t("skills.install.repoPlaceholder"),
        "data-testid": "skills-remote-manual-repo",
        onChange: (event: { target: { value: string } }) => setRepo(event.target.value),
      })),
      field(t("skills.remote.form.ref"), React.createElement(Input, {
        value: ref,
        placeholder: t("skills.install.refPlaceholder"),
        "data-testid": "skills-remote-manual-ref",
        onChange: (event: { target: { value: string } }) => setRef(event.target.value),
      })),
      field(t("skills.remote.form.skillPath"), React.createElement(Input, {
        value: skillPath,
        "data-testid": "skills-remote-manual-skillpath",
        onChange: (event: { target: { value: string } }) => setSkillPath(event.target.value),
      }))));
    actions.length = 0;
    actions.push(React.createElement(Button, { key: "cancel", size: "sm", variant: "outline", disabled: busy, "data-testid": "skills-remote-manual-cancel", onClick: back }, t("skills.cancel")));
    actions.push(React.createElement(Button, {
      key: "ok",
      size: "sm",
      variant: "primary",
      disabled: busy,
      "data-testid": "skills-remote-manual-confirm",
      onClick: () => {
        if (repo.trim() === "") {
          setErrors([{ field: "repo", message: t("skills.remote.form.required") }]);
          return;
        }
        doRegister({ repo, ref, skillPath });
      },
    }, t("skills.remote.form.submit")));
  }

  if (step === "unregister") {
    body.push(React.createElement("p", { key: "unreg", className: styles.note, "data-testid": "skills-remote-unregister-body" }, t("skills.remote.source.unregisterBody")));
    actions.length = 0;
    actions.push(React.createElement(Button, { key: "cancel", size: "sm", variant: "outline", disabled: busy, "data-testid": "skills-remote-unregister-cancel", onClick: back }, t("skills.cancel")));
    actions.push(React.createElement(Button, { key: "ok", size: "sm", variant: "primary", disabled: busy, "data-testid": "skills-remote-unregister-confirm", onClick: doUnregister }, t("skills.remote.source.unregister")));
  }

  if (done !== undefined) {
    body.push(React.createElement("p", { key: "done", className: styles.note, "data-testid": "skills-remote-source-done-" + skill.id }, done));
  }
  if (error !== undefined) {
    body.push(React.createElement("p", { key: "error", className: styles.errorBox, "data-testid": "skills-remote-source-error" }, error));
  }
  for (const entryError of errors) {
    body.push(React.createElement("p", { key: "fe-" + entryError.field + entryError.message, className: styles.fieldError }, `${entryError.field}：${entryError.message}`));
  }

  // 有来源、且停在「查看」这一步时才把「更新」那段接在下面：
  // 调步骤（推测 / 手动 / 取消登记）时它会让位给表单，避免两排按钮打架。
  if (step === "view") {
    body.push(React.createElement(SkillUpdateSection, {
      key: "update",
      skill,
      workspace,
      hasSource: entry !== undefined && state.sourcesLoaded && state.sourcesError === undefined,
      ...(props.onChanged === undefined ? {} : { onChanged: props.onChanged }),
      ...(props.onOpenTrash === undefined ? {} : { onOpenTrash: props.onOpenTrash }),
      onUnregister: () => {
        setStep("unregister");
        setError(undefined);
        setErrors([]);
      },
    }));
  }

  return React.createElement("div", { className: styles.form, "data-testid": "skills-remote-source-panel-" + skill.id },
    ...body,
    actions.length === 0 ? null : React.createElement("div", { className: styles.slotRow }, actions));
}
