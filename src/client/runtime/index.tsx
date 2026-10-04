/**
 * MCP 页底部的「运行中」区域（D-E1 / UI-DESIGN §3，0.3.0 起不再是独立标签）。
 *
 * 内容 = 按会话分组的实例：子代理会话缩进挂在父会话下；「只看当前会话」；实例行悬停「断开」。
 * 服务器级的「刷新缓存」「断开全部」在服务器详情抽屉里（mcp/detail.tsx），这里不再有服务器分组。
 *
 * 折叠（region.ts）：没有活跃实例时自动收起、有实例时默认展开；用户手动折叠 / 展开后尊重用户，
 * 直到实例数在 0 与非 0 之间跃迁。标题行显示实例数，展开时右侧有「只看当前会话」与刷新。
 *
 * 刷新：每 5 秒轮询一次（页面不可见时跳过）；reloadSignal 变化时立即刷新（MCP 页在抽屉里断开后通知）。
 * 预览：URL 带 ?hubPreviewRunning=1 时用 region.ts 的示例数据（走查不新建会话，测试 profile 里没有实例），
 * 标题行标「预览数据」，断开不调用接口。
 */

import * as React from "react";
import { Switch, Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, Banner, ListGroup, ListRow, RefreshIcon, SkeletonRows } from "../shell/kit/index.ts";
import { disconnectServer, fetchRuntimeStatus } from "./data.ts";
import { DisconnectDialog, type DisconnectTarget } from "./dialogs.tsx";
import {
  POLL_INTERVAL_MS,
  errorMessage,
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
  runningPreviewStatus,
  runningRegionExpanded,
  runningRegionNext,
  runningRegionToggle,
  type RunningRegionState,
} from "./region.ts";
import { injectRuntimeStyles, styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { RuntimeInstanceView, RuntimeSessionView, RuntimeStatus } from "./types.ts";

/* 样式只注入一次（模块加载时；无 document 时自动跳过）。 */
injectRuntimeStyles();

interface ToastState {
  seq: number;
  text: string;
  tone?: "success";
}

export interface RunningSectionProps {
  /** 当前会话 id（「只看当前会话」用）。 */
  sessionId?: string;
  /** 用示例数据渲染（?hubPreviewRunning=1）。 */
  preview?: boolean;
  /** 变化时立即刷新一次（MCP 页在抽屉里断开实例后递增）。 */
  reloadSignal?: number;
}

/** 渲染异常兜底：区域崩了也只影响这一块。 */
class SectionErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = {};
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: errorMessage(error) };
  }

  render(): React.ReactNode {
    if (this.state.error !== undefined) {
      return React.createElement("div", { className: styles.root, "data-testid": "running-crash" },
        React.createElement("p", { className: styles.failure }, t("runtime.crash.title")),
        React.createElement("p", { className: styles.note }, t("runtime.crash.hint", { message: this.state.error })));
    }
    return this.props.children;
  }
}

