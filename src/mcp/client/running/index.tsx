/**
 * MCP 页底部的「运行中」区域（D-E1 / UI-DESIGN §3，0.3.0 起不再是独立标签）。
 *
 * 内容 = 按会话分组的实例：子代理会话缩进挂在父会话下；「只看当前会话」；实例行悬停「断开」。
 * 服务器级的「刷新缓存」「断开全部」在服务器详情抽屉里（mcp/detail.tsx），这里不再有服务器分组。
 *
 * 没有活跃实例时整块只是一行淡色小字「运行中：没有活跃实例」，有实例时才是可折叠的面板。
 * 折叠（region.ts）：没有活跃实例时自动收起、有实例时默认展开；用户手动折叠 / 展开后尊重用户，
 * 直到实例数在 0 与非 0 之间跃迁。标题行显示实例数，展开时右侧有「只看当前会话」与刷新。
 *
 * 数据：读 MCP 页的运行状态仓库（../runtime-store.ts）——轮询、刷新、断开后的重读都在仓库里，
 * 与服务器行、详情抽屉、标签红点是同一份快照。
 * 预览：URL 带 ?hubPreviewRunning=1 时仓库用示例会话（走查不新建会话，测试 profile 里没有实例），
 * 标题行标「预览数据」，断开不调用接口。
 */

