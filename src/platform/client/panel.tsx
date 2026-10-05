/**
 * 能力中心页面（页头 + 三标签 + 降级横幅 + 诊断模态框）。
 *
 * 【UI-0 外壳改造】按 docs/UI-DESIGN.md §2：
 *   - 页头只有「能力中心」（18/600），**去掉了副标题**；
 *   - 右侧一个「ⓘ」，点开模态框看原来的诊断信息；常驻的诊断卡片**从页面上移除**；
 *   - 只有某个模块降级 / mcp 工具退回桩时，页头下方才出现一条 warn 横幅；
 *   - 三个标签**同时挂载**，切换只改可见性 —— 搜索、筛选、滚动位置因此不会丢。
 *
 * 页面结构（自 上 而 下，UI-DESIGN §7 要求首屏常驻元素只有这些）：
 *   页头（标题 + ⓘ） → 标签 → [降级横幅] → 标签正文
 *
 * 开发预览：URL 带 ?hubKitPreview=1 时，正文位置换成 kit 预览面板（正式使用时看不到）。
 */
import * as React from "react";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { fetchHealth, type HealthPayload } from "./api.ts";
import { t as tt } from "./strings.ts";
import { useCurrentSession, type SessionsHook } from "./useCurrentWorkspace.ts";
import { styles } from "./styles.ts";
import { degradeInfo, degradeNames, hostVersionMismatch } from "./degrade.ts";
import { HUB_VERSION } from "../../version.ts";
import { Banner, KitPreview, searchFlag } from "../../kit/index.ts";
import { SkillsTab } from "../../skills/client/index.tsx";
import { McpTab } from "../../mcp/client/index.tsx";
import type { PanelTab, TabProps } from "./tab-props.ts";

/** 标签 id（契约见 tab-props.ts，这里再导出一次方便老代码引用）。 */
export type { PanelTab } from "./tab-props.ts";

/** 标签定义（顺序即 UI 顺序）。 */
const TABS: Array<{ id: PanelTab; labelKey: string }> = [
  { id: "skills", labelKey: "tab.skills" },
  { id: "mcp", labelKey: "tab.mcp" },
];

/** 外部（插件管理页的配置按钮）可以要求直达某个标签。 */
let pendingTab: PanelTab | undefined;

/** 请求页面切到某个标签（页面还没挂载时先记下）。 */
export function requestTab(tab: PanelTab): void {
  pendingTab = tab;
  for (const listener of tabListeners) listener(tab);
}

const tabListeners = new Set<(tab: PanelTab) => void>();

/** 订阅「直达标签」请求。 */
export function onRequestTab(listener: (tab: PanelTab) => void): () => void {
  tabListeners.add(listener);
  if (pendingTab !== undefined) listener(pendingTab);
  return () => {
    tabListeners.delete(listener);
  };
}

/** 是否处于 kit 预览模式（只认 URL 参数，正式使用时永远为 false）。 */
export function kitPreviewEnabled(): boolean {
  try {
    return typeof location !== "undefined" && searchFlag(location.search, "hubKitPreview");
  } catch {
    return false;
  }
}

/** 标签栏（下划线式）。 */
function TabBar({
  active,
  onSelect,
  attention,
}: {
  active: PanelTab;
  onSelect: (tab: PanelTab) => void;
  attention: ReadonlySet<PanelTab>;
}): React.ReactElement {
  return (
    <div className={styles.tabBar} role="tablist" data-dsh-part="tab-bar">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={"capability-hub-tab-" + tab.id}
          aria-selected={active === tab.id}
          aria-controls={"capability-hub-panel-" + tab.id}
          data-testid={"capability-hub-tab-" + tab.id}
          data-active={active === tab.id ? "" : undefined}
          className={styles.tab}
          onClick={() => onSelect(tab.id)}
        >
          {tt(tab.labelKey)}
          {/* 红点：这个标签里有错误（例如 MCP 有服务器连接失败）；红色只表示错误（UI-DESIGN 原则 4）。 */}
          {attention.has(tab.id) ? (
            <span
              className={styles.tabDot}
              title={tt("tab.attention")}
              aria-label={tt("tab.attention")}
              data-testid={"capability-hub-tab-dot-" + tab.id}
            />
          ) : null}
        </button>
      ))}
    </div>
  );
}

/**
 * 诊断模态框正文（「ⓘ」打开的）。
 *
 * 兼容性：根节点保留 data-testid="capability-hub-env" —— 阶段 C 的 DOM 证据脚本
 * 靠它取「环境事实」，现在它只在这个模态框打开时存在于 DOM 里。
 */
function DiagnosticsBody(props: {
  health: HealthPayload | undefined;
  error: string | undefined;
  loading: boolean;
  workspace: string | undefined;
}): React.ReactElement {
  const rows: Array<[string, string]> = [];
  const health = props.health;
  if (health !== undefined) {
    rows.push([tt("env.profile"), health.profileName]);
    rows.push([tt("env.home"), health.homeDir]);
    rows.push([tt("env.dshHome"), health.dshHome]);
    rows.push([tt("env.hubHome"), health.hubHome]);
    rows.push([
      tt("env.sdk"),
      health.sdk.status === "loaded"
        ? "v" + (health.sdk.version ?? "?") + " — " + (health.sdk.mainResolved ?? "")
        : "失败：" + (health.sdk.message ?? ""),
    ]);
    rows.push([tt("env.modules"), health.modules.map((m) => m.name + "=" + m.status).join("，")]);
    rows.push([
      tt("env.tool"),
      health.tool.name + "（" + (health.tool.registered ? tt("status.ok") : tt("status.degraded")) + "）",
    ]);
  }
  rows.push([tt("env.workspace"), props.workspace ?? tt("env.workspaceNone")]);
  return (
    <div className={styles.diagBody} data-testid="capability-hub-env">
      {props.loading ? <p className={styles.muted}>{tt("env.loading")}</p> : null}
      {props.error !== undefined ? <p className={styles.error}>{tt("env.failed", { message: props.error })}</p> : null}
      <dl className={styles.kv}>
        {rows.flatMap(([label, value]) => [
          <dt key={"k-" + label} className={styles.kvKey}>
            {label}
          </dt>,
          <dd key={"v-" + label} className={styles.kvValue} title={value}>
            {value}
          </dd>,
        ])}
      </dl>
    </div>
  );
}

