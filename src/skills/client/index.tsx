/**
 * 技能标签页（UI-DESIGN §4）：**工具栏 + 列表 + 三个抽屉**，没有二级导航、没有常驻统计行、
 * 没有常驻说明文字。列表与回收站的数据和写操作在 skills-store.ts（规则与单测都在那里），
 * 本文件只管对话框、抽屉与 Toast；视图层（list.tsx / detail.tsx / trash.tsx / remote/*）只做展示。
 *
 * 硬约束：
 *   - 组件绝不 throw：请求错误一律转成界面状态；渲染异常由 TabErrorBoundary 兜底；
 *   - 接口错误直接显示服务端返回的中文 message；VALIDATION 的 details 落到对话框字段上；
 *   - 启停成功后只替换那一行（验收 U2）；
 *   - 「检查更新」这类结果走 Toast，不再常驻成胶囊；有更新的行上出现「可更新」标记。
 */

import * as React from "react";
import type { FieldError } from "../../platform/contract/host.ts";
import { Button, Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import type { TabProps } from "../../platform/client/tab-props.ts";
import { Banner, Toolbar, useStoreState } from "../../kit/index.ts";
import type { MenuItem } from "../../kit/index.ts";
import { AddSkillDrawer } from "./remote/install-view.tsx";
import { useSkillsRemoteMenu } from "./remote/batch.tsx";
import { skillsApi } from "./data.ts";
import { createSkillsStore } from "./skills-store.ts";
import { homeDirFromRoots, filterCounts, filterLabel, FILTERS, type FilterId, type MatchContext } from "./format.ts";
import { injectSkillsStyles, styles } from "./styles.ts";
import { t } from "./strings.ts";
import { DeleteSkillDialog, PurgeAllDialog, PurgeOneDialog, RestoreConflictDialog } from "./dialogs.tsx";
import { SkillDetailDrawer } from "./detail.tsx";
import { DirFilter, SkillList } from "./list.tsx";
import { TrashDrawer } from "./trash.tsx";
import type { ListResult, SkillSummary, TrashItem } from "../contract/local.ts";

/* 样式只注入一次（模块加载时；SSR/无 document 时自动跳过）。 */
injectSkillsStyles();

interface ToastState {
  seq: number;
  text: string;
  action?: { label: string; onClick: () => void };
}

const EMPTY: ListResult = { roots: [], skills: [], warnings: [] };

/** 渲染异常兜底：技能页崩了也只影响这一块，不拖垮整个面板。 */
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
        <div className={styles.root} data-testid="skills-crash">
          <p className={styles.errorBox}>{t("skills.crash.title")}</p>
          <p className={styles.note}>{t("skills.crash.hint", { message: this.state.error })}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function SkillsTabInner(props: TabProps): React.ReactElement {
  const workspace = props.workspace;
  const store = React.useMemo(() => createSkillsStore(skillsApi), []);
  const { list, listError, loading, trash, trashError, trashLoading, busyIds, trashBusyIds, purgingAll } =
    useStoreState(store.state);
  React.useEffect(() => store.setWorkspace(workspace), [store, workspace]);
  React.useEffect(() => void store.reloadTrash(), [store]);
  const [trashOpen, setTrashOpen] = React.useState<boolean>(false);
  const [addOpen, setAddOpen] = React.useState<boolean>(false);
  const [query, setQuery] = React.useState<string>("");
  const [filter, setFilter] = React.useState<FilterId>("all");
  /** 目录筛选（rootId）；"" = 全部目录（D-B15）。 */
  const [dir, setDir] = React.useState<string>("");
  const [detailId, setDetailId] = React.useState<string | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = React.useState<SkillSummary | undefined>(undefined);
  const [deleteErrors, setDeleteErrors] = React.useState<readonly FieldError[]>([]);
  const [pendingPurgeOne, setPendingPurgeOne] = React.useState<TrashItem | undefined>(undefined);
  const [purgeAllOpen, setPurgeAllOpen] = React.useState<boolean>(false);
  const [purgeAck, setPurgeAck] = React.useState<boolean>(false);
  const [pendingConflict, setPendingConflict] = React.useState<TrashItem | undefined>(undefined);
  const [conflictErrors, setConflictErrors] = React.useState<readonly FieldError[]>([]);
  const [toast, setToast] = React.useState<ToastState | undefined>(undefined);
  const toastSeq = React.useRef<number>(0);

  const showToast = React.useCallback(
    (text: string, extra?: { action?: { label: string; onClick: () => void } }): void => {
      toastSeq.current += 1;
      setToast({ seq: toastSeq.current, text, ...(extra ?? {}) });
    },
    [],
  );

  const reload = (): void => void store.reload();
  const reloadTrash = (): void => void store.reloadTrash();
  /** 来源/更新这类写操作之后：技能列表与回收站计数都要跟上（更新会把旧版本送进回收站）。 */
  const reloadAll = React.useCallback((): void => void store.reloadAll(), [store]);

  const skills = list?.skills ?? [];
  const openTrash = React.useCallback((): void => setTrashOpen(true), []);
  const remote = useSkillsRemoteMenu({
    skills,
    workspace,
    onChanged: reloadAll,
    onOpenTrash: openTrash,
    notify: (text: string) => showToast(text),
  });
  const context: MatchContext = { updatable: remote.updatable };

  /** 启停：成功后只替换这一行（规则在 skills-store.ts）。 */
  const onToggle = (skill: SkillSummary, next: boolean): void => {
    void store.toggle(skill, next).then((result) => showToast(result.message));
  };

  const confirmDelete = (): void => {
    const skill = pendingDelete;
    if (skill === undefined) return;
    void store.remove(skill).then((result) => {
      if (result.ok) {
        setPendingDelete(undefined);
        setDeleteErrors([]);
        setDetailId(undefined);
        showToast(result.message, { action: { label: t("skills.delete.openTrash"), onClick: openTrash } });
      } else {
        setDeleteErrors(result.fieldErrors);
        showToast(result.message);
      }
    });
  };

  /** 恢复；默认不带 replace，冲突时再问用户是否覆盖。 */
  const doRestore = (item: TrashItem, replace: boolean): void => {
    void store.restore(item, replace).then((result) => {
      setConflictErrors(result.fieldErrors);
      if (result.ok) {
        setPendingConflict(undefined);
        showToast(result.message);
      } else if (result.conflict === true) {
        setPendingConflict(item);
      } else {
        showToast(result.message);
      }
    });
  };

  const doPurgeOne = (item: TrashItem): void => {
    void store.purgeOne(item).then((result) => {
      if (result.ok) setPendingPurgeOne(undefined);
      showToast(result.message);
    });
  };

  const doPurgeAll = (): void => {
    void store.purgeAll().then((result) => {
      if (result.ok) {
        setPurgeAllOpen(false);
        setPurgeAck(false);
      }
      showToast(result.message);
    });
  };

  const trashCount = trash?.length ?? 0;
  // 家目录推一次给整页用：分组标题、详情副标题、详情里的「位置」都靠它把路径缩写成 ~\…
  // （客户端拿不到 homeDir，是从 user-agents / user-dsh 两条契约固定的根路径反推的）。
  const homeDir = homeDirFromRoots(list?.roots ?? []);
  const counts = filterCounts(skills, context);
  const detail = detailId === undefined ? undefined : skills.find((skill) => skill.id === detailId);

  const more: MenuItem[] = [
    ...remote.items,
    {
      id: "trash",
      label: trashCount > 0 ? t("skills.remote.menu.trashCount", { count: trashCount }) : t("skills.remote.menu.trash"),
      separatorBefore: true,
      testId: "skills-open-trash",
      onClick: openTrash,
    },
    ...(typeof workspace === "string" && workspace.trim() !== ""
      ? []
      : [{ id: "workspace", label: t("skills.remote.menu.workspaceNone"), info: true } as MenuItem]),
    remote.authItem,
  ];

  const toolbar = (
    <Toolbar
      testId="skills-toolbar"
      search={{ value: query, onChange: setQuery, placeholder: t("skills.searchPlaceholder"), testId: "skills-search" }}
      filters={{
        // 「需关注 0」调淡：没有问题时不抢眼，有问题时恢复正常。
        items: FILTERS.map((id) => ({
          id,
          label: filterLabel(id),
          count: counts[id],
          quiet: id === "attention" && counts[id] === 0,
        })),
        value: filter,
        onChange: (next: string) => setFilter(next as FilterId),
        label: t("skills.filterLabel"),
      }}
      afterFilters={<DirFilter list={list ?? EMPTY} value={dir} onChange={setDir} />}
      primary={{ label: t("skills.addSkill"), onClick: () => setAddOpen(true), testId: "skills-add-button" }}
      more={more}
    />
  );

  const warningsBanner =
    list !== undefined && list.warnings.length > 0 ? (
      <Banner tone="warn" testId="skills-warnings">
        <span>{t("skills.warnings.title") + "：" + list.warnings.join("；")}</span>
      </Banner>
    ) : null;

  const body =
    listError !== undefined && list === undefined ? (
      <div className={styles.root} data-testid="skills-list-error">
        <p className={styles.errorBox}>{t("skills.loadFailed", { message: listError })}</p>
        <Button size="sm" variant="outline" data-testid="skills-retry" onClick={reload}>
          {t("skills.retry")}
        </Button>
      </div>
    ) : (
      <SkillList
        list={list ?? EMPTY}
        workspace={workspace}
        {...(homeDir === undefined ? {} : { homeDir })}
        query={query}
        filter={filter}
        dir={dir}
        context={context}
        busyIds={busyIds}
        error={listError}
        loading={loading}
        onToggle={onToggle}
        onOpen={(skill: SkillSummary) => setDetailId(skill.id)}
        onAdd={() => setAddOpen(true)}
      />
    );

  return (
    <section className={styles.root} data-testid="capability-hub-tab-panel-skills" data-dsh-part="skills-tab">
      {toolbar}
      {warningsBanner}
      {body}
      {detail === undefined ? null : (
        <SkillDetailDrawer
          skill={detail}
          root={list?.roots.find((entry) => entry.rootId === detail.rootId)}
          workspace={workspace}
          {...(homeDir === undefined ? {} : { homeDir })}
          busy={busyIds.has(detail.id)}
          onToggle={(next: boolean) => onToggle(detail, next)}
          onChanged={reloadAll}
          onOpenTrash={openTrash}
          onDelete={() => {
            setDeleteErrors([]);
            setPendingDelete(detail);
          }}
          onClose={() => setDetailId(undefined)}
        />
      )}
      <AddSkillDrawer open={addOpen} workspace={workspace} onInstalled={reloadAll} onClose={() => setAddOpen(false)} />
      <TrashDrawer
        open={trashOpen}
        items={trash ?? []}
        loading={trashLoading}
        error={trashError}
        busyIds={trashBusyIds}
        purgingAll={purgingAll}
        onRestore={(item: TrashItem) => doRestore(item, false)}
        onPurgeOne={(item: TrashItem) => setPendingPurgeOne(item)}
        onPurgeAll={() => {
          setPurgeAck(false);
          setPurgeAllOpen(true);
        }}
        onRefresh={reloadTrash}
        onClose={() => setTrashOpen(false)}
      />
      <DeleteSkillDialog
        skill={pendingDelete}
        busy={pendingDelete !== undefined && busyIds.has(pendingDelete.id)}
        errors={deleteErrors}
        onConfirm={confirmDelete}
        onCancel={() => {
          setPendingDelete(undefined);
          setDeleteErrors([]);
        }}
      />
      <PurgeOneDialog
        item={pendingPurgeOne}
        busy={pendingPurgeOne !== undefined && trashBusyIds.has(pendingPurgeOne.trashId)}
        onConfirm={() => {
          if (pendingPurgeOne !== undefined) doPurgeOne(pendingPurgeOne);
        }}
        onCancel={() => setPendingPurgeOne(undefined)}
      />
      <PurgeAllDialog
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
      <RestoreConflictDialog
        item={pendingConflict}
        busy={pendingConflict !== undefined && trashBusyIds.has(pendingConflict.trashId)}
        errors={conflictErrors}
        onConfirm={() => {
          if (pendingConflict !== undefined) doRestore(pendingConflict, true);
        }}
        onCancel={() => {
          setPendingConflict(undefined);
          setConflictErrors([]);
        }}
      />
      {remote.dialogs}
      {toast === undefined ? null : (
        <Toast
          key={toast.seq}
          text={toast.text}
          holdMs={4000}
          {...(toast.action === undefined
            ? {}
            : { actions: [{ prefix: "", label: toast.action.label, onClick: toast.action.onClick }] })}
          onDone={() =>
            setToast((current) => (current !== undefined && current.seq === toast.seq ? undefined : current))
          }
        />
      )}
    </section>
  );
}

/** 技能标签页（对外只导出这一个）。 */
export function SkillsTab(props: TabProps): React.ReactElement {
  return (
    <TabErrorBoundary>
      <SkillsTabInner {...props} />
    </TabErrorBoundary>
  );
}
