/**
 * 「来源与更新」里的**更新**一段（详情抽屉内联）。
 *
 * UI-C 之后这一段只在**有来源时**才渲染（没有来源时由 source.tsx 给一句「无来源」+ 两个文字按钮），
 * 并且不再重复 GitHub 凭据与配额 —— 那两条已经在工具栏「⋯」菜单里了（D-B9）。
 * 检查更新只在用户点击时发生；检查结果只用一个标记表达，不再有第三处状态文字。
 */

import * as React from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge } from "../../shell/kit/index.ts";
import { applyUpdates, checkUpdates } from "./data.ts";
import { loadAuth } from "./cache.ts";
import { useRemoteState } from "./use-store.ts";
import { remoteStore } from "./store.ts";
import {
  applySummaryText,
  isFlatSkill,
  summarizeApplies,
  updateStatusBadgeTone,
  updateStatusLabel,
  updateStatusTitle,
} from "./model.ts";
import { errorMessage } from "../format.ts";
import { styles } from "../styles.ts";
import { t } from "../strings.ts";
import type { SkillSummary } from "../types.ts";

export interface SkillUpdateSectionProps {
  skill: SkillSummary;
  workspace: string | undefined;
  /** 该技能有没有来源记录：没有就整段不渲染（source.tsx 已经给了「无来源」与两个按钮）。 */
  hasSource: boolean;
  onChanged?: () => void;
  onOpenTrash?: () => void;
  /** 取消登记（有来源时才在按钮行末尾出现）。 */
  onUnregister?: () => void;
}

/** 更新那一段。 */
export function SkillUpdateSection(props: SkillUpdateSectionProps): React.ReactElement | null {
  const { skill, workspace } = props;
  const state = useRemoteState();
  const [checking, setChecking] = React.useState<boolean>(false);
  const [updating, setUpdating] = React.useState<boolean>(false);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [result, setResult] = React.useState<string | undefined>(undefined);

  // 平铺 .md 技能与「无来源」：都由 source.tsx 说明，这里什么都不画。
  if (isFlatSkill(skill) || !props.hasSource) return null;

  const item = state.checks[skill.id];
  const busy = checking || updating;

  const doCheck = (): void => {
    setChecking(true);
    setError(undefined);
    void checkUpdates([skill.id], workspace).then(
      (payload) => {
        remoteStore.setChecks(payload.results, { mode: payload.auth, ...(payload.rateLimitRemaining === undefined ? {} : { rateLimitRemaining: payload.rateLimitRemaining }) });
        if (payload.rateLimitRemaining === undefined) void loadAuth();
        setChecking(false);
      },
      (failure: unknown) => {
        setError(errorMessage(failure));
        setChecking(false);
      },
    );
  };

  const doUpdate = (): void => {
    setUpdating(true);
    setError(undefined);
    setResult(undefined);
    void applyUpdates([skill.id], workspace).then(
      (payload) => {
        const applied = payload.results[0];
        setResult(applySummaryText(summarizeApplies(payload.results)));
        if (applied !== undefined && !applied.ok) setError(applied.message ?? t("skills.detail.none"));
        remoteStore.setCheck(
          applied !== undefined && applied.ok
            ? { skillId: skill.id, status: "up-to-date" }
            : { skillId: skill.id, status: "error", ...(applied?.message === undefined ? {} : { message: applied.message }) },
        );
        setUpdating(false);
        props.onChanged?.();
      },
      (failure: unknown) => {
        setError(errorMessage(failure));
        setUpdating(false);
      },
    );
  };

  const available = item?.status === "update-available";
  const actions: React.ReactNode[] = [
    React.createElement(Button, {
      key: "check",
      size: "sm",
      variant: "ghost",
      disabled: busy,
      "data-testid": "skills-remote-check-" + skill.id,
      onClick: doCheck,
    }, checking ? t("skills.remote.update.checking") : t("skills.remote.update.checkOne")),
  ];
  if (available) {
    actions.push(React.createElement(Button, {
      key: "update",
      size: "sm",
      variant: "primary",
      disabled: busy,
      "data-testid": "skills-remote-update-" + skill.id,
      onClick: doUpdate,
    }, updating ? t("skills.remote.update.updating") : t("skills.remote.update.updateOne")));
  }
  if (props.onUnregister !== undefined) {
    actions.push(React.createElement(Button, {
      key: "unregister",
      size: "sm",
      variant: "ghost",
      disabled: busy,
      "data-testid": "skills-remote-source-unregister",
      onClick: props.onUnregister,
    }, t("skills.remote.source.unregister")));
  }

  return React.createElement("div", { className: styles.form, "data-testid": "skills-remote-update-panel-" + skill.id },
    // 状态只有一个载体：这一个标记（UI-C 之前同一个状态在标记 / 一句说明 / 键值表的「状态」行里出现了三次）。
    React.createElement("div", { className: styles.slotRow },
      React.createElement(Badge, {
        tone: updateStatusBadgeTone(item?.status),
        ...(updateStatusTitle(item) === undefined ? {} : { title: updateStatusTitle(item) }),
        testId: "skills-remote-status-" + skill.id,
      }, updateStatusLabel(item?.status))),
    React.createElement("div", { className: styles.slotRow }, actions),
    error === undefined ? null : React.createElement("p", { className: styles.errorBox, "data-testid": "skills-remote-update-error-" + skill.id }, error),
    result === undefined
      ? null
      : React.createElement("div", { className: styles.form, "data-testid": "skills-remote-update-result-" + skill.id },
        React.createElement("p", { className: styles.note }, result),
        React.createElement("p", { className: styles.note }, t("skills.remote.update.trashNote")),
        props.onOpenTrash === undefined
          ? null
          : React.createElement("div", { className: styles.slotRow },
            React.createElement(Button, { size: "sm", variant: "outline", "data-testid": "skills-remote-open-trash", onClick: props.onOpenTrash }, t("skills.remote.update.openTrash")))));
}