/**
 * 标签正文：两个标签各自在自己的目录里实现（src/skills/client|mcp；0.3.0 起运行态是 MCP 页底部的「运行中」区域），
 * 外壳只负责按 TabProps 契约传值（见 tab-props.ts 与 docs/CLIENT-GUIDE.md 第 3 节）。
 */
function TabBody({ tab, props }: { tab: PanelTab; props: TabProps }): React.ReactElement {
  switch (tab) {
    case "skills":
      return <SkillsTab {...props} />;
    case "mcp":
      return <McpTab {...props} />;
  }
}

/** 能力中心主页。 */
export function CapabilityHubPage(props: Record<string, unknown>): React.ReactElement {
  const useSessions = props.useSessions as SessionsHook | undefined;
  const current = useCurrentSession(useSessions);
  const [tab, setTab] = React.useState<PanelTab>(pendingTab ?? "skills");
  const [diagnosticsOpen, setDiagnosticsOpen] = React.useState(false);
  const [health, setHealth] = React.useState<HealthPayload | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [attention, setAttention] = React.useState<ReadonlySet<PanelTab>>(() => new Set<PanelTab>());
  const reportAttention = React.useCallback((target: PanelTab, flag: boolean): void => {
    setAttention((current) => {
      if (current.has(target) === flag) return current;
      const next = new Set(current);
      if (flag) next.add(target);
      else next.delete(target);
      return next;
    });
  }, []);
  const refresh = React.useCallback((): void => {
    setLoading(true);
    setError(undefined);
    void fetchHealth().then(
      (payload) => {
        setHealth(payload);
        setLoading(false);
      },
      (failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        setLoading(false);
      },
    );
  }, []);
  React.useEffect(() => refresh(), [refresh]);
  React.useEffect(
    () =>
      onRequestTab((next) => {
        pendingTab = undefined;
        setTab(next);
      }),
    [],
  );

  const preview = kitPreviewEnabled();
  const degrade = degradeInfo(health);
  const staleHost = hostVersionMismatch(health, HUB_VERSION);
  const tabProps: TabProps = {
    workspace: current.workspace,
    ...(current.sessionId === undefined ? {} : { sessionId: current.sessionId }),
    openTab: setTab,
    reportAttention,
  };
  const closeDiagnostics = React.useCallback((): void => setDiagnosticsOpen(false), []);
  const openDiagnostics = React.useCallback((): void => setDiagnosticsOpen(true), []);

  return (
    <div className={styles.page} data-dsh-capability-hub-view="" data-testid="capability-hub-page">
      <header className={styles.header}>
        <div className={styles.headerBar}>
          <h2 className={styles.title}>{tt("panel.title")}</h2>
          <button
            type="button"
            className={styles.infoButton}
            data-testid="capability-hub-info"
            aria-label={tt("env.open")}
            title={tt("env.title")}
            onClick={openDiagnostics}
          >
            {"\u24d8"}
          </button>
        </div>
        <TabBar active={tab} onSelect={setTab} attention={attention} />
      </header>
      <div className={styles.content}>
        {/* 升级后没重启：浏览器半已是新版本，宿主半还是旧的（新接口会 404）。 */}
        {staleHost === undefined ? null : (
          <Banner tone="warn" testId="capability-hub-stale-host">
            {tt("env.staleHost", { client: HUB_VERSION, host: staleHost })}
          </Banner>
        )}
        {/* 降级横幅：只在「某个模块降级」或「mcp 工具退回桩」时出现（UI-DESIGN §2）。 */}
        {degrade === undefined ? null : (
          <Banner
            tone="warn"
            testId="capability-hub-degraded"
            action={{
              label: tt("env.viewDetails"),
              onClick: openDiagnostics,
              testId: "capability-hub-degraded-details",
            }}
          >
            {tt("env.degraded", { modules: degradeNames(degrade, tt("env.mcpTool")).join("、") })}
          </Banner>
        )}
        {preview ? (
          <KitPreview />
        ) : (
          TABS.map((entry) => (
            <div
              key={entry.id}
              className={styles.tabPane}
              role="tabpanel"
              id={"capability-hub-panel-" + entry.id}
              aria-labelledby={"capability-hub-tab-" + entry.id}
              hidden={tab !== entry.id}
              data-testid={"capability-hub-panel-" + entry.id}
            >
              <TabBody tab={entry.id} props={tabProps} />
            </div>
          ))
        )}
        <Modal
          open={diagnosticsOpen}
          onClose={closeDiagnostics}
          title={tt("env.title")}
          closeLabel={tt("action.close")}
          className={styles.diagModal}
          contentClassName={styles.diagContent}
          footer={
            <Button variant="outline" data-testid="capability-hub-refresh" onClick={refresh}>
              {tt("action.refresh")}
            </Button>
          }
        >
          <DiagnosticsBody health={health} error={error} loading={loading} workspace={current.workspace} />
        </Modal>
      </div>
    </div>
  );
}
