/**
 * 技能标签页（UI-DESIGN §4）：**工具栏 + 列表 + 三个抽屉**，没有二级导航、没有常驻统计行、
 * 没有常驻说明文字。数据流（list / trash 的加载与写操作）仍然集中在这里，
 * 视图层（list.tsx / detail.tsx / trash.tsx / remote/*）只做展示。
 *
 * 硬约束：
 *   - 组件绝不 throw：请求错误一律转成界面状态；渲染异常由 TabErrorBoundary 兜底；
 *   - 接口错误直接显示服务端返回的中文 message；VALIDATION 的 details 落到对话框字段上；
 *   - 启停成功后只替换那一行（验收 U2）；
 *   - 「检查更新」这类结果走 Toast，不再常驻成胶囊；有更新的行上出现「可更新」标记。
 */

import * as React from "react";
import { Button, Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import type { TabProps } from "../../platform/client/tab-props.ts";
import { Banner, Toolbar } from "../../kit/index.ts";
import type { MenuItem } from "../../kit/index.ts";
import { AddSkillDrawer } from "./remote/install-view.tsx";
import { useSkillsRemoteMenu } from "./remote/batch.tsx";
import { deleteSkill, listSkills, listTrash, purgeTrash, restoreTrash, setSkillEnabled } from "./data.ts";
import {
  displayName,
  errorMessage,
  homeDirFromRoots,
  fieldErrors,
  filterCounts,
  filterLabel,
  FILTERS,
  isConflict,
  removeSkill,
  replaceSkill,
  type FieldError,
  type FilterId,
  type MatchContext,
} from "./format.ts";
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
      return React.createElement(
        "div",
        { className: styles.root, "data-testid": "skills-crash" },
        React.createElement("p", { className: styles.errorBox }, t("skills.crash.title")),
        React.createElement("p", { className: styles.note }, t("skills.crash.hint", { message: this.state.error })),
      );
    }
    return this.props.children;
  }
}

