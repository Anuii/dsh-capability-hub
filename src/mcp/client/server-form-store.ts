/**
 * 服务器表单的状态与流程（ADR-0005）：草稿、哪些字段该显示错误、检查启动命令、显示遮罩值、保存。
 *
 * 保存的流程：
 *   1. 表单检查 + 与宿主同一份规则（validateDraft）；有错就把所有字段的错误都亮出来，不发请求；
 *   2. stdio 且填了命令：检查命令是否在 PATH 里（只查不执行，D-C4）。找不到就给警告，
 *      用户点「仍然保存」（acknowledgeMissingCommand）才继续；检查本身失败不拦保存；
 *   3. 提交（upsert）。宿主再用同一份规则把关，VALIDATION 的逐字段错误映射回字段。
 *
 * 遮罩（D-C5）：env / headers 的值默认是遮罩占位符；「显示」才拿明文，只写进这次编辑的草稿。
 * 数据访问经 ServerFormAdapter（data.ts 的 serverFormApi；单测是内存 fake）。本文件不 import React。
 */

import { createStore, type Store } from "../../kit/store.ts";
import {
  draftToSubmit,
  fieldErrorsOf,
  fieldOfPath,
  groupErrors,
  validateDraft,
  withField,
  withMetaField,
  withoutField,
  type ServerDraft,
} from "./model.ts";
import { t } from "./strings.ts";
import { errorText } from "../../shared/error-text.ts";
import type { CommandCheckResult, FieldError, ServerView, Transport, UpsertResult } from "../contract/config.ts";

export interface ServerFormAdapter {
  checkCommand(command: string, cwd?: string): Promise<CommandCheckResult>;
  /** 拿明文（env / headers 不遮罩） */
  reveal(name: string): Promise<ServerView>;
  upsert(originalName: string | undefined, server: Record<string, unknown>): Promise<UpsertResult>;
}

export interface CommandCheck {
  command: string;
  found: boolean;
  resolvedPath?: string;
}

export interface ServerFormState {
  draft: ServerDraft;
  /** 用户碰过的字段：只有它们在保存前显示错误 */
  touched: ReadonlySet<string>;
  /** 点过保存：所有字段都显示错误 */
  showAll: boolean;
  saving: boolean;
  checking: boolean;
  commandCheck?: CommandCheck;
  /** 命令在 PATH 里找不到（保存时） */
  commandWarning?: string;
  /** 宿主给的逐字段错误 */
  serverErrors: readonly FieldError[];
  formError?: string;
  revealBusy: boolean;
  revealError?: string;
  revealed: ReadonlySet<string>;
  /** 草稿被整段替换（恢复默认、换传输方式、显示明文）时 +1：列表 / 映射编辑器据此重读 */
  syncToken: number;
}

export interface ServerFormOptions {
  initial: ServerDraft;
  /** 被编辑服务器的原名；新建时省略 */
  originalName?: string;
  /** 现有服务器名（重名校验用；列表可能在表单打开期间刷新，所以是函数） */
  existingNames(): readonly string[];
}

