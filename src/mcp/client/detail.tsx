/**
 * MCP 服务器详情抽屉的正文（UI-DESIGN §5）：概览 → 工具 → 环境变量与请求头 → 最近失败。
 *
 * 两条纪律：
 *   - **遮罩**（D-C5）：env / headers 的值默认就是 ***hidden***，只有用户显式点「显示」
 *     才向服务端要一次明文，明文只存在本次抽屉的组件状态里；
 *   - **只在需要时出现**：最近失败小节只有真的有失败记录时才渲染，冷却倒计时只在冷却未结束时出现。
 */

import * as React from "react";
import { revealServer } from "./data.ts";
import {
  cacheLineText,
  cachedToolNames,
  cooldownRemainingMs,
  errorMessage,
  formatTimestamp,
  formatDuration,
  lifecycleLabel,
  transportLabel,
  viewSummaryText,
} from "./model.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { KeyValue, Section } from "../../kit/index.ts";
import type { RuntimeServerView } from "../contract/runtime.ts";
import type { ServerView } from "../contract/config.ts";

export interface ServerDetailBodyProps {
  view: ServerView;
  row: RuntimeServerView | undefined;
  /** 冷却倒计时用的当前时间（外壳每秒推进）。 */
  now: number;
  refreshing: boolean;
  onRefresh(): void;
  /** 该服务器在全部会话里的活跃实例数（0 时不显示「运行中的实例」一节）。 */
  instances: number;
  /** 「断开全部实例」：由 MCP 页弹确认框（0.3.0 从运行态标签移入，D-E1）。 */
  onDisconnectAll(): void;
  showToast(text: string, tone?: "success"): void;
}

/** 敏感值清单（env / headers）：遮罩值 + 「显示」。 */
function SecretBlock(props: {
  label: string;
  field: "env" | "headers";
  entries: Record<string, string>;
  plain: Record<string, string> | undefined;
  busy: boolean;
  onReveal(): void;
}): React.ReactElement {
  const keys = Object.keys(props.entries);
  return React.createElement("div", { className: styles.stack, "data-testid": "mcp-detail-" + props.field },
    // 小标题左、动作右（与 Section 的 end 区同一风格）
    React.createElement("div", { className: styles.secretHead },
      React.createElement("span", { className: styles.fieldLabel }, props.label),
      React.createElement("span", { className: styles.spacer }),
      keys.length === 0
        ? null
        : React.createElement("button", {
            type: "button",
            className: styles.textButton,
            "data-testid": "mcp-detail-reveal-" + props.field,
            disabled: props.busy,
            title: t("mcp.detail.revealTitle"),
            onClick: props.onReveal,
          }, props.busy
            ? t("mcp.detail.revealing")
            : props.plain === undefined ? t("mcp.detail.show") : t("mcp.detail.hide"))),
    keys.length === 0
      ? React.createElement("p", { className: styles.muted, "data-testid": "mcp-detail-" + props.field + "-empty" }, t("mcp.detail.none"))
      : React.createElement("div", { className: styles.secretGrid },
          keys.flatMap((key) => {
            const masked = props.plain === undefined;
            const value = masked ? props.entries[key] : props.plain?.[key] ?? props.entries[key];
            return [
              React.createElement("span", { key: key + "-k", className: styles.secretKey, title: key }, key),
              React.createElement("span", {
                key: key + "-v",
                className: masked ? styles.secretValue + " " + styles.valueMasked : styles.secretValue,
                title: masked ? t("mcp.detail.masked") : undefined,
                "data-testid": "mcp-detail-secret-" + props.field + "-" + key,
              }, value),
            ];
          })));
}

