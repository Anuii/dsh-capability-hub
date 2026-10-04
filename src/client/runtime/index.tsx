/**
 * 运行态标签页（D-E1 / UI-DESIGN §6）：工具栏 + 服务器分组 + 会话分组，全部来自 GET mcp/runtime。
 *
 * 页面自上而下只有两样常驻元素：**工具栏**与**列表**（页头与标签由外壳提供）。
 *   - 服务器行：状态点 + 名称 +「缓存 4 个工具 · 更新于 23:50 · 2 个活跃实例」；有失败时副标题
 *     换成红色的失败信息，冷却中挂「冷却 47s」标记；悬停才出现「刷新缓存」「断开全部」；
 *     点行打开抽屉看完整失败信息、缓存与实例。
 *   - 会话：每个会话一个分组（标题 + 等宽完整 id），子代理会话缩进显示并带「子代理」标记；
 *     实例行 = 状态点 + 服务器名 +「就绪 · PID 35984 · 启动 23:51 · 最近使用 23:51」，悬停「断开」。
 *
 * 刷新节奏（不变）：标签可见时每 5 秒自动刷新一次（组件卸载即停；document.hidden 时跳过这一轮），
 * 另有工具栏右侧的手动刷新图标。倒计时用本地 1 秒 tick，不再打接口。
 *
 * 决策落点：D-E1、D-C6（保存后的后台探测结果在这里可见）、D-D3（会话隔离：子代理会话各自一套实例）。
 */

import * as React from "react";
import { Switch, Toast } from "@deepseek-ai/dsh-client-ui-primitives";
import type { TabProps } from "../shell/tab-props.ts";
import { Badge, Banner, Drawer, ListGroup, ListRow, ListSurface, RefreshIcon, Section, SkeletonRows, Toolbar } from "../shell/kit/index.ts";
import { disconnectServer, fetchRuntimeStatus, refreshServer } from "./data.ts";
import { DisconnectDialog, type DisconnectTarget } from "./dialogs.tsx";
import {
  POLL_INTERVAL_MS,
  cacheDetailText,
  cooldownBadgeText,
  cooldownText,
  errorMessage,
  failureText,
  filterSessions,
  instanceSubtitleText,
  instanceTone,
  serverInstanceCounts,
  serverRowTone,
  serverSubtitleText,
  serverSubtitleTone,
  sessionGroups,
  sessionIdText,
  sessionTitleText,
  shortSessionId,
  sortSessions,
} from "./model.ts";
import { injectRuntimeStyles, styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { RuntimeInstanceView, RuntimeServerView, RuntimeSessionView, RuntimeStatus } from "./types.ts";

/* 样式只注入一次（模块加载时；无 document 时自动跳过）。 */
injectRuntimeStyles();

interface ToastState {
  seq: number;
  text: string;
  tone?: "success";
}

function busyKey(kind: string, name: string, sessionId?: string): string {
  return sessionId === undefined ? kind + ":" + name : kind + ":" + name + ":" + sessionId;
}

/** 渲染异常兜底：运行态页崩了也只影响这一块。 */
class TabErrorBoundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = {};
  }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: errorMessage(error) };
  }

  render(): React.ReactNode {
    if (this.state.error !== undefined) {
      return React.createElement("div", { className: styles.root, "data-testid": "runtime-crash" },
        React.createElement("p", { className: styles.failure }, t("runtime.crash.title")),
        React.createElement("p", { className: styles.note }, t("runtime.crash.hint", { message: this.state.error })));
    }
    return this.props.children;
  }
}