export interface ServerFormStore {
  readonly state: Store<ServerFormState>;
  /** 「字段 id → 错误列表」：表单检查 + 宿主返回的错误 */
  errors(): Record<string, string[]>;
  setField(field: string, value: unknown): void;
  resetField(field: string): void;
  setMeta(key: string, value: unknown): void;
  resetMeta(key: string): void;
  /** 只改传输方式：另一种传输的字段留在草稿里，切回来还在（提交时按当前传输裁剪） */
  setTransport(transport: Transport): void;
  checkCommand(): Promise<void>;
  /** 显示明文；成功返回 true */
  reveal(field: "env" | "headers"): Promise<boolean>;
  /** 保存；成功返回宿主的结果，否则 undefined（原因已在状态里） */
  save(acknowledgeMissingCommand: boolean): Promise<UpsertResult | undefined>;
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

function added(set: ReadonlySet<string>, item: string): ReadonlySet<string> {
  if (set.has(item)) return set;
  const next = new Set(set);
  next.add(item);
  return next;
}

export function createServerFormStore(adapter: ServerFormAdapter, options: ServerFormOptions): ServerFormStore {
  const state = createStore<ServerFormState>({
    draft: options.initial,
    touched: new Set(),
    showAll: false,
    saving: false,
    checking: false,
    serverErrors: [],
    revealBusy: false,
    revealed: new Set(),
    syncToken: 0,
  });
  const localErrors = (): FieldError[] =>
    validateDraft(state.get().draft, {
      existingNames: options.existingNames(),
      ...(options.originalName === undefined ? {} : { originalName: options.originalName }),
    });
  const edit = (draft: ServerDraft, touched: string, resync = false): void => {
    const current = state.get();
    state.patch({
      draft,
      touched: added(current.touched, touched),
      ...(resync ? { syncToken: current.syncToken + 1 } : {}),
    });
  };

  const runCheck = async (): Promise<CommandCheck | undefined> => {
    const draft = state.get().draft;
    const command = textOf(draft.values.command).trim();
    if (command === "") return undefined;
    state.patch({ checking: true });
    try {
      const cwd = textOf(draft.values.cwd);
      const result = await adapter.checkCommand(command, cwd === "" ? undefined : cwd);
      const check: CommandCheck = {
        command,
        found: result.found,
        ...(result.resolvedPath === undefined ? {} : { resolvedPath: result.resolvedPath }),
      };
      state.patch({ commandCheck: check });
      return check;
    } finally {
      state.patch({ checking: false });
    }
  };

  return {
    state,
    errors() {
      const merged = groupErrors(localErrors());
      for (const [field, messages] of Object.entries(groupErrors(state.get().serverErrors))) {
        merged[field] = [...(merged[field] ?? []), ...messages];
      }
      return merged;
    },
    setField(field, value) {
      edit(withField(state.get().draft, field, value), field);
      if (field === "command") state.patch({ commandWarning: undefined });
    },
    resetField(field) {
      edit(withoutField(state.get().draft, field), field, true);
      state.patch({ serverErrors: state.get().serverErrors.filter((error) => fieldOfPath(error.path) !== field) });
    },
    setMeta(key, value) {
      edit(withMetaField(state.get().draft, key, value), "meta." + key);
    },
    resetMeta(key) {
      edit(withMetaField(state.get().draft, key, undefined), "meta." + key, true);
    },
    setTransport(transport) {
      edit({ values: { ...state.get().draft.values, transport } }, "transport", true);
    },
    async checkCommand() {
      try {
        await runCheck();
      } catch (failure) {
        state.patch({ formError: t("mcp.form.saveFailed", { message: errorText(failure) }) });
      }
    },
    async reveal(field) {
      const name = options.originalName;
      if (name === undefined) return false;
      state.patch({ revealBusy: true, revealError: undefined });
      try {
        const view = await adapter.reveal(name);
        const current = state.get();
        state.patch({
          draft: withField(current.draft, field, field === "env" ? view.env : view.headers),
          revealed: added(current.revealed, field),
          syncToken: current.syncToken + 1,
        });
        return true;
      } catch (failure) {
        state.patch({ revealError: t("mcp.editor.revealFailed", { message: errorText(failure) }) });
        return false;
      } finally {
        state.patch({ revealBusy: false });
      }
    },
    async save(acknowledgeMissingCommand) {
      state.patch({ showAll: true, formError: undefined });
      if (localErrors().length > 0) {
        state.patch({ serverErrors: [] });
        return undefined;
      }
      state.patch({ saving: true });
      try {
        const draft = state.get().draft;
        if (draft.values.transport !== "streamable-http") {
          // 检查只是提醒：检查本身失败不拦保存
          const check = await runCheck().catch(() => undefined);
          if (check !== undefined && !check.found) {
            state.patch({ commandWarning: t("mcp.command.missing", { command: check.command }) });
            if (!acknowledgeMissingCommand) return undefined;
          } else {
            state.patch({ commandWarning: undefined });
          }
        }
        const result = await adapter.upsert(options.originalName, draftToSubmit(draft));
        state.patch({ serverErrors: [] });
        return result;
      } catch (failure) {
        state.patch({
          formError: t("mcp.form.saveFailed", { message: errorText(failure) }),
          serverErrors: fieldErrorsOf(failure),
        });
        return undefined;
      } finally {
        state.patch({ saving: false });
      }
    },
  };
}