function SkillsTabInner(props: TabProps): React.ReactElement {
  const workspace = props.workspace;
  const [list, setList] = React.useState<ListResult | undefined>(undefined);
  const [listError, setListError] = React.useState<string | undefined>(undefined);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [trash, setTrash] = React.useState<TrashItem[] | undefined>(undefined);
  const [trashError, setTrashError] = React.useState<string | undefined>(undefined);
  const [trashLoading, setTrashLoading] = React.useState<boolean>(false);
  const [trashOpen, setTrashOpen] = React.useState<boolean>(false);
  const [addOpen, setAddOpen] = React.useState<boolean>(false);
  const [busyIds, setBusyIds] = React.useState<ReadonlySet<string>>(new Set<string>());
  const [trashBusyIds, setTrashBusyIds] = React.useState<ReadonlySet<string>>(new Set<string>());
  const [purgingAll, setPurgingAll] = React.useState<boolean>(false);
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

  const showToast = React.useCallback((text: string, extra?: { action?: { label: string; onClick: () => void } }): void => {
    toastSeq.current += 1;
    setToast({ seq: toastSeq.current, text, ...(extra ?? {}) });
  }, []);

  const reload = React.useCallback((): void => {
    setLoading(true);
    setListError(undefined);
    void listSkills(workspace).then(
      (payload) => {
        setList(payload);
        setLoading(false);
      },
      (failure: unknown) => {
        setListError(errorMessage(failure));
        setLoading(false);
      },
    );
  }, [workspace]);

  const reloadTrash = React.useCallback((): void => {
    setTrashLoading(true);
    setTrashError(undefined);
    void listTrash().then(
      (items) => {
        setTrash(items);
        setTrashLoading(false);
      },
      (failure: unknown) => {
        setTrashError(errorMessage(failure));
        setTrashLoading(false);
      },
    );
  }, []);

  React.useEffect(() => reload(), [reload]);
  React.useEffect(() => reloadTrash(), [reloadTrash]);

  /** 来源/更新这类写操作之后：技能列表与回收站计数都要跟上（更新会把旧版本送进回收站）。 */
  const reloadAll = React.useCallback((): void => {
    reload();
    reloadTrash();
  }, [reload, reloadTrash]);

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

  const markBusy = (id: string, busy: boolean): void => {
    setBusyIds((previous) => {
      const next = new Set(previous);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const markTrashBusy = (trashId: string, busy: boolean): void => {
    setTrashBusyIds((previous) => {
      const next = new Set(previous);
      if (busy) next.add(trashId);
      else next.delete(trashId);
      return next;
    });
  };

  /** 启停：成功后只替换这一行。 */
  const onToggle = (skill: SkillSummary, next: boolean): void => {
    markBusy(skill.id, true);
    const name = displayName(skill).text;
    void setSkillEnabled(skill.id, next, workspace)
      .then(
        (updated) => {
          setList((previous) => (previous === undefined ? previous : replaceSkill(previous, updated)));
          showToast(next ? t("skills.toast.toggleOn", { name }) : t("skills.toast.toggleOff", { name }));
        },
        (failure: unknown) => showToast(t("skills.toast.failed", { message: errorMessage(failure) })),
      )
      .finally(() => markBusy(skill.id, false));
  };

  const confirmDelete = (): void => {
    const skill = pendingDelete;
    if (skill === undefined) return;
    const name = displayName(skill).text;
    markBusy(skill.id, true);
    void deleteSkill(skill.id, workspace)
      .then(
        () => {
          setList((previous) => (previous === undefined ? previous : removeSkill(previous, skill.id)));
          setPendingDelete(undefined);
          setDeleteErrors([]);
          setDetailId(undefined);
          reloadTrash();
          showToast(t("skills.delete.done", { name }), {
            action: { label: t("skills.delete.openTrash"), onClick: openTrash },
          });
        },
        (failure: unknown) => {
          setDeleteErrors(fieldErrors(failure));
          showToast(t("skills.toast.failed", { message: errorMessage(failure) }));
        },
      )
      .finally(() => markBusy(skill.id, false));
  };

  /** 恢复；默认不带 replace，冲突时再问用户是否覆盖。 */
  const doRestore = (item: TrashItem, replace: boolean): void => {
    markTrashBusy(item.trashId, true);
    void restoreTrash(item.trashId, replace, workspace)
      .then(
        () => {
          setPendingConflict(undefined);
          setConflictErrors([]);
          reload();
          reloadTrash();
          showToast(t("skills.trash.restored", { name: item.name ?? item.dirName }));
        },
        (failure: unknown) => {
          setConflictErrors(fieldErrors(failure));
          if (!replace && isConflict(failure)) {
            setPendingConflict(item);
          } else {
            showToast(t("skills.toast.failed", { message: errorMessage(failure) }));
          }
        },
      )
      .finally(() => markTrashBusy(item.trashId, false));
  };

  const doPurgeOne = (item: TrashItem): void => {
    markTrashBusy(item.trashId, true);
    void purgeTrash(item.trashId)
      .then(
        () => {
          setPendingPurgeOne(undefined);
          reloadTrash();
          showToast(t("skills.trash.purgedOne"));
        },
        (failure: unknown) => showToast(t("skills.toast.failed", { message: errorMessage(failure) })),
      )
      .finally(() => markTrashBusy(item.trashId, false));
  };

  const doPurgeAll = (): void => {
    setPurgingAll(true);
    void purgeTrash(undefined)
      .then(
        (purged) => {
          setPurgeAllOpen(false);
          setPurgeAck(false);
          reloadTrash();
          showToast(t("skills.trash.purgedAll", { count: purged }));
        },
        (failure: unknown) => showToast(t("skills.toast.failed", { message: errorMessage(failure) })),
      )
      .finally(() => setPurgingAll(false));
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

  const toolbar = React.createElement(Toolbar, {
    testId: "skills-toolbar",
    search: { value: query, onChange: setQuery, placeholder: t("skills.searchPlaceholder"), testId: "skills-search" },
    filters: {
      // 「需关注 0」调淡：没有问题时不抢眼，有问题时恢复正常。
      items: FILTERS.map((id) => ({ id, label: filterLabel(id), count: counts[id], quiet: id === "attention" && counts[id] === 0 })),
      value: filter,
      onChange: (next: string) => setFilter(next as FilterId),
      label: t("skills.filterLabel"),
    },
    afterFilters: React.createElement(DirFilter, { list: list ?? EMPTY, value: dir, onChange: setDir }),
    primary: { label: t("skills.addSkill"), onClick: () => setAddOpen(true), testId: "skills-add-button" },
    more,
  });

  const warningsBanner = list !== undefined && list.warnings.length > 0
    ? React.createElement(Banner, { tone: "warn", testId: "skills-warnings" },
      React.createElement("span", null, t("skills.warnings.title") + "：" + list.warnings.join("；")))
    : null;

  const body = listError !== undefined && list === undefined
    ? React.createElement("div", { className: styles.root, "data-testid": "skills-list-error" },
      React.createElement("p", { className: styles.errorBox }, t("skills.loadFailed", { message: listError })),
      React.createElement(Button, { size: "sm", variant: "outline", "data-testid": "skills-retry", onClick: reload }, t("skills.retry")))
    : React.createElement(SkillList, {
      list: list ?? EMPTY,
      workspace,
      ...(homeDir === undefined ? {} : { homeDir }),
      query,
      filter,
      dir,
      context,
      busyIds,
      error: listError,
      loading,
      onToggle,
      onOpen: (skill: SkillSummary) => setDetailId(skill.id),
      onAdd: () => setAddOpen(true),
    });

  return React.createElement("section", {
    className: styles.root,
    "data-testid": "capability-hub-tab-panel-skills",
    "data-dsh-part": "skills-tab",
  },
  toolbar,
  warningsBanner,
  body,
  detail === undefined
    ? null
    : React.createElement(SkillDetailDrawer, {
      skill: detail,
      root: list?.roots.find((entry) => entry.rootId === detail.rootId),
      workspace,
      ...(homeDir === undefined ? {} : { homeDir }),
      busy: busyIds.has(detail.id),
      onToggle: (next: boolean) => onToggle(detail, next),
      onChanged: reloadAll,
      onOpenTrash: openTrash,
      onDelete: () => {
        setDeleteErrors([]);
        setPendingDelete(detail);
      },
      onClose: () => setDetailId(undefined),
    }),
  React.createElement(AddSkillDrawer, {
    open: addOpen,
    workspace,
    onInstalled: reloadAll,
    onClose: () => setAddOpen(false),
  }),
  React.createElement(TrashDrawer, {
    open: trashOpen,
    items: trash ?? [],
    loading: trashLoading,
    error: trashError,
    busyIds: trashBusyIds,
    purgingAll,
    onRestore: (item: TrashItem) => doRestore(item, false),
    onPurgeOne: (item: TrashItem) => setPendingPurgeOne(item),
    onPurgeAll: () => {
      setPurgeAck(false);
      setPurgeAllOpen(true);
    },
    onRefresh: reloadTrash,
    onClose: () => setTrashOpen(false),
  }),
  React.createElement(DeleteSkillDialog, {
    skill: pendingDelete,
    busy: pendingDelete !== undefined && busyIds.has(pendingDelete.id),
    errors: deleteErrors,
    onConfirm: confirmDelete,
    onCancel: () => {
      setPendingDelete(undefined);
      setDeleteErrors([]);
    },
  }),
  React.createElement(PurgeOneDialog, {
    item: pendingPurgeOne,
    busy: pendingPurgeOne !== undefined && trashBusyIds.has(pendingPurgeOne.trashId),
    onConfirm: () => {
      if (pendingPurgeOne !== undefined) doPurgeOne(pendingPurgeOne);
    },
    onCancel: () => setPendingPurgeOne(undefined),
  }),
  React.createElement(PurgeAllDialog, {
    open: purgeAllOpen,
    count: trashCount,
    acknowledged: purgeAck,
    busy: purgingAll,
    onAcknowledgedChange: setPurgeAck,
    onConfirm: doPurgeAll,
    onCancel: () => {
      setPurgeAllOpen(false);
      setPurgeAck(false);
    },
  }),
  React.createElement(RestoreConflictDialog, {
    item: pendingConflict,
    busy: pendingConflict !== undefined && trashBusyIds.has(pendingConflict.trashId),
    errors: conflictErrors,
    onConfirm: () => {
      if (pendingConflict !== undefined) doRestore(pendingConflict, true);
    },
    onCancel: () => {
      setPendingConflict(undefined);
      setConflictErrors([]);
    },
  }),
  remote.dialogs,
  toast === undefined
    ? null
    : React.createElement(Toast, {
      key: toast.seq,
      text: toast.text,
      holdMs: 4000,
      ...(toast.action === undefined
        ? {}
        : { actions: [{ prefix: "", label: toast.action.label, onClick: toast.action.onClick }] }),
      onDone: () =>
        setToast((current) => (current !== undefined && current.seq === toast.seq ? undefined : current)),
    }));
}

/** 技能标签页（对外只导出这一个）。 */
export function SkillsTab(props: TabProps): React.ReactElement {
  return React.createElement(TabErrorBoundary, null, React.createElement(SkillsTabInner, props));
}