function RuntimeTabInner(props: TabProps): React.ReactElement {
  const [status, setStatus] = React.useState<RuntimeStatus | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [pollError, setPollError] = React.useState<string | undefined>(undefined);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [now, setNow] = React.useState<number>(() => Date.now());
  const [onlyCurrent, setOnlyCurrent] = React.useState<boolean>(false);
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const [pending, setPending] = React.useState<DisconnectTarget | undefined>(undefined);
  const [detail, setDetail] = React.useState<string | undefined>(undefined);
  const [toast, setToast] = React.useState<ToastState | undefined>(undefined);
  const seq = React.useRef<number>(0);
  const hasData = React.useRef<boolean>(false);

  const showToast = React.useCallback((text: string, tone?: "success"): void => {
    seq.current += 1;
    setToast({ seq: seq.current, text, ...(tone === undefined ? {} : { tone }) });
  }, []);

  const load = React.useCallback((silent: boolean): void => {
    if (!silent) {
      setLoading(true);
      setError(undefined);
    }
    void fetchRuntimeStatus().then(
      (payload) => {
        hasData.current = true;
        setStatus(payload);
        setNow(Date.now());
        setLoading(false);
        setPollError(undefined);
      },
      (failure: unknown) => {
        setLoading(false);
        // 自动刷新失败时保留上一次的数据，只加一行提示，避免把整页打成错误态
        if (silent && hasData.current) setPollError(errorMessage(failure));
        else setError(errorMessage(failure));
      },
    );
  }, []);

  React.useEffect(() => load(false), [load]);

  /** 5 秒轮询：组件卸载即停（切标签会卸载本组件），页面不可见时跳过这一轮。 */
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      load(true);
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [load]);

  const servers = status?.servers ?? [];
  const allSessions = sortSessions(status?.sessions ?? []);
  const sessions = sortSessions(filterSessions(allSessions, onlyCurrent, props.sessionId));
  const counts = serverInstanceCounts(allSessions);

  /** 冷却倒计时用的本地时钟：只在真的有冷却或抽屉开着时走。 */
  const cooling = servers.some((server) => cooldownText(server.lastFailure, now) !== undefined);
  React.useEffect(() => {
    if (!cooling && detail === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cooling, detail]);

  const markBusy = (key: string, value: boolean): void => {
    setBusy((current) => {
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const onRefresh = (server: RuntimeServerView): void => {
    markBusy(busyKey("refresh", server.name), true);
    void refreshServer(server.name).then(
      (result) => {
        showToast(t("runtime.row.refreshOk", { name: server.name, count: result.toolCount }), "success");
        load(true);
      },
      (failure: unknown) => showToast(t("runtime.row.refreshFailed", { name: server.name, message: errorMessage(failure) })),
    ).finally(() => markBusy(busyKey("refresh", server.name), false));
  };

  const confirmDisconnect = (target: DisconnectTarget): void => {
    const key = busyKey("disconnect", target.name, target.sessionId);
    markBusy(key, true);
    void disconnectServer(target.name, target.sessionId).then(
      (result) => {
        setPending(undefined);
        if (result.closed === 0) {
          showToast(target.sessionId === undefined
            ? t("runtime.row.disconnectNone", { name: target.name })
            : t("runtime.instance.disconnectNone"));
        } else {
          showToast(target.sessionId === undefined
            ? t("runtime.row.disconnectOk", { name: target.name, count: result.closed })
            : t("runtime.instance.disconnectOk"), "success");
        }
        load(true);
      },
      (failure: unknown) => {
        setPending(undefined);
        showToast(target.sessionId === undefined
          ? t("runtime.row.disconnectFailed", { name: target.name, message: errorMessage(failure) })
          : t("runtime.instance.disconnectFailed", { message: errorMessage(failure) }));
      },
    ).finally(() => markBusy(key, false));
  };

  const serverRows = servers.map((server) => {
    const instances = counts[server.name] ?? 0;
    const badge = cooldownBadgeText(server.lastFailure, now);
    return React.createElement(ListRow, {
      key: server.name,
      testId: "runtime-row-" + server.name,
      title: server.name,
      subtitle: serverSubtitleText(server, instances),
      subtitleTone: serverSubtitleTone(server),
      leading: serverRowTone(server, instances, now),
      badges: badge === undefined
        ? []
        : [React.createElement(Badge, { key: "cooling", tone: "warn", testId: "runtime-badge-cooldown-" + server.name }, badge)],
      hoverActions: [
        {
          label: t("runtime.row.refresh"),
          testId: "runtime-refresh-" + server.name,
          onClick: () => onRefresh(server),
        },
        {
          label: t("runtime.row.disconnect"),
          testId: "runtime-disconnect-" + server.name,
          onClick: () => setPending({ name: server.name }),
        },
      ],
      onOpen: () => setDetail(server.name),
    });
  });

  const instanceRow = (session: RuntimeSessionView, instance: RuntimeInstanceView): React.ReactElement =>
    React.createElement(ListRow, {
      key: session.sessionId + ":" + instance.server,
      testId: "runtime-instance-" + session.sessionId + "-" + instance.server,
      title: instance.server,
      subtitle: instanceSubtitleText(instance),
      leading: instanceTone(instance.state),
      hoverActions: [{
        label: t("runtime.instance.disconnect"),
        testId: "runtime-instance-disconnect-" + session.sessionId + "-" + instance.server,
        onClick: () => setPending({ name: instance.server, sessionId: session.sessionId }),
      }],
    });

  const sessionGroup = (session: RuntimeSessionView, child: boolean): React.ReactElement => {
    const group = React.createElement(ListGroup, {
      key: session.sessionId,
      testId: "runtime-session-" + session.sessionId,
      title: sessionTitleText(session),
      meta: sessionIdText(session),
      count: session.instances.length,
      badges: child
        ? [React.createElement(Badge, { key: "child", tone: "neutral" }, t("runtime.session.child"))]
        : undefined,
    },
    session.instances.map((instance) => instanceRow(session, instance)));
    return child
      ? React.createElement("div", { key: session.sessionId, className: styles.subGroup }, group)
      : group;
  };

  const sessionNodes = sessionGroups(sessions).flatMap((group) => [
    sessionGroup(group.parent, false),
    ...group.children.map((child) => sessionGroup(child, true)),
  ]);

  const body = ((): React.ReactElement => {
    if (error !== undefined && status === undefined) {
      return React.createElement(Banner, {
        tone: "danger",
        testId: "runtime-load-error",
        action: { label: t("runtime.retry"), onClick: () => load(false), testId: "runtime-retry" },
      }, t("runtime.loadFailed", { message: error }));
    }
    if (status === undefined || loading) {
      return React.createElement(SkeletonRows, { testId: "runtime-loading" });
    }
    return React.createElement(ListSurface, { testId: "runtime-surface" },
      React.createElement(ListGroup, {
        title: t("runtime.servers.title"),
        count: servers.length,
        testId: "runtime-servers",
      },
      servers.length === 0
        ? React.createElement("li", { className: styles.note, "data-testid": "runtime-servers-empty" }, t("runtime.servers.empty"))
        : serverRows),
      sessions.length === 0
        ? React.createElement("p", {
            className: styles.note,
            "data-testid": "runtime-sessions-empty",
          }, allSessions.length > 0 ? t("runtime.sessions.filteredEmpty") : t("runtime.sessions.empty"))
        : sessionNodes);
  })();

  const detailServer = detail === undefined ? undefined : servers.find((server) => server.name === detail);
  const detailInstances = detail === undefined
    ? []
    : allSessions.flatMap((session) => session.instances
      .filter((instance) => instance.server === detail)
      .map((instance) => ({ session, instance })));

  return React.createElement("section", {
      className: styles.root,
      "data-testid": "capability-hub-tab-panel-runtime",
      "data-dsh-part": "runtime-tab",
    },
    React.createElement(Toolbar, {
      testId: "runtime-toolbar",
      start: React.createElement("span", { className: styles.switch, "data-testid": "runtime-only-current" },
        React.createElement(Switch, {
          checked: onlyCurrent,
          disabled: props.sessionId === undefined,
          label: t("runtime.onlyCurrent"),
          ...(props.sessionId === undefined ? { title: t("runtime.onlyCurrentOff") } : {}),
          onChange: (next: boolean) => setOnlyCurrent(next),
        }),
        // 开关右侧的文字标签（次要色）：点文字也能切换
        React.createElement("button", {
          type: "button",
          className: styles.switchLabel,
          "data-testid": "runtime-only-current-label",
          disabled: props.sessionId === undefined,
          ...(props.sessionId === undefined ? { title: t("runtime.onlyCurrentOff") } : {}),
          onClick: () => setOnlyCurrent((prev) => !prev),
        }, t("runtime.onlyCurrent"))),
      end: React.createElement(React.Fragment, null,
        React.createElement("span", { className: styles.autoRefresh, title: t("runtime.pollHint") }, t("runtime.autoRefresh")),
        React.createElement("button", {
          type: "button",
          className: styles.iconButton,
          "data-testid": "runtime-refresh-all",
          "aria-label": t("runtime.refresh"),
          title: t("runtime.pollHint"),
          disabled: loading,
          onClick: () => load(false),
        }, React.createElement(RefreshIcon, null))),
    }),
    pollError === undefined
      ? null
      : React.createElement(Banner, { tone: "warn", testId: "runtime-poll-error" }, t("runtime.pollFailed", { message: pollError })),
    body,

    React.createElement(Drawer, {
      open: detailServer !== undefined,
      title: detailServer?.name ?? "",
      subtitle: detailServer === undefined ? undefined : cacheDetailText(detailServer),
      testId: "runtime-drawer",
      onClose: () => setDetail(undefined),
    },
    detailServer === undefined
      ? null
      : React.createElement(React.Fragment, null,
          detailServer.lastFailure === undefined
            ? null
            : React.createElement(Section, { title: t("runtime.drawer.failureTitle"), testId: "runtime-drawer-failure" },
                React.createElement("p", { className: styles.failure, "data-testid": "runtime-drawer-failure-message" }, failureText(detailServer.lastFailure)),
                cooldownText(detailServer.lastFailure, now) === undefined
                  ? null
                  : React.createElement("p", { className: styles.cooldown, "data-testid": "runtime-drawer-failure-cooldown" },
                      cooldownText(detailServer.lastFailure, now))),
          React.createElement(Section, { title: t("runtime.drawer.cacheTitle"), testId: "runtime-drawer-cache" },
            React.createElement("p", { className: styles.note, "data-testid": "runtime-drawer-cache-text" }, cacheDetailText(detailServer))),
          React.createElement(Section, { title: t("runtime.drawer.instancesTitle"), testId: "runtime-drawer-instances" },
            detailInstances.length === 0
              ? React.createElement("p", { className: styles.note, "data-testid": "runtime-drawer-no-instances" }, t("runtime.drawer.noInstances"))
              : React.createElement("div", { className: styles.stack, "data-testid": "runtime-drawer-instance-list" },
                  detailInstances.map((entry) => React.createElement("p", {
                    key: entry.session.sessionId + ":" + String(entry.instance.pid ?? entry.instance.startedAt),
                    className: styles.note,
                  }, t("runtime.drawer.session", { id: shortSessionId(entry.session.sessionId) }) + " · " + instanceSubtitleText(entry.instance))))))),

    React.createElement(DisconnectDialog, {
      target: pending,
      busy: pending !== undefined && busy.has(busyKey("disconnect", pending.name, pending.sessionId)),
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

/** 运行态标签页（对外只导出这一个）。 */
export function RuntimeTab(props: TabProps): React.ReactElement {
  return React.createElement(TabErrorBoundary, null, React.createElement(RuntimeTabInner, props));
}
