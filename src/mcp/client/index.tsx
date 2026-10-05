/**
 * MCP 服务器标签页（UI-DESIGN §5）：工具栏 + 列表 + 三个抽屉。
 *
 * 页面自上而下只有四样常驻元素：**工具栏、列表**（首屏；页头与标签由外壳提供）。
 * 其余全部按需出现：
 *   - 详情抽屉：点行打开，概览 / 工具 / 环境变量与请求头 / 最近失败，底部删除｜JSON 编辑、编辑；
 *   - 编辑视图（表单 / JSON）在**同一个抽屉里**切换，沿用 T4b-1 的表单与校验；
 *   - 全局设置抽屉（工具栏「⋯」）；
 *   - 三种添加方式（粘贴 JSON / 预设模板 / 导入）仍在外壳的模态框里，沿用 T4b-2 的逻辑。
 *
 * 职责划分：
 *   - servers-store.ts：配置的读取与写操作、保存后的跟进、页面提示（可单测）；
 *   - runtime-store.ts：运行状态（轮询与重读都在里面）；
 *   - 本文件：把两个仓库接到界面上——列表与抽屉的路由、确认对话框的开合、错误边界；
 *   - list.tsx / detail.tsx / form.tsx / json.tsx / settings.tsx / dialogs.tsx / intake/*：视图；
 *   - model.ts：纯逻辑；data.ts：接口封装；strings.ts：全部文案。
 *
 * 决策落点：D-C1（只存改过的字段）、D-C2（四种添加入口）、D-C3（高级区覆盖全部字段 + JSON 模式，
 * 未知字段被服务端拒绝）、D-C4（保存时只查 PATH）、D-C5（每个服务器单独启停；env/headers 默认遮罩，
 * 显式「显示」才拿明文）、D-C6（保存后后台探测工具数）。
 */

