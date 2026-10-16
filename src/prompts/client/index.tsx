/**
 * 提示词标签页（UI-DESIGN §6）：**工具栏 + 两组列表 + 底部合计**，其余全部按需出现。
 *
 * 职责划分：
 *   - prompts-store.ts：列表 / 回收站 / 文档的读写与页面提示（可单测）；
 *   - view-model.ts：分组、一行怎么显示、底部合计、新建位置可用性（纯函数，可单测）；
 *   - list.tsx / detail.tsx / trash.tsx / dialogs.tsx：视图；
 *   - data.ts：接口封装；strings：全部文案；本目录的样式表：本页样式。
 *
 * 硬约束：组件绝不 throw（错误一律转成界面状态；渲染异常由 TabErrorBoundary 兜底）；
 * 接口错误直接显示服务端返回的中文 message；启停成功后只替换那一行。
 */

import * as React from "react";
import { Button, Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import type { FieldError } from "../../platform/contract/host.ts";
import type { TabProps } from "../../platform/client/tab-props.ts";
import { Banner, Toolbar, useStoreState } from "../../kit/index.ts";
import type { MenuItem } from "../../kit/index.ts";
import { promptsApi } from "./data.ts";
import { createPromptsStore } from "./prompts-store.ts";
import { budgetText, budgetTitle, createOptions, defaultCreateLocation } from "./view-model.ts";
import { PromptDetailDrawer } from "./detail.tsx";
import { PromptList } from "./list.tsx";
import { PromptTrashDrawer } from "./trash.tsx";
import {
  CreatePromptDialog,
  PurgeAllPromptsDialog,
  PurgeOnePromptDialog,
  RestorePromptDialog,
  TogglePromptDialog,
} from "./dialogs.tsx";
import { injectPromptsStyles, styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { PromptCreateLocation, PromptFile, PromptTrashItem } from "../contract/prompts.ts";

/* 样式只注入一次（模块加载时；SSR/无 document 时自动跳过）。 */
injectPromptsStyles();

/** 渲染异常兜底：提示词页崩了也只影响这一块，不拖垮整个面板。 */
class TabErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = {};
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  render(): React.ReactNode {
    if (this.state.error !== undefined) {
      return (
        <div className={styles.root} data-testid="prompts-crash">
          <p className={styles.errorBox}>{t("prompts.crash.title")}</p>
          <p className={styles.note}>{t("prompts.crash.hint", { message: this.state.error })}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function PromptsTabInner(props: TabProps): React.ReactElement {
  const workspace = props.workspace;
  const store = React.useMemo(() => createPromptsStore(promptsApi), []);
  const { list, listError, loading, trash, trashError, trashLoading, trashBusyIds, purgingAll, busyIds, doc, notice } =
    useStoreState(store.state);
  React.useEffect(() => store.setWorkspace(workspace), [store, workspace]);
  React.useEffect(() => void store.reloadTrash(), [store]);

  const [trashOpen, setTrashOpen] = React.useState<boolean>(false);
  const [createOpen, setCreateOpen] = React.useState<boolean>(false);
  const [createLocation, setCreateLocation] = React.useState<PromptCreateLocation | undefined>(undefined);
  const [createError, setCreateError] = React.useState<string | undefined>(undefined);
  const [createFieldErrors, setCreateFieldErrors] = React.useState<readonly FieldError[]>([]);
  const [creating, setCreating] = React.useState<boolean>(false);
  const [pendingToggle, setPendingToggle] = React.useState<{ file: PromptFile; next: boolean } | undefined>(undefined);
  const [toggleError, setToggleError] = React.useState<string | undefined>(undefined);
  const [pendingRestore, setPendingRestore] = React.useState<PromptTrashItem | undefined>(undefined);
  const [restoreError, setRestoreError] = React.useState<string | undefined>(undefined);
  const [pendingPurgeOne, setPendingPurgeOne] = React.useState<PromptTrashItem | undefined>(undefined);
  const [purgeAllOpen, setPurgeAllOpen] = React.useState<boolean>(false);
  const [purgeAck, setPurgeAck] = React.useState<boolean>(false);
  const [saving, setSaving] = React.useState<boolean>(false);

  const options = React.useMemo(() => (list === undefined ? [] : createOptions(list)), [list]);
  const openCreate = (): void => {
    setCreateError(undefined);
    setCreateFieldErrors([]);
    setCreateLocation(defaultCreateLocation(options));
    setCreateOpen(true);
  };
  const reloadTrash = (): void => void store.reloadTrash();
  const openTrash = React.useCallback((): void => setTrashOpen(true), []);

  /** 启停：先问一句（原地改名，git 里会显示改名），确认后再发请求。 */
  const requestToggle = (file: PromptFile, next: boolean): void => {
    setToggleError(undefined);
    setPendingToggle({ file, next });
  };
  const confirmToggle = (): void => {
    const pending = pendingToggle;
    if (pending === undefined) return;
    void store.setEnabled(pending.file, pending.next).then((result) => {
      if (result.ok) {
        setPendingToggle(undefined);
        setToggleError(undefined);
      } else {
        setToggleError(result.message);
      }
    });
  };

  const confirmCreate = (): void => {
    if (createLocation === undefined) return;
    setCreating(true);
    void store.create(createLocation).then((result) => {
      setCreating(false);
      setCreateError(result.ok ? undefined : result.message);
      setCreateFieldErrors(result.fieldErrors);
      if (result.ok) {
        setCreateOpen(false);
        // 新建成功后直接把这一份打开：用户接下来多半要写内容。
        if (result.file !== undefined) void store.open(result.file.id);
      }
    });
  };

  const confirmRestore = (): void => {
    const item = pendingRestore;
    if (item === undefined) return;
    void store.restore(item).then((result) => {
      setRestoreError(result.ok ? undefined : result.message);
      if (result.ok) setPendingRestore(undefined);
    });
  };

  const doPurgeOne = (item: PromptTrashItem): void => {
    void store.purgeOne(item).then((result) => {
      if (result.ok) setPendingPurgeOne(undefined);
    });
  };

  const doPurgeAll = (): void => {
    void store.purgeAll().then((result) => {
      if (result.ok) {
        setPurgeAllOpen(false);
        setPurgeAck(false);
      }
    });
  };

  const save = (content: string): void => {
    setSaving(true);
    void store.save(content).finally(() => setSaving(false));
  };

  const trashCount = trash?.length ?? 0;
  const more: MenuItem[] = [
    {
      id: "trash",
      label: trashCount > 0 ? t("prompts.more.trashCount", { count: trashCount }) : t("prompts.more.trash"),
      testId: "prompts-open-trash",
      onClick: openTrash,
    },
    { id: "refresh", label: t("prompts.refresh"), testId: "prompts-refresh", onClick: () => void store.reloadAll() },
  ];

  return (
    <section className={styles.root} data-testid="capability-hub-tab-panel-prompts" data-dsh-part="prompts-tab">
      <Toolbar
        testId="prompts-toolbar"
        primary={{ label: t("prompts.create"), onClick: openCreate, testId: "prompts-create" }}
        more={more}
      />
      {list === undefined || list.warnings.length === 0 ? null : (
        <Banner tone="warn" testId="prompts-warnings">
          {t("prompts.warnings.title") + "：" + list.warnings.join("；")}
        </Banner>
      )}
      {listError !== undefined && list === undefined ? (
        <div className={styles.root} data-testid="prompts-list-error-block">
          <p className={styles.errorBox}>{t("prompts.loadFailed", { message: listError })}</p>
          <Button size="sm" variant="outline" data-testid="prompts-retry" onClick={() => void store.reload()}>
            {t("prompts.retry")}
          </Button>
        </div>
      ) : (
        <PromptList
          list={list}
          {...(listError === undefined ? {} : { error: listError })}
          loading={loading}
          busyIds={busyIds}
          onToggle={requestToggle}
          onOpen={(file: PromptFile) => void store.open(file.id)}
        />
      )}
      {list === undefined ? null : (
        <p className={styles.note} data-testid="prompts-budget" title={budgetTitle(list)}>
          {budgetText(list)}
        </p>
      )}
      <PromptDetailDrawer
        doc={doc}
        busy={doc === undefined ? false : busyIds.has(doc.file.id)}
        saving={saving}
        onSave={save}
        onReload={() => void store.reloadDoc()}
        onClose={() => store.closeDoc()}
      />
      <CreatePromptDialog
        open={createOpen}
        options={options}
        location={createLocation}
        busy={creating}
        error={createError}
        fieldErrors={createFieldErrors}
        onLocationChange={setCreateLocation}
        onConfirm={confirmCreate}
        onCancel={() => setCreateOpen(false)}
      />
      <TogglePromptDialog
        file={pendingToggle?.file}
        next={pendingToggle?.next}
        inGit={list?.inGit === true}
        busy={pendingToggle !== undefined && busyIds.has(pendingToggle.file.id)}
        error={toggleError}
        onConfirm={confirmToggle}
        onCancel={() => {
          setPendingToggle(undefined);
          setToggleError(undefined);
        }}
      />
      <RestorePromptDialog
        item={pendingRestore}
        busy={pendingRestore !== undefined && trashBusyIds.has(pendingRestore.trashId)}
        error={restoreError}
        onConfirm={confirmRestore}
        onCancel={() => {
          setPendingRestore(undefined);
          setRestoreError(undefined);
        }}
      />
      <PurgeOnePromptDialog
        item={pendingPurgeOne}
        busy={pendingPurgeOne !== undefined && trashBusyIds.has(pendingPurgeOne.trashId)}
        onConfirm={() => {
          if (pendingPurgeOne !== undefined) doPurgeOne(pendingPurgeOne);
        }}
        onCancel={() => setPendingPurgeOne(undefined)}
      />
      <PurgeAllPromptsDialog
        open={purgeAllOpen}
        count={trashCount}
        acknowledged={purgeAck}
        busy={purgingAll}
        onAcknowledgedChange={setPurgeAck}
        onConfirm={doPurgeAll}
        onCancel={() => {
          setPurgeAllOpen(false);
          setPurgeAck(false);
        }}
      />
      <PromptTrashDrawer
        open={trashOpen}
        items={trash ?? []}
        loading={trashLoading}
        error={trashError}
        busyIds={trashBusyIds}
        purgingAll={purgingAll}
        onRestore={(item: PromptTrashItem) => {
          setRestoreError(undefined);
          setPendingRestore(item);
        }}
        onPurgeOne={(item: PromptTrashItem) => setPendingPurgeOne(item)}
        onPurgeAll={() => {
          setPurgeAck(false);
          setPurgeAllOpen(true);
        }}
        onRefresh={reloadTrash}
        onClose={() => setTrashOpen(false)}
      />
      {notice === undefined ? null : (
        <Toast
          key={notice.seq}
          text={notice.text}
          {...(notice.tone === undefined ? {} : { tone: notice.tone })}
          holdMs={5000}
          onDone={() => store.dismiss(notice.seq)}
        />
      )}
    </section>
  );
}

/** 提示词标签页（对外只导出这一个）。 */
export function PromptsTab(props: TabProps): React.ReactElement {
  return (
    <TabErrorBoundary>
      <PromptsTabInner {...props} />
    </TabErrorBoundary>
  );
}
