/**
 * 工具栏「⋯」里的远程动作（UI-DESIGN §4）：
 *   检查全部更新 / 全部更新（n）/ 为无来源技能推测来源 / GitHub 凭据与剩余配额（只读信息项）
 *
 * 为什么做成 hook：菜单项是**数据**（Toolbar 的 more 收 MenuItem[]），而它们打开的对话框是**节点**，
 * 两者都要跟着远程 store 的忙碌状态走；hook 在标签页里被无条件调用一次，天然满足 hooks 规则。
 *
 * 「检查全部更新」的结果不再常驻成胶囊，而是走 Toast，并让有更新的行出现「可更新」标记。
 */

import * as React from "react";
import { Button, Checkbox, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge } from "../../../kit/index.ts";
import type { MenuItem } from "../../../kit/index.ts";
import { ensureSources, loadAuth, reloadSources } from "./cache.ts";
import { applyUpdates, checkUpdates, discoverSources, registerSource } from "./data.ts";
import { useRemoteState } from "./use-store.ts";
import { remoteStore } from "./store.ts";
import {
  applySummaryText,
  authModeLabel,
  candidateKey,
  candidateSkillPath,
  checkSummaryText,
  confidenceBadgeTone,
  confidenceLabel,
  groupCandidates,
  skillsNeedingSource,
  sourceIdsOf,
  summarizeApplies,
  summarizeChecks,
  updatableIds,
} from "./model.ts";
import { errorMessage, fieldErrors, type FieldError } from "../format.ts";
import { styles } from "../styles.ts";
import { t } from "../strings.ts";
import type { SkillSummary } from "../../contract/local.ts";
import type { AuthMode, DiscoverCandidate } from "../../contract/remote.ts";

export interface RemoteMenuProps {
  /** 列表里的全部技能（不受搜索/筛选影响） */
  skills: readonly SkillSummary[];
  workspace: string | undefined;
  /** 写操作完成后刷新列表 */
  onChanged?: () => void;
  /** 跳到回收站 */
  onOpenTrash(): void;
  /** 一句结果反馈（走标签页的 Toast） */
  notify(text: string, tone?: "success"): void;
}

export interface RemoteMenu {
  /** 三个动作项（检查全部更新 / 全部更新 / 推测来源）；调用方在后面接「回收站」等自己的项 */
  items: MenuItem[];
  /** 只读信息项：GitHub 凭据模式与剩余配额（**绝不含令牌**，D-B9） */
  authItem: MenuItem;
  dialogs: React.ReactNode;
  /** 当前标着「可更新」的技能 id（行标记与「需关注」筛选都用它） */
  updatable: ReadonlySet<string>;
}