import * as React from "react";
import { Button, Modal, Switch, Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import type { TabProps } from "../../platform/client/tab-props.ts";
import {
  Banner,
  Drawer,
  EmptyState,
  SkeletonRows,
  Toolbar,
  kit,
  searchFlag,
  useStoreState,
  type MenuItem,
} from "../../kit/index.ts";
import { RunningSection } from "./running/index.tsx";
import { DisconnectDialog, type DisconnectTarget } from "./running/dialogs.tsx";
import { ImportView } from "./intake/import.tsx";
import { JsonPasteView } from "./intake/json-paste.tsx";
import { PresetView } from "./intake/presets.tsx";
import { runtimeApi, serversApi } from "./data.ts";
import { createRuntimeStore, previewAdapter } from "./runtime-store.ts";
import { createServersStore } from "./servers-store.ts";
import { runningPreviewStatus } from "./running/region.ts";
import { ServerDetailBody } from "./detail.tsx";
import { DeleteServerDialog } from "./dialogs.tsx";
import { JsonEditor } from "./json.tsx";
import { ServerForm } from "./form.tsx";
import { ServerList } from "./list.tsx";
import {
  SERVER_FILTERS,
  activeInstanceCount,
  cooldownRemainingMs,
  draftFromValues,
  draftFromView,
  draftToJsonText,
  emptyServerDraft,
  filterLabel,
  runtimeIndex,
  serverFilterCounts,
  viewSummaryText,
  visibleServers,
  type ServerDraft,
  type ServerFilterId,
} from "./model.ts";
import { SettingsPanel } from "./settings.tsx";
import { injectMcpStyles, styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { ServerView } from "../contract/config.ts";

/* 样式只注入一次（模块加载时；无 document 时自动跳过）。 */
injectMcpStyles();

/** 「添加服务器」的另外三种方式（D-C2），在外壳的模态框里按视图切换。 */
export type IntakeView = "json" | "presets" | "import";

/** 抽屉里当前显示的内容。 */
type Panel =
  | { kind: "detail"; name: string }
  | { kind: "form"; originalName?: string; draft: ServerDraft }
  | { kind: "json"; originalName?: string; text: string };

/** 开发预览：URL 带 ?hubPreviewRunning=1 时「运行中」区域用示例数据（见 runtime/region.ts）。 */
function previewRunningFlag(): boolean {
  return typeof location !== "undefined" && searchFlag(location.search, "hubPreviewRunning");
}

/** 抽屉头部的一行副标题：太长就截断（完整值在概览里）。 */
function drawerSubtitle(text: string): string {
  return text.length > 72 ? text.slice(0, 71) + "…" : text;
}

/** 渲染异常兜底：MCP 页崩了也只影响这一块。 */
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
        <div className={styles.root} data-testid="mcp-crash">
          <p className={styles.fieldError}>{t("mcp.crash.title")}</p>
          <p className={styles.note}>{t("mcp.crash.hint", { message: this.state.error })}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function McpTabInner(props: TabProps): React.ReactElement {
  const [panel, setPanel] = React.useState<Panel | undefined>(undefined);
  const [intake, setIntake] = React.useState<IntakeView | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = React.useState<boolean>(false);
  const [pendingDelete, setPendingDelete] = React.useState<ServerView | undefined>(undefined);
  /** 抽屉里「断开全部实例」的确认目标。 */
  const [pendingDisconnect, setPendingDisconnect] = React.useState<DisconnectTarget | undefined>(undefined);
  const [query, setQuery] = React.useState<string>("");
  const [filter, setFilter] = React.useState<ServerFilterId>("all");
  const [now, setNow] = React.useState<number>(() => Date.now());
  const previewRunning = React.useMemo(previewRunningFlag, []);
  /** 运行状态只有这一份：服务器行、详情抽屉、「运行中」、标签红点都读它（runtime-store.ts）。 */
  const runtimeStore = React.useMemo(
    () => createRuntimeStore(previewRunning ? previewAdapter(runtimeApi, runningPreviewStatus) : runtimeApi),
    [previewRunning],
  );
  const store = React.useMemo(() => createServersStore(serversApi, runtimeStore), [runtimeStore]);
  const runtime = useStoreState(runtimeStore.state).status;
  const { config, loadError, loading, busy, deleting, refreshing, disconnecting, notice } = useStoreState(store.state);
  React.useEffect(() => runtimeStore.startPolling(), [runtimeStore]);
  React.useEffect(() => void store.reload(), [store]);

  const servers = config?.servers ?? [];
  const names = servers.map((server) => server.serverName);
  const rows = React.useMemo(() => runtimeIndex(runtime), [runtime]);
  const visible = React.useMemo(() => visibleServers(servers, rows, query, filter), [servers, rows, query, filter]);
  const counts = React.useMemo(() => serverFilterCounts(servers, rows), [servers, rows]);
  /** 有服务器处于「有错误」时让外壳在「MCP」标签旁画红点。 */
  const reportAttention = props.reportAttention;
  React.useEffect(() => reportAttention?.("mcp", counts.failing > 0), [reportAttention, counts.failing]);

  /** 冷却倒计时用的本地时钟：只在真的有冷却、或详情抽屉开着时走。 */
  const cooling = servers.some((view) => cooldownRemainingMs(rows.get(view.serverName)?.lastFailure, now) > 0);
  React.useEffect(() => {
    if (!cooling && panel === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cooling, panel]);

  const notify = (text: string, tone?: "success"): void => store.notify(text, tone);
  const onSaved = (server: ServerView, warnings: readonly string[]): void => {
    setPanel(undefined);
    store.serverSaved(server, warnings);
  };
  const confirmDelete = (): void => {
    const server = pendingDelete;
    if (server === undefined) return;
    void store.remove(server.serverName).then((removed) => {
      if (!removed) return;
      setPendingDelete(undefined);
      setPanel((current) =>
        current !== undefined && current.kind === "detail" && current.name === server.serverName ? undefined : current,
      );
    });
  };
  const confirmDisconnectAll = (target: DisconnectTarget): void => {
    void store.disconnectAll(target.name).then(() => setPendingDisconnect(undefined));
  };

  const openNewForm = (): void => setPanel({ kind: "form", draft: emptyServerDraft("stdio") });
  const openEdit = (view: ServerView): void =>
    setPanel({ kind: "form", originalName: view.serverName, draft: draftFromView(view) });
  const openJson = (view: ServerView): void =>
    setPanel({ kind: "json", originalName: view.serverName, text: draftToJsonText(draftFromView(view)) });

  const detailView =
    panel !== undefined && panel.kind === "detail"
      ? servers.find((server) => server.serverName === panel.name)
      : undefined;

  /** 抽屉/模态框的标题。 */
  const panelTitle = ((): string => {
    if (panel === undefined) return "";
    if (panel.kind === "detail") return panel.name;
    if (panel.kind === "form") {
      return panel.originalName === undefined
        ? t("mcp.form.newTitle")
        : t("mcp.form.editTitle", { name: panel.originalName });
    }
    return panel.originalName === undefined
      ? t("mcp.json.newTitle")
      : t("mcp.json.title", { name: panel.originalName });
  })();

  const addMenu: MenuItem[] = [
    { id: "mcp-add-form", label: t("mcp.add.form"), hint: t("mcp.add.formHint"), onClick: openNewForm },
    { id: "mcp-add-json", label: t("mcp.add.json"), hint: t("mcp.add.jsonHint"), onClick: () => setIntake("json") },
    {
      id: "mcp-add-preset",
      label: t("mcp.add.preset"),
      hint: t("mcp.add.presetHint"),
      onClick: () => setIntake("presets"),
    },
    {
      id: "mcp-add-import",
      label: t("mcp.add.import"),
      hint: t("mcp.add.importHint"),
      onClick: () => setIntake("import"),
    },
  ];

  const intakeNode =
    intake === undefined ? null : intake === "json" ? (
      <JsonPasteView
        existingNames={names}
        onSaved={(saved: readonly string[]) => store.batchSaved(saved, true)}
        showToast={notify}
      />
    ) : intake === "presets" ? (
      <PresetView
        onUsePreset={(draft: ServerDraft) => {
          setIntake(undefined);
          setPanel({ kind: "form", draft });
        }}
      />
    ) : (
      <ImportView
        existingNames={names}
        onImported={(saved: readonly string[]) => store.batchSaved(saved, false)}
        showToast={notify}
      />
    );

  /** 列表区：加载中骨架屏 / 读取失败横幅 / 空状态 / 真的列表。 */
  const body = ((): React.ReactElement => {
    if (loadError !== undefined) {
      return (
        <Banner
          tone="danger"
          testId="mcp-load-error"
          action={{ label: t("mcp.retry"), onClick: () => void store.reload(), testId: "mcp-retry" }}
        >
          {t("mcp.loadFailed", { message: loadError })}
        </Banner>
      );
    }
    if (config === undefined || loading) {
      return <SkeletonRows testId="mcp-loading" />;
    }
    if (servers.length === 0) {
      return (
        <EmptyState
          title={t("mcp.empty.title")}
          description={t("mcp.empty.hint")}
          action={{ label: t("mcp.empty.add"), onClick: openNewForm, testId: "mcp-empty-add" }}
          testId="mcp-empty"
        />
      );
    }
    if (visible.length === 0) {
      return (
        <p className={styles.note} data-testid="mcp-empty-filtered">
          {t("mcp.empty.filtered")}
        </p>
      );
    }
    return (
      <ServerList
        servers={visible}
        runtime={runtime}
        busy={busy}
        now={now}
        onToggle={(view: ServerView, disabled: boolean) => void store.toggle(view, disabled)}
        onOpen={(view: ServerView) => setPanel({ kind: "detail", name: view.serverName })}
        onReorder={(from: number, to: number) => void store.move(from, to)}
      />
    );
  })();

  const warnings = config?.warnings ?? [];

  return (
    <section className={styles.root} data-testid="capability-hub-tab-panel-mcp" data-dsh-part="mcp-tab">
      <Toolbar
        testId="mcp-toolbar"
        search={{ value: query, onChange: setQuery, placeholder: t("mcp.search"), testId: "mcp-search" }}
        filters={{
          value: filter,
          onChange: (id: string) => setFilter(id as ServerFilterId),
          label: t("mcp.filter.label"),
          // 「有错误 0」调淡：没有错误时不抢眼。
          items: SERVER_FILTERS.map((id) => ({
            id,
            label: filterLabel(id),
            count: counts[id],
            quiet: id === "failing" && counts[id] === 0,
          })),
        }}
        primary={{ label: t("mcp.add.button"), menu: addMenu, testId: "mcp-add-menu" }}
        more={[{ id: "mcp-settings-open", label: t("mcp.settings.title"), onClick: () => setSettingsOpen(true) }]}
      />
      {warnings.length === 0 ? null : (
        <Banner tone="warn" testId="mcp-config-warnings">
          {t("mcp.warnings.title", { count: warnings.length }) + " " + warnings.join("；")}
        </Banner>
      )}
      {body}
      {/* 0.3.0：原「运行态」标签并入这里，成为页面底部可折叠的「运行中」区域（D-E1）。 */}
      <RunningSection
        store={runtimeStore}
        {...(props.sessionId === undefined ? {} : { sessionId: props.sessionId })}
        preview={previewRunning}
      />
      {/* 详情 / 编辑抽屉（同一个抽屉，内容按 panel 切换）。 */}
      <Drawer
        open={panel !== undefined}
        title={panelTitle}
        // 抽屉头部的等宽副标题只放一行：命令可能很长，全文在「概览」里（UI-DESIGN §1「安静」）。
        {...(detailView === undefined ? {} : { subtitle: drawerSubtitle(viewSummaryText(detailView)) })}
        testId="mcp-drawer"
        onClose={() => setPanel(undefined)}
        {...(detailView === undefined
          ? {}
          : {
              headerEnd: (
                <Switch
                  checked={!detailView.disabled}
                  disabled={busy.has(detailView.serverName)}
                  label={t("mcp.row.toggleLabel", { name: detailView.serverName })}
                  onChange={(next: boolean) => void store.toggle(detailView, !next)}
                />
              ),
              footer: (
                <React.Fragment>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={kit.dangerButton}
                    data-testid="mcp-detail-delete"
                    title={t("mcp.detail.deleteTitle", { name: detailView.serverName })}
                    onClick={() => setPendingDelete(detailView)}
                  >
                    {t("mcp.delete")}
                  </Button>
                  <span className={kit.drawerFootSpacer} />
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="mcp-detail-json"
                    title={t("mcp.detail.jsonTitle", { name: detailView.serverName })}
                    onClick={() => openJson(detailView)}
                  >
                    {t("mcp.jsonMode")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="mcp-detail-edit"
                    title={t("mcp.detail.editTitle", { name: detailView.serverName })}
                    onClick={() => openEdit(detailView)}
                  >
                    {t("mcp.edit")}
                  </Button>
                </React.Fragment>
              ),
            })}
      >
        {detailView !== undefined ? (
          <ServerDetailBody
            view={detailView}
            row={rows.get(detailView.serverName)}
            now={now}
            refreshing={refreshing === detailView.serverName}
            onRefresh={() => void store.refreshCache(detailView.serverName)}
            instances={activeInstanceCount(runtime, detailView.serverName)}
            onDisconnectAll={() => setPendingDisconnect({ name: detailView.serverName })}
            showToast={notify}
          />
        ) : panel !== undefined && panel.kind === "form" ? (
          <ServerForm
            {...(panel.originalName === undefined ? {} : { originalName: panel.originalName })}
            initial={panel.draft}
            existingNames={names}
            onSaved={onSaved}
            onCancel={() => setPanel(undefined)}
            onSwitchToJson={(draft: ServerDraft) =>
              setPanel({
                kind: "json",
                ...(panel.originalName === undefined ? {} : { originalName: panel.originalName }),
                text: draftToJsonText(draft),
              })
            }
            showToast={(text: string) => notify(text)}
          />
        ) : panel !== undefined && panel.kind === "json" ? (
          <JsonEditor
            {...(panel.originalName === undefined ? {} : { originalName: panel.originalName })}
            initialText={panel.text}
            onSaved={onSaved}
            onCancel={() => setPanel(undefined)}
            onSwitchToForm={(values: Record<string, unknown>) =>
              setPanel({
                kind: "form",
                ...(panel.originalName === undefined ? {} : { originalName: panel.originalName }),
                draft: draftFromValues(values),
              })
            }
          />
        ) : null}
      </Drawer>
      {/* 全局设置抽屉。 */}
      <Drawer
        open={settingsOpen && config !== undefined}
        title={t("mcp.settings.title")}
        testId="mcp-settings-drawer"
        onClose={() => setSettingsOpen(false)}
      >
        {config === undefined ? null : (
          <SettingsPanel
            settings={config.settings}
            settingsSet={config.settingsSet}
            onSaved={(settings, settingsSet) => store.settingsSaved(settings, settingsSet)}
          />
        )}
      </Drawer>
      {/* 三种添加方式（沿用 T4b-2 的视图）。 */}
      <Modal
        open={intake !== undefined}
        onClose={() => setIntake(undefined)}
        title={
          intake === "json"
            ? t("mcp.paste.title")
            : intake === "presets"
              ? t("mcp.preset.title")
              : t("mcp.import.title")
        }
        closeLabel={t("mcp.close")}
        className={styles.intakeModal}
      >
        <div className={kit.scope}>{intakeNode}</div>
      </Modal>
      <DisconnectDialog
        target={pendingDisconnect}
        busy={disconnecting}
        onConfirm={confirmDisconnectAll}
        onCancel={() => setPendingDisconnect(undefined)}
      />
      <DeleteServerDialog
        server={pendingDelete}
        busy={deleting}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(undefined)}
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

/** MCP 标签页（对外只导出这一个）。 */
export function McpTab(props: TabProps): React.ReactElement {
  return (
    <TabErrorBoundary>
      <McpTabInner {...props} />
    </TabErrorBoundary>
  );
}