export function ServerDetailBody(props: ServerDetailBodyProps): React.ReactElement {
  const view = props.view;
  const row = props.row;
  const [plain, setPlain] = React.useState<Record<string, Record<string, string>>>({});
  const [revealing, setRevealing] = React.useState<string | undefined>(undefined);
  const [revealError, setRevealError] = React.useState<string | undefined>(undefined);
  const name = view.serverName;

  React.useEffect(() => {
    setPlain({});
    setRevealError(undefined);
  }, [name]);

  const reveal = (field: "env" | "headers"): void => {
    setRevealing(field);
    setRevealError(undefined);
    void revealServer(name).then(
      (full) => {
        setPlain((current) => ({ ...current, [field]: field === "env" ? full.env : full.headers }));
        props.showToast(t("mcp.toast.revealed"));
      },
      (failure: unknown) => setRevealError(t("mcp.detail.revealFailed", { message: errorMessage(failure) })),
    ).finally(() => setRevealing(undefined));
  };

  const togglePlain = (field: "env" | "headers"): void => {
    if (plain[field] !== undefined) {
      setPlain((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
      return;
    }
    reveal(field);
  };

  const meta = view.meta ?? {};
  const overview = [
    { label: t("mcp.detail.transport"), value: transportLabel(view.transport), testId: "mcp-detail-transport" },
    view.transport === "streamable-http"
      ? { label: t("mcp.detail.url"), value: view.url ?? t("mcp.detail.none"), mono: true, title: view.url, testId: "mcp-detail-url" }
      : { label: t("mcp.detail.command"), value: viewSummaryText(view), mono: true, title: viewSummaryText(view), testId: "mcp-detail-command" },
    ...(view.cwd === undefined || view.cwd === ""
      ? []
      : [{ label: t("mcp.detail.cwd"), value: view.cwd, mono: true, testId: "mcp-detail-cwd" }]),
    { label: t("mcp.detail.lifecycle"), value: lifecycleLabel(view.lifecycle), testId: "mcp-detail-lifecycle" },
    ...(meta.description === undefined || meta.description === ""
      ? []
      : [{ label: t("mcp.detail.description"), value: meta.description, testId: "mcp-detail-description" }]),
    ...(meta.tags === undefined || meta.tags.length === 0
      ? []
      : [{ label: t("mcp.detail.tags"), value: meta.tags.join("、"), testId: "mcp-detail-tags" }]),
    ...(meta.homepage === undefined || meta.homepage === ""
      ? []
      : [{
          label: t("mcp.detail.homepage"),
          value: React.createElement("a", { href: meta.homepage, target: "_blank", rel: "noreferrer" }, meta.homepage),
          title: meta.homepage,
          testId: "mcp-detail-homepage",
        }]),
  ];

  /** 缓存一行：整行普通字体，只有时间保持等宽（复审打磨）。 */
  const cacheLine = ((): React.ReactNode => {
    const text = cacheLineText(row);
    const time = row?.cache === undefined ? "" : formatTimestamp(row.cache.updatedAt);
    const at = time === "" ? -1 : text.indexOf(time);
    if (at < 0) return text;
    return [
      text.slice(0, at),
      React.createElement("span", { key: "time", className: styles.mono }, time),
      text.slice(at + time.length),
    ];
  })();

  const tools = cachedToolNames(row);
  const failure = row?.lastFailure;
  const remaining = cooldownRemainingMs(failure, props.now);

  return React.createElement(React.Fragment, null,
    React.createElement(Section, { title: t("mcp.detail.overview"), testId: "mcp-detail-overview" },
      React.createElement(KeyValue, { items: overview, testId: "mcp-detail-overview-kv" })),

    React.createElement(Section, {
      title: t("mcp.detail.tools"),
      testId: "mcp-detail-tools",
      end: React.createElement(Button, {
        size: "sm",
        variant: "outline",
        "data-testid": "mcp-detail-refresh",
        disabled: props.refreshing || view.disabled,
        onClick: props.onRefresh,
      }, props.refreshing ? t("mcp.detail.refreshing") : t("mcp.detail.refresh")),
    },
    React.createElement("p", { className: styles.cacheLine, "data-testid": "mcp-detail-cache" }, cacheLine),
    tools.length === 0
      ? null
      : React.createElement("ul", { className: styles.toolList, "data-testid": "mcp-detail-tool-list" },
          tools.map((tool) => React.createElement("li", { key: tool, className: styles.toolItem }, tool)))),

    props.instances === 0
      ? null
      : React.createElement(Section, {
          title: t("mcp.detail.instances"),
          testId: "mcp-detail-instances",
          end: React.createElement(Button, {
            size: "sm",
            variant: "outline",
            "data-testid": "mcp-detail-disconnect-all",
            onClick: props.onDisconnectAll,
          }, t("mcp.detail.disconnectAll", { count: props.instances })),
        },
        React.createElement("p", { className: styles.cacheLine, "data-testid": "mcp-detail-instances-text" }, t("mcp.detail.instancesText", { count: props.instances }))),

    React.createElement(Section, { title: t("mcp.detail.secrets"), testId: "mcp-detail-secrets" },
      React.createElement(SecretBlock, {
        label: t("mcp.detail.env"),
        field: "env",
        entries: view.env,
        plain: plain.env,
        busy: revealing === "env",
        onReveal: () => togglePlain("env"),
      }),
      React.createElement(SecretBlock, {
        label: t("mcp.detail.headers"),
        field: "headers",
        entries: view.headers,
        plain: plain.headers,
        busy: revealing === "headers",
        onReveal: () => togglePlain("headers"),
      }),
      revealError === undefined
        ? null
        : React.createElement("p", { className: styles.fieldError, "data-testid": "mcp-detail-reveal-error" }, revealError)),

    failure === undefined
      ? null
      : React.createElement(Section, { title: t("mcp.detail.failure"), testId: "mcp-detail-failure" },
          React.createElement("p", { className: styles.failure, "data-testid": "mcp-detail-failure-message" }, failure.message),
          React.createElement("p", { className: styles.note, "data-testid": "mcp-detail-failure-time" }, t("mcp.detail.failureTime", { time: formatTimestamp(failure.at) })),
          remaining <= 0
            ? null
            : React.createElement("p", { className: styles.cooldown, "data-testid": "mcp-detail-failure-cooldown" },
                t("mcp.row.cooldown", { remaining: formatDuration(remaining) }))));
}
