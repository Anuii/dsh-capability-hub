/**
 * MCP 服务器详情抽屉的正文（UI-DESIGN §5）：概览 → 工具 → 环境变量与请求头。
 *
 * 两条纪律：
 *   - **遮罩**（D-C5）：env / headers 的值默认就是 ***hidden***，只有用户显式点「显示」
 *     才向服务端要一次明文，明文只存在本次抽屉的组件状态里；
 *   - 「工具」一节先说状态（已连接 · N 个工具 / 连接失败：原因 / 按会话……），再列模型看到的工具名；
 *     「重新连接」= 卸下再挂上官方 MCP 插件实例（ADR-0010）。
 */

import * as React from "react";
import { revealServer } from "./data.ts";
import { scopeLabel, stateText, transportLabel, viewSummaryText } from "./view-model.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { KeyValue, Section } from "../../kit/index.ts";
import type { RuntimeServerView } from "../contract/runtime.ts";
import type { ServerView } from "../contract/config.ts";
import { errorText } from "../../shared/error-text.ts";

export interface ServerDetailBodyProps {
  view: ServerView;
  row: RuntimeServerView | undefined;
  reconnecting: boolean;
  onReconnect(): void;
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
  return (
    <div className={styles.stack} data-testid={"mcp-detail-" + props.field}>
      {/* 小标题左、动作右（与 Section 的 end 区同一风格） */}
      <div className={styles.secretHead}>
        <span className={styles.fieldLabel}>{props.label}</span>
        <span className={styles.spacer} />
        {keys.length === 0 ? null : (
          <button
            type="button"
            className={styles.textButton}
            data-testid={"mcp-detail-reveal-" + props.field}
            disabled={props.busy}
            title={t("mcp.detail.revealTitle")}
            onClick={props.onReveal}
          >
            {props.busy
              ? t("mcp.detail.revealing")
              : props.plain === undefined
                ? t("mcp.detail.show")
                : t("mcp.detail.hide")}
          </button>
        )}
      </div>
      {keys.length === 0 ? (
        <p className={styles.muted} data-testid={"mcp-detail-" + props.field + "-empty"}>
          {t("mcp.detail.none")}
        </p>
      ) : (
        <div className={styles.secretGrid}>
          {keys.flatMap((key) => {
            const masked = props.plain === undefined;
            const value = masked ? props.entries[key] : (props.plain?.[key] ?? props.entries[key]);
            return [
              <span key={key + "-k"} className={styles.secretKey} title={key}>
                {key}
              </span>,
              <span
                key={key + "-v"}
                className={masked ? styles.secretValue + " " + styles.valueMasked : styles.secretValue}
                title={masked ? t("mcp.detail.masked") : undefined}
                data-testid={"mcp-detail-secret-" + props.field + "-" + key}
              >
                {value}
              </span>,
            ];
          })}
        </div>
      )}
    </div>
  );
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
    void revealServer(name)
      .then(
        (full) => {
          setPlain((current) => ({ ...current, [field]: field === "env" ? full.env : full.headers }));
          props.showToast(t("mcp.toast.revealed"));
        },
        (failure: unknown) => setRevealError(t("mcp.detail.revealFailed", { message: errorText(failure) })),
      )
      .finally(() => setRevealing(undefined));
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

  const description = view.meta?.description;
  const overview = [
    { label: t("mcp.detail.transport"), value: transportLabel(view.transport), testId: "mcp-detail-transport" },
    view.transport === "streamable-http"
      ? {
          label: t("mcp.detail.url"),
          value: view.url ?? t("mcp.detail.none"),
          mono: true,
          title: view.url,
          testId: "mcp-detail-url",
        }
      : {
          label: t("mcp.detail.command"),
          value: viewSummaryText(view),
          mono: true,
          title: viewSummaryText(view),
          testId: "mcp-detail-command",
        },
    ...(view.cwd === undefined || view.cwd === ""
      ? []
      : [{ label: t("mcp.detail.cwd"), value: view.cwd, mono: true, testId: "mcp-detail-cwd" }]),
    { label: t("mcp.detail.scope"), value: scopeLabel(view.scope), testId: "mcp-detail-scope" },
    ...(description === undefined || description === ""
      ? []
      : [{ label: t("mcp.detail.description"), value: description, testId: "mcp-detail-description" }]),
  ];

  const tools = view.disabled ? [] : (row?.tools ?? []);
  const failed = !view.disabled && (row?.state === "failed" || row?.state === "disconnected");

  return (
    <React.Fragment>
      <Section title={t("mcp.detail.overview")} testId="mcp-detail-overview">
        <KeyValue items={overview} testId="mcp-detail-overview-kv" />
      </Section>
      <Section
        title={t("mcp.detail.tools")}
        testId="mcp-detail-tools"
        end={
          <Button
            size="sm"
            variant="outline"
            data-testid="mcp-detail-reconnect"
            disabled={props.reconnecting || view.disabled}
            onClick={props.onReconnect}
          >
            {props.reconnecting ? t("mcp.detail.reconnecting") : t("mcp.detail.reconnect")}
          </Button>
        }
      >
        <p className={failed ? styles.failure : styles.cacheLine} data-testid="mcp-detail-state">
          {stateText(view, row)}
        </p>
        {tools.length === 0 ? null : (
          <ul className={styles.toolList} data-testid="mcp-detail-tool-list">
            {tools.map((tool) => (
              <li
                key={tool.name}
                className={styles.toolItem}
                {...(tool.description === undefined ? {} : { title: tool.description })}
              >
                {tool.name}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t("mcp.detail.secrets")} testId="mcp-detail-secrets">
        <SecretBlock
          label={t("mcp.detail.env")}
          field="env"
          entries={view.env}
          plain={plain.env}
          busy={revealing === "env"}
          onReveal={() => togglePlain("env")}
        />
        <SecretBlock
          label={t("mcp.detail.headers")}
          field="headers"
          entries={view.headers}
          plain={plain.headers}
          busy={revealing === "headers"}
          onReveal={() => togglePlain("headers")}
        />
        {revealError === undefined ? null : (
          <p className={styles.fieldError} data-testid="mcp-detail-reveal-error">
            {revealError}
          </p>
        )}
      </Section>
    </React.Fragment>
  );
}