function RunningSectionInner(props: RunningSectionProps): React.ReactElement {
  const preview = props.preview === true;
  const [status, setStatus] = React.useState<RuntimeStatus | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [pollError, setPollError] = React.useState<string | undefined>(undefined);
  const [onlyCurrent, setOnlyCurrent] = React.useState<boolean>(false);
  const [busy, setBusy] = React.useState<boolean>(false);
  const [pending, setPending] = React.useState<DisconnectTarget | undefined>(undefined);
  const [toast, setToast] = React.useState<ToastState | undefined>(undefined);
  const [region, setRegion] = React.useState<RunningRegionState>(RUNNING_REGION_INITIAL);
  const seq = React.useRef<number>(0);
  const hasData = React.useRef<boolean>(false);

  const showToast = React.useCallback((text: string, tone?: "success"): void => {
    seq.current += 1;
    setToast({ seq: seq.current, text, ...(tone === undefined ? {} : { tone }) });
  }, []);

  const load = React.useCallback((silent: boolean): void => {
    if (preview) {
      hasData.current = true;
      setStatus(runningPreviewStatus(Date.now()));
      return;
    }
    if (!silent) setError(undefined);
    void fetchRuntimeStatus().then(
      (payload) => {
        hasData.current = true;
        setStatus(payload);
        setError(undefined);
        setPollError(undefined);
      },
      (failure: unknown) => {
        // 自动刷新失败时保留上一次的数据，只加一行提示
        if (silent && hasData.current) setPollError(errorMessage(failure));
        else setError(errorMessage(failure));
      },
    );
  }, [preview]);

  React.useEffect(() => load(false), [load, props.reloadSignal]);

  /** 5 秒轮询：组件卸载即停，页面不可见时跳过这一轮；预览数据不轮询。 */
  React.useEffect(() => {
    if (preview) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      load(true);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load, preview]);

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
    void disconnectServer(target.name, target.sessionId).then(
      (result) => {
        setPending(undefined);
        if (result.closed === 0) showToast(t("runtime.instance.disconnectNone"));
        else showToast(t("runtime.instance.disconnectOk"), "success");
        load(true);
      },
      (failure: unknown) => {
        setPending(undefined);
        showToast(t("runtime.instance.disconnectFailed", { message: errorMessage(failure) }));
      },
    ).finally(() => setBusy(false));
  };

  const instanceRow = (session: RuntimeSessionView, instance: RuntimeInstanceView): React.ReactElement =>
    React.createElement(ListRow, {
      key: session.sessionId + ":" + instance.server,
      testId: "running-instance-" + session.sessionId + "-" + instance.server,
      title: instance.server,
      subtitle: instanceSubtitleText(instance),
      leading: instanceTone(instance.state),
      hoverActions: [{
        label: t("runtime.instance.disconnect"),
        testId: "running-instance-disconnect-" + session.sessionId + "-" + instance.server,
        onClick: () => setPending({ name: instance.server, sessionId: session.sessionId }),
      }],
    });

  const sessionGroup = (session: RuntimeSessionView, child: boolean): React.ReactElement => {
    const group = React.createElement(ListGroup, {
      key: session.sessionId,
      depth: 1,
      testId: "running-session-" + session.sessionId,
      title: sessionTitleText(session),
      meta: sessionIdText(session),
      count: session.instances.length,
      badges: child
        ? React.createElement(Badge, { tone: "neutral" }, t("runtime.session.child"))
        : undefined,
    },
    session.instances.map((instance) => instanceRow(session, instance)));
    return child
      ? React.createElement("div", { key: session.sessionId, className: styles.subGroup }, group)
      : group;
  };

  const content = ((): React.ReactNode => {
    if (error !== undefined && status === undefined) {
      return React.createElement("div", { className: styles.pad },
        React.createElement(Banner, {
          tone: "danger",
          testId: "running-load-error",
          action: { label: t("runtime.retry"), onClick: () => load(false), testId: "running-retry" },
        }, t("runtime.loadFailed", { message: error })));
    }
    if (status === undefined) return React.createElement(SkeletonRows, { testId: "running-loading", rows: 2 });
    const nodes: React.ReactNode[] = [];
    if (pollError !== undefined) {
      nodes.push(React.createElement("div", { key: "poll", className: styles.pad },
        React.createElement(Banner, { tone: "warn", testId: "running-poll-error" }, t("runtime.pollFailed", { message: pollError }))));
    }
    if (sessions.length === 0) {
      nodes.push(React.createElement("p", { key: "empty", className: styles.empty, "data-testid": "running-empty" },
        allSessions.length > 0 ? t("runtime.sessions.filteredEmpty") : t("runtime.sessions.empty")));
    } else {
      for (const group of sessionGroups(sessions)) {
        nodes.push(sessionGroup(group.parent, false));
        for (const child of group.children) nodes.push(sessionGroup(child, true));
      }
    }
    return nodes;
  })();

  const headEnd = expanded
    ? React.createElement(React.Fragment, null,
        React.createElement("span", { className: styles.switch, "data-testid": "running-only-current" },
          React.createElement(Switch, {
            checked: onlyCurrent,
            disabled: props.sessionId === undefined,
            label: t("runtime.onlyCurrent"),
            ...(props.sessionId === undefined ? { title: t("runtime.onlyCurrentOff") } : {}),
            onChange: (next: boolean) => setOnlyCurrent(next),
          }),
          React.createElement("button", {
            type: "button",
            className: styles.switchLabel,
            "data-testid": "running-only-current-label",
            disabled: props.sessionId === undefined,
            ...(props.sessionId === undefined ? { title: t("runtime.onlyCurrentOff") } : {}),
            onClick: () => setOnlyCurrent((prev) => !prev),
          }, t("runtime.onlyCurrent"))),
        React.createElement("button", {
          type: "button",
          className: styles.iconButton,
          "data-testid": "running-refresh",
          "aria-label": t("runtime.refresh"),
          title: t("runtime.pollHint"),
          onClick: () => load(false),
        }, React.createElement(RefreshIcon, null)))
    : undefined;

  return React.createElement("div", { className: styles.region, "data-testid": "mcp-running", "data-dsh-part": "mcp-running" },
    React.createElement(ListGroup, {
      title: t("running.title"),
      count: count > 0 ? t("running.count", { count }) : t("running.none"),
      badges: preview ? React.createElement(Badge, { tone: "neutral" }, t("running.preview")) : undefined,
      expanded,
      onToggle: () => setRegion((prev) => runningRegionToggle(prev)),
      nested: true,
      end: headEnd,
      testId: "running-group",
    }, content),

    React.createElement(DisconnectDialog, {
      target: pending,
      busy,
      onConfirm: confirmDisconnect,
      onCancel: () => setPending(undefined),
    }),
    toast === undefined
      ? null
      : React.createElement(Toast, {
          key: toast.seq,
          text: toast.text,
          ...(toast.tone === undefined ? {} : { tone: toast.tone }),
          holdMs: 4000,
          onDone: () => setToast((current) => (current !== undefined && current.seq === toast.seq ? undefined : current)),
        }));
}

/** 「运行中」区域（对外只导出这一个）。 */
export function RunningSection(props: RunningSectionProps): React.ReactElement {
  return React.createElement(SectionErrorBoundary, null, React.createElement(RunningSectionInner, props));
}
