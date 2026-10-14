/**
 * MCP 服务器标签页（UI-DESIGN §5）：工具栏 + 列表 + 一个抽屉。
 *
 * 页面自上而下只有两样常驻元素：**工具栏、列表**（页头与标签由外壳提供）。其余全部按需出现：
 *   - 详情抽屉：点行打开，概览 / 工具（状态 + 模型看到的工具名 + 重新连接）/ 环境变量与请求头，
 *     底部删除｜JSON 编辑；
 *   - JSON 编辑在**同一个抽屉里**切换（0.7.0 起修改服务器只用 JSON，D-C3）；
 *   - 「添加服务器」打开粘贴 JSON 的模态框（0.7.0 起唯一的添加方式，D-C2）。
 *
 * 职责划分：
 *   - servers-store.ts：配置的读取与写操作、保存后的跟进、页面提示（可单测）；
 *   - runtime-store.ts：运行状态（轮询与重读都在里面）；
 *   - 本文件：把两个仓库接到界面上——抽屉的路由、确认对话框的开合、错误边界；
 *   - list.tsx / detail.tsx / json.tsx / dialogs.tsx / intake/json-paste.tsx：视图；
 *   - json-model.ts：JSON 编辑的纯逻辑；view-model.ts：列表与展示逻辑；data.ts：接口封装；strings.ts：全部文案。
 *
 * 决策落点：D-C1（只存改过的字段）、D-C2 / D-C3（只用 JSON）、D-C4（保存时只查 PATH）、
 * D-C5（每个服务器单独启停；env/headers 默认遮罩，显式「显示」才拿明文）、ADR-0010（官方 MCP 插件连接）。
 */

import * as React from "react";
import { Button, Modal, Switch, Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import type { TabProps } from "../../platform/client/tab-props.ts";
import { Banner, Drawer, EmptyState, SkeletonRows, Toolbar, kit, useStoreState } from "../../kit/index.ts";
import { JsonPasteView } from "./intake/json-paste.tsx";
import { runtimeApi, serversApi } from "./data.ts";
import { createRuntimeStore } from "./runtime-store.ts";
import { createServersStore } from "./servers-store.ts";
import { ServerDetailBody } from "./detail.tsx";
import { DeleteServerDialog } from "./dialogs.tsx";
import { JsonEditor } from "./json.tsx";
import { ServerList } from "./list.tsx";
import { serverJsonText } from "./json-model.ts";
import {
  SERVER_FILTERS,
  filterLabel,
  runtimeIndex,
  serverFilterCounts,
  viewSummaryText,
  visibleServers,
  type ServerFilterId,
} from "./view-model.ts";
import { injectMcpStyles, styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { ServerView } from "../contract/config.ts";

/* 样式只注入一次（模块加载时；无 document 时自动跳过）。 */
injectMcpStyles();

/** 抽屉里当前显示的内容。 */
type Panel = { kind: "detail"; name: string } | { kind: "json"; name: string; text: string };

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
  const [pasteOpen, setPasteOpen] = React.useState<boolean>(false);
  const [pendingDelete, setPendingDelete] = React.useState<ServerView | undefined>(undefined);
  const [query, setQuery] = React.useState<string>("");
  const [filter, setFilter] = React.useState<ServerFilterId>("all");
  /** 运行状态只有这一份：服务器行、详情抽屉、标签红点都读它（runtime-store.ts）。 */
  const runtimeStore = React.useMemo(() => createRuntimeStore(runtimeApi), []);
  const store = React.useMemo(() => createServersStore(serversApi, runtimeStore), [runtimeStore]);
  const runtime = useStoreState(runtimeStore.state).status;
  const { config, loadError, loading, busy, deleting, reconnecting, notice } = useStoreState(store.state);
  React.useEffect(() => runtimeStore.startPolling(), [runtimeStore]);
  React.useEffect(() => void store.reload(), [store]);

  const servers = config?.servers ?? [];
  const names = servers.map((server) => server.serverName);
  const rows = React.useMemo(() => runtimeIndex(runtime), [runtime]);
  const visible = React.useMemo(() => visibleServers(servers, rows, query, filter), [servers, rows, query, filter]);
  const counts = React.useMemo(() => serverFilterCounts(servers, rows), [servers, rows]);
  /** 有服务器连接失败时让外壳在「MCP」标签旁画红点。 */
  const reportAttention = props.reportAttention;
  React.useEffect(() => reportAttention?.("mcp", counts.failing > 0), [reportAttention, counts.failing]);

  const notify = (text: string, tone?: "success"): void => store.notify(text, tone);
  const onSaved = (server: ServerView, warnings: readonly string[]): void => {
    setPanel({ kind: "detail", name: server.serverName });
    store.serverSaved(server, warnings);
  };
  const confirmDelete = (): void => {
    const server = pendingDelete;
    if (server === undefined) return;
    void store.remove(server.serverName).then((removed) => {
      if (!removed) return;
      setPendingDelete(undefined);
      setPanel((current) => (current !== undefined && current.name === server.serverName ? undefined : current));
    });
  };

  const openJson = (view: ServerView): void =>
    setPanel({ kind: "json", name: view.serverName, text: serverJsonText(view) });

  const detailView =
    panel !== undefined && panel.kind === "detail"
      ? servers.find((server) => server.serverName === panel.name)
      : undefined;

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
          action={{ label: t("mcp.empty.add"), onClick: () => setPasteOpen(true), testId: "mcp-empty-add" }}
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
        rows={rows}
        busy={busy}
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
        primary={{ label: t("mcp.add.button"), onClick: () => setPasteOpen(true), testId: "mcp-add" }}
      />
      {warnings.length === 0 ? null : (
        <Banner tone="warn" testId="mcp-config-warnings">
          {t("mcp.warnings.title", { count: warnings.length }) + " " + warnings.join("；")}
        </Banner>
      )}
      {body}
      {/* 详情 / JSON 编辑抽屉（同一个抽屉，内容按 panel 切换）。 */}
      <Drawer
        open={panel !== undefined}
        title={
          panel === undefined ? "" : panel.kind === "detail" ? panel.name : t("mcp.json.title", { name: panel.name })
        }
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
                </React.Fragment>
              ),
            })}
      >
        {detailView !== undefined ? (
          <ServerDetailBody
            view={detailView}
            row={rows.get(detailView.serverName)}
            reconnecting={reconnecting === detailView.serverName}
            onReconnect={() => void store.reconnect(detailView.serverName)}
            showToast={notify}
          />
        ) : panel !== undefined && panel.kind === "json" ? (
          <JsonEditor
            originalName={panel.name}
            initialText={panel.text}
            onSaved={onSaved}
            onCancel={() => setPanel({ kind: "detail", name: panel.name })}
          />
        ) : null}
      </Drawer>
      {/* 添加服务器：粘贴 JSON。 */}
      <Modal
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        title={t("mcp.paste.title")}
        closeLabel={t("mcp.close")}
        className={styles.intakeModal}
      >
        <div className={kit.scope}>
          <JsonPasteView
            existingNames={names}
            onSaved={(saved: readonly string[]) => store.batchSaved(saved)}
            showToast={notify}
          />
        </div>
      </Modal>
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