/** ⋯ 菜单里的远程动作。 */
export function useSkillsRemoteMenu(props: RemoteMenuProps): RemoteMenu {
  const { skills, workspace, onChanged, onOpenTrash, notify } = props;
  const state = useRemoteState();
  const [checking, setChecking] = React.useState<boolean>(false);
  const [applying, setApplying] = React.useState<boolean>(false);
  const [discoverOpen, setDiscoverOpen] = React.useState<boolean>(false);
  const [discovering, setDiscovering] = React.useState<boolean>(false);
  const [candidates, setCandidates] = React.useState<DiscoverCandidate[] | undefined>(undefined);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set<string>());
  const [registering, setRegistering] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [errors, setErrors] = React.useState<readonly FieldError[]>([]);

  React.useEffect(() => {
    void ensureSources(workspace);
    void loadAuth();
  }, [workspace]);

  const ids = updatableIds(skills, state.checks);
  const updatable = React.useMemo(() => new Set(ids), [ids.join("|")]);
  const sourceIds = sourceIdsOf(skills, state.sources);
  const needSource = skillsNeedingSource(skills, sourceIds);

  const runCheckAll = (): void => {
    setChecking(true);
    setError(undefined);
    void checkUpdates(undefined, workspace).then(
      (payload) => {
        remoteStore.setChecks(payload.results, {
          mode: payload.auth,
          ...(payload.rateLimitRemaining === undefined ? {} : { rateLimitRemaining: payload.rateLimitRemaining }),
        });
        notify(checkSummaryText(summarizeChecks(payload.results)));
        // 宿主只有在调用过 api.github.com 之后才知道剩余配额；这次没带回就再问一次
        if (payload.rateLimitRemaining === undefined) void loadAuth();
        setChecking(false);
      },
      (failure: unknown) => {
        setError(errorMessage(failure));
        notify(t("skills.toast.failed", { message: errorMessage(failure) }));
        setChecking(false);
      },
    );
  };

  const runUpdateAll = (): void => {
    setApplying(true);
    setError(undefined);
    void applyUpdates(ids, workspace).then(
      (payload) => {
        notify(applySummaryText(summarizeApplies(payload.results)), "success");
        for (const item of payload.results) {
          remoteStore.setCheck(
            item.ok
              ? { skillId: item.skillId, status: "up-to-date" }
              : { skillId: item.skillId, status: "error", ...(item.message === undefined ? {} : { message: item.message }) },
          );
        }
        setApplying(false);
        onChanged?.();
      },
      (failure: unknown) => {
        setError(errorMessage(failure));
        notify(t("skills.toast.failed", { message: errorMessage(failure) }));
        setApplying(false);
      },
    );
  };

  const runDiscover = (): void => {
    setDiscoverOpen(true);
    setDiscovering(true);
    setError(undefined);
    setErrors([]);
    const targetIds = needSource.map((skill) => skill.id);
    void discoverSources(targetIds.length > 0 ? targetIds : undefined, workspace).then(
      (list) => {
        setCandidates(list);
        setSelected(new Set(list.map((item) => candidateKey(item))));
        setDiscovering(false);
      },
      (failure: unknown) => {
        setCandidates([]);
        setErrors(fieldErrors(failure));
        setError(errorMessage(failure));
        setDiscovering(false);
      },
    );
  };

  const registerSelected = (): void => {
    const picked = (candidates ?? []).filter((item) => selected.has(candidateKey(item)));
    if (picked.length === 0) {
      setError(t("skills.remote.source.pickOne"));
      return;
    }
    setRegistering(true);
    setError(undefined);
    void (async () => {
      let ok = 0;
      let failed = 0;
      for (const candidate of picked) {
        try {
          const stored = await registerSource(
            {
              skillId: candidate.skillId,
              repo: candidate.repo,
              ...(candidate.ref === undefined ? {} : { ref: candidate.ref }),
              skillPath: candidateSkillPath(candidate, candidate.skillId.split(":").slice(1).join(":")),
            },
            workspace,
          );
          remoteStore.upsertSource(stored);
          ok += 1;
        } catch {
          failed += 1;
        }
      }
      setRegistering(false);
      notify(t("skills.remote.batch.registerDone", { ok, failed }), "success");
      void reloadSources(workspace);
      onChanged?.();
      if (failed === 0) setDiscoverOpen(false);
    })();
  };

  const auth: AuthMode | undefined = state.auth;
  const items: MenuItem[] = [
    {
      id: "check-all",
      label: checking ? t("skills.remote.menu.checking") : t("skills.remote.menu.checkAll"),
      onClick: runCheckAll,
      disabled: checking || applying,
      testId: "skills-remote-check-all",
    },
    {
      id: "update-all",
      label: applying ? t("skills.remote.menu.applying") : t("skills.remote.menu.updateAll", { count: ids.length }),
      onClick: runUpdateAll,
      disabled: applying || checking || ids.length === 0,
      testId: "skills-remote-update-all",
    },
    {
      id: "discover-all",
      label: t("skills.remote.menu.discover"),
      onClick: runDiscover,
      disabled: discovering,
      testId: "skills-remote-discover-all",
    },
  ];

  const authItem: MenuItem = {
    id: "github",
    label: state.rateLimitRemaining === undefined
      ? t("skills.remote.menu.authUnknown", { mode: authModeLabel(auth) })
      : t("skills.remote.menu.auth", { mode: authModeLabel(auth), remaining: state.rateLimitRemaining }),
    info: true,
    separatorBefore: true,
    testId: "skills-remote-auth",
  };

  const groups = groupCandidates(candidates ?? []);
  const dialogs = discoverOpen
    ? React.createElement(Modal, {
      open: true,
      onClose: () => setDiscoverOpen(false),
      title: t("skills.remote.batch.title"),
      closeLabel: t("skills.close"),
      description: t("skills.remote.batch.hint"),
      contentClassName: styles.modalBody,
      footer: [
        React.createElement(Button, { key: "cancel", variant: "outline", "data-testid": "skills-remote-batch-cancel", onClick: () => setDiscoverOpen(false) }, t("skills.cancel")),
        React.createElement(Button, {
          key: "ok",
          variant: "primary",
          disabled: registering || selected.size === 0,
          "data-testid": "skills-remote-batch-confirm",
          onClick: registerSelected,
        }, t("skills.remote.batch.confirm", { count: selected.size })),
      ],
    },
    React.createElement("div", { className: styles.form, "data-testid": "skills-remote-batch-dialog" },
      discovering
        ? React.createElement("p", { className: styles.loading }, t("skills.remote.source.discovering"))
        : groups.length === 0
          ? React.createElement("p", { className: styles.note, "data-testid": "skills-remote-batch-none" }, t("skills.remote.batch.none"))
          : groups.map((group) => React.createElement("div", { key: group.skillId, className: styles.form, "data-testid": "skills-remote-batch-group-" + group.skillId },
            React.createElement("span", { className: styles.fieldLabel }, group.skillId),
            group.candidates.map((candidate) => React.createElement("div", { key: candidateKey(candidate), className: styles.inlineRow },
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
                React.createElement("span", { className: styles.note }, `${candidate.repo}${candidate.ref === undefined ? "" : "@" + candidate.ref} · ${candidate.skillPath}`),
                React.createElement("span", { className: styles.code }, candidate.reason)))))),
      error === undefined ? null : React.createElement("p", { className: styles.errorBox }, error),
      errors.map((entry) => React.createElement("p", { key: entry.field + entry.message, className: styles.fieldError }, `${entry.field}：${entry.message}`))))
    : null;

  return { items, authItem, dialogs, updatable };
}