import * as React from "react";
import { Switch, Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, Banner, ListGroup, ListRow, RefreshIcon, SkeletonRows, useStoreState } from "../../../kit/index.ts";
import type { RuntimeStore } from "../runtime-store.ts";
import { DisconnectDialog, type DisconnectTarget } from "./dialogs.tsx";
import {
  filterSessions,
  instanceSubtitleText,
  instanceTone,
  sessionGroups,
  sessionIdText,
  sessionTitleText,
  sortSessions,
} from "./model.ts";
import {
  RUNNING_REGION_INITIAL,
  runningInstanceCount,
  runningRegionExpanded,
  runningRegionNext,
  runningRegionToggle,
  type RunningRegionState,
} from "./region.ts";
import { injectRuntimeStyles, styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { RuntimeInstanceView, RuntimeSessionView } from "../../contract/runtime.ts";
import { errorText } from "../../../shared/error-text.ts";

/* 样式只注入一次（模块加载时；无 document 时自动跳过）。 */
injectRuntimeStyles();

interface ToastState {
  seq: number;
  text: string;
  tone?: "success";
}

export interface RunningSectionProps {
  /** MCP 页的运行状态仓库（轮询由 MCP 页启动）。 */
  store: RuntimeStore;
  /** 当前会话 id（「只看当前会话」用）。 */
  sessionId?: string;
  /** 仓库用的是示例会话（?hubPreviewRunning=1）：标「预览数据」，断开不调用接口。 */
  preview?: boolean;
}

/** 渲染异常兜底：区域崩了也只影响这一块。 */
class SectionErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = {};
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: errorText(error) };
  }

  render(): React.ReactNode {
    if (this.state.error !== undefined) {
      return (
        <div className={styles.root} data-testid="running-crash">
          <p className={styles.failure}>{t("runtime.crash.title")}</p>
          <p className={styles.note}>{t("runtime.crash.hint", { message: this.state.error })}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

function RunningSectionInner(props: RunningSectionProps): React.ReactElement {
  const preview = props.preview === true;
  const { status, error, pollError } = useStoreState(props.store.state);
  const [onlyCurrent, setOnlyCurrent] = React.useState<boolean>(false);
  const [busy, setBusy] = React.useState<boolean>(false);
  const [pending, setPending] = React.useState<DisconnectTarget | undefined>(undefined);
  const [toast, setToast] = React.useState<ToastState | undefined>(undefined);
  const [region, setRegion] = React.useState<RunningRegionState>(RUNNING_REGION_INITIAL);
  const seq = React.useRef<number>(0);

  const showToast = React.useCallback((text: string, tone?: "success"): void => {
    seq.current += 1;
    setToast({ seq: seq.current, text, ...(tone === undefined ? {} : { tone }) });
  }, []);

  const reload = (): void => void props.store.reload(false);

  const count = runningInstanceCount(status);
  React.useEffect(() => setRegion((prev) => runningRegionNext(prev, count)), [count]);
  const expanded = runningRegionExpanded(region);

  const allSessions = sortSessions(status?.sessions ?? []);
  const sessions = sortSessions(filterSessions(allSessions, onlyCurrent, props.sessionId));

  const confirmDisconnect = (target: DisconnectTarget): void => {
    if (preview) {
      setPending(undefined);
      showToast(t("running.previewNoop"));
      return;
    }
    setBusy(true);
    void props.store
      .disconnect(target.name, target.sessionId)
      .then(
        (result) => {
          setPending(undefined);
          if (result.closed === 0) showToast(t("runtime.instance.disconnectNone"));
          else showToast(t("runtime.instance.disconnectOk"), "success");
        },
        (failure: unknown) => {
          setPending(undefined);
          showToast(t("runtime.instance.disconnectFailed", { message: errorText(failure) }));
        },
      )
      .finally(() => setBusy(false));
  };

  const instanceRow = (session: RuntimeSessionView, instance: RuntimeInstanceView): React.ReactElement => (
    <ListRow
      key={session.sessionId + ":" + instance.server}
      testId={"running-instance-" + session.sessionId + "-" + instance.server}
      title={instance.server}
      subtitle={instanceSubtitleText(instance)}
      leading={instanceTone(instance.state)}
      hoverActions={[
        {
          label: t("runtime.instance.disconnect"),
          testId: "running-instance-disconnect-" + session.sessionId + "-" + instance.server,
          onClick: () => setPending({ name: instance.server, sessionId: session.sessionId }),
        },
      ]}
    />
  );

  const sessionGroup = (session: RuntimeSessionView, child: boolean): React.ReactElement => {
    const group = (
      <ListGroup
        key={session.sessionId}
        depth={1}
        testId={"running-session-" + session.sessionId}
        title={sessionTitleText(session)}
        meta={sessionIdText(session)}
        count={session.instances.length}
        badges={child ? <Badge tone="neutral">{t("runtime.session.child")}</Badge> : undefined}
      >
        {session.instances.map((instance) => instanceRow(session, instance))}
      </ListGroup>
    );
    return child ? (
      <div key={session.sessionId} className={styles.subGroup}>
        {group}
      </div>
    ) : (
      group
    );
  };

  const content = ((): React.ReactNode => {
    if (error !== undefined && status === undefined) {
      return (
        <div className={styles.pad}>
          <Banner
            tone="danger"
            testId="running-load-error"
            action={{ label: t("runtime.retry"), onClick: reload, testId: "running-retry" }}
          >
            {t("runtime.loadFailed", { message: error })}
          </Banner>
        </div>
      );
    }
    if (status === undefined) return <SkeletonRows testId="running-loading" rows={2} />;
    const nodes: React.ReactNode[] = [];
    if (pollError !== undefined) {
      nodes.push(
        <div key="poll" className={styles.pad}>
          <Banner tone="warn" testId="running-poll-error">
            {t("runtime.pollFailed", { message: pollError })}
          </Banner>
        </div>,
      );
    }
    if (sessions.length === 0) {
      nodes.push(
        <p key="empty" className={styles.empty} data-testid="running-empty">
          {allSessions.length > 0 ? t("runtime.sessions.filteredEmpty") : t("runtime.sessions.empty")}
        </p>,
      );
    } else {
      for (const group of sessionGroups(sessions)) {
        nodes.push(sessionGroup(group.parent, false));
        for (const child of group.children) nodes.push(sessionGroup(child, true));
      }
    }
    return nodes;
  })();

  const headEnd = expanded ? (
    <React.Fragment>
      <span className={styles.switch} data-testid="running-only-current">
        <Switch
          checked={onlyCurrent}
          disabled={props.sessionId === undefined}
          label={t("runtime.onlyCurrent")}
          {...(props.sessionId === undefined ? { title: t("runtime.onlyCurrentOff") } : {})}
          onChange={(next: boolean) => setOnlyCurrent(next)}
        />
        <button
          type="button"
          className={styles.switchLabel}
          data-testid="running-only-current-label"
          disabled={props.sessionId === undefined}
          {...(props.sessionId === undefined ? { title: t("runtime.onlyCurrentOff") } : {})}
          onClick={() => setOnlyCurrent((prev) => !prev)}
        >
          {t("runtime.onlyCurrent")}
        </button>
      </span>
      <button
        type="button"
        className={styles.iconButton}
        data-testid="running-refresh"
        aria-label={t("runtime.refresh")}
        title={t("runtime.pollHint")}
        onClick={reload}
      >
        <RefreshIcon />
      </button>
    </React.Fragment>
  ) : undefined;

  // 没有活跃实例（且没有报错）时只是一行淡色小字，有实例时才变成可折叠的面板（UI-DESIGN 原则 3）。
  const quiet = status !== undefined && count === 0 && error === undefined && pollError === undefined && !preview;
  return (
    <div className={styles.region} data-testid="mcp-running" data-dsh-part="mcp-running">
      {status === undefined && error === undefined ? null : quiet ? (
        <p className={styles.quiet} title={t("runtime.pollHint")} data-testid="running-quiet">
          {t("running.quiet")}
        </p>
      ) : (
        <ListGroup
          title={t("running.title")}
          count={count > 0 ? t("running.count", { count }) : t("running.none")}
          badges={preview ? <Badge tone="neutral">{t("running.preview")}</Badge> : undefined}
          expanded={expanded}
          onToggle={() => setRegion((prev) => runningRegionToggle(prev))}
          nested
          end={headEnd}
          testId="running-group"
        >
          {content}
        </ListGroup>
      )}
      <DisconnectDialog
        target={pending}
        busy={busy}
        onConfirm={confirmDisconnect}
        onCancel={() => setPending(undefined)}
      />
      {toast === undefined ? null : (
        <Toast
          key={toast.seq}
          text={toast.text}
          {...(toast.tone === undefined ? {} : { tone: toast.tone })}
          holdMs={4000}
          onDone={() =>
            setToast((current) => (current !== undefined && current.seq === toast.seq ? undefined : current))
          }
        />
      )}
    </div>
  );
}

/** 「运行中」区域（对外只导出这一个）。 */
export function RunningSection(props: RunningSectionProps): React.ReactElement {
  return (
    <SectionErrorBoundary>
      <RunningSectionInner {...props} />
    </SectionErrorBoundary>
  );
}
