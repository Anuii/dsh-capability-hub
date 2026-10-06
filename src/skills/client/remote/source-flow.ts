/**
 * 详情抽屉「来源」一段的流程（ADR-0005）：推测来源 → 勾选 → 登记；手动登记；取消登记。
 *
 * 一个技能一份（抽屉打开时建）。规则都在这里，组件只渲染：
 *   - 推测：拿到候选后默认全选；登记只用勾选里的第一个（一个技能只有一个来源）；
 *   - 手动：表单预填已有来源；仓库为空不发请求；技能路径默认「<目录名>/SKILL.md」——
 *     仓库根级的 SKILL.md 会被宿主派生成别的 skillId，界面上也说不清是哪个技能；
 *   - 登记 / 取消登记成功后更新共享的来源表、回到查看并给一句结果，然后通知外面刷新列表；
 *   - 请求错误转成中文 error 与逐字段 errors，绝不抛出。
 *
 * 数据访问经 SourceFlowAdapter（data.ts 的 sourceFlowApi；单测是内存 fake）。本文件不 import React。
 */

import { createStore, type Store } from "../../../kit/store.ts";
import { candidateKey, candidateSkillPath, sourceRepoRef } from "./model.ts";
import { fieldErrors } from "../format.ts";
import { t } from "../strings.ts";
import { errorText } from "../../../shared/error-text.ts";
import type { FieldError } from "../../../platform/contract/host.ts";
import type { SkillSummary } from "../../contract/local.ts";
import type { DiscoverCandidate, SourceEntry } from "../../contract/remote.ts";

export interface SourceFlowAdapter {
  discover(skillId: string, workspace: string | undefined): Promise<DiscoverCandidate[]>;
  register(
    input: { skillId: string; repo: string; ref?: string; skillPath?: string },
    workspace: string | undefined,
  ): Promise<SourceEntry>;
  unregister(skillId: string, workspace: string | undefined): Promise<void>;
  /** 共享来源表的更新（详情抽屉、列表、更新检查都读它） */
  sourceSaved(entry: SourceEntry): void;
  sourceRemoved(skillId: string, workspace: string | undefined): void;
}

export type SourceStep = "view" | "discover" | "manual" | "unregister";

export interface ManualSource {
  repo: string;
  ref: string;
  skillPath: string;
}

export interface SourceFlowState {
  step: SourceStep;
  /** 推测得到的候选；推测中为 undefined */
  candidates?: readonly DiscoverCandidate[];
  selected: ReadonlySet<string>;
  busy: boolean;
  error?: string;
  errors: readonly FieldError[];
  /** 上一次成功操作的结果（一句话） */
  done?: string;
  manual: ManualSource;
}

export interface SourceFlow {
  readonly state: Store<SourceFlowState>;
  /** 回到查看（丢掉候选与错误） */
  back(): void;
  discover(): Promise<void>;
  toggleCandidate(candidate: DiscoverCandidate, on: boolean): void;
  registerSelected(): Promise<void>;
  /** 打开手动登记；existing = 当前来源（用来预填） */
  openManual(existing: SourceEntry | undefined): void;
  setManual(field: keyof ManualSource, value: string): void;
  submitManual(): Promise<void>;
  askUnregister(): void;
  unregister(): Promise<void>;
}

export interface SourceFlowOptions {
  skill: Pick<SkillSummary, "id" | "dirName">;
  workspace: string | undefined;
  /** 登记 / 取消登记成功后（外面刷新技能列表） */
  onChanged?(): void;
}

const EMPTY_MANUAL: ManualSource = { repo: "", ref: "", skillPath: "" };

export function createSourceFlow(adapter: SourceFlowAdapter, options: SourceFlowOptions): SourceFlow {
  const { skill, workspace } = options;
  const state = createStore<SourceFlowState>({
    step: "view",
    selected: new Set(),
    busy: false,
    errors: [],
    manual: EMPTY_MANUAL,
  });
  const clean = { error: undefined, errors: [] as readonly FieldError[] };
  const failed = (failure: unknown): void =>
    state.patch({ busy: false, error: errorText(failure), errors: fieldErrors(failure) });

  const register = async (input: { repo: string; ref?: string; skillPath?: string }): Promise<void> => {
    state.patch({ ...clean, done: undefined, busy: true });
    try {
      const stored = await adapter.register({ skillId: skill.id, ...input }, workspace);
      adapter.sourceSaved(stored);
      state.patch({
        busy: false,
        step: "view",
        candidates: undefined,
        done: t("skills.remote.source.registered", { repo: sourceRepoRef(stored) }),
      });
      options.onChanged?.();
    } catch (failure) {
      failed(failure);
    }
  };

  return {
    state,
    back() {
      state.patch({ ...clean, step: "view", candidates: undefined, selected: new Set() });
    },
    async discover() {
      state.patch({ ...clean, step: "discover", done: undefined, busy: true, candidates: undefined });
      try {
        const list = await adapter.discover(skill.id, workspace);
        state.patch({ candidates: list, selected: new Set(list.map(candidateKey)), busy: false });
      } catch (failure) {
        state.patch({ candidates: [] });
        failed(failure);
      }
    },
    toggleCandidate(candidate, on) {
      const selected = new Set(state.get().selected);
      if (on) selected.add(candidateKey(candidate));
      else selected.delete(candidateKey(candidate));
      state.patch({ selected });
    },
    async registerSelected() {
      const { candidates, selected } = state.get();
      const first = (candidates ?? []).find((item) => selected.has(candidateKey(item)));
      if (first === undefined) {
        state.patch({ error: t("skills.remote.source.pickOne") });
        return;
      }
      await register({
        repo: first.repo,
        ...(first.ref === undefined ? {} : { ref: first.ref }),
        skillPath: candidateSkillPath(first, skill.dirName),
      });
    },
    openManual(existing) {
      state.patch({
        ...clean,
        step: "manual",
        manual: {
          repo: existing?.repo ?? "",
          ref: existing?.ref ?? "",
          skillPath: existing?.skillPath ?? skill.dirName + "/SKILL.md",
        },
      });
    },
    setManual(field, value) {
      state.patch({ manual: { ...state.get().manual, [field]: value } });
    },
    async submitManual() {
      const { repo, ref, skillPath } = state.get().manual;
      if (repo.trim() === "") {
        state.patch({ errors: [{ path: "repo", message: t("skills.remote.form.required") }] });
        return;
      }
      await register({ repo, ref, skillPath });
    },
    askUnregister() {
      state.patch({ ...clean, step: "unregister" });
    },
    async unregister() {
      state.patch({ ...clean, done: undefined, busy: true });
      try {
        await adapter.unregister(skill.id, workspace);
        adapter.sourceRemoved(skill.id, workspace);
        state.patch({ busy: false, step: "view", done: t("skills.remote.source.unregisterDone") });
        options.onChanged?.();
      } catch (failure) {
        failed(failure);
      }
    },
  };
}
