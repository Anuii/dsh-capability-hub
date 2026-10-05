/**
 * 从 Claude Code / Codex 只读导入（D-C2 的第三种添加方式）。
 *
 * GET mcp/import/sources → 两个来源（是否找到、文件路径、warnings、已遮罩的服务器列表）
 * → 逐个勾选 → POST mcp/import/apply { sourceId, names } → 显示 imported 与 skipped（含原因）。
 *
 * 红线（PLAN §4 / D-A5）：这两个来源**只读**，任何代码路径都不写它们的文件；
 * 敏感值在预览里是 ***hidden***，导入时由服务端读取原值（我们绝不把占位符当新值提交）。
 * 接口按来源一次调一个（sourceId 是必填参数），所以每个来源各有自己的勾选与结果。
 */

import * as React from "react";
import { Button, Checkbox } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, Banner, SkeletonRows } from "../../../kit/index.ts";
import { applyImport, fetchImportSources } from "../data.ts";
import { errorMessage } from "../model.ts";
import { styles } from "../styles.ts";
import { t } from "../strings.ts";
import type { ImportApplyResponse, ImportSourceView, ParsedServer } from "../../contract/config.ts";
import { hiddenKeys, importableNames, rawSummary, secretSummary } from "./pure.ts";

export interface ImportViewProps {
  /** 当前配置里的服务器名（默认勾选时排除同名）。 */
  existingNames: readonly string[];
  /** 有服务器导入成功时调用（外壳负责刷新列表与后台探测）。 */
  onImported(names: readonly string[]): void;
  showToast(text: string, tone?: "success"): void;
}

type Selection = Record<string, string[]>;
type Results = Record<string, ImportApplyResponse>;

function rowOrigin(source: ImportSourceView, server: ParsedServer): string {
  const origin = source.origins[server.serverName];
  return origin === undefined || origin === "" ? source.label : origin;
}

export function ImportView(props: ImportViewProps): React.ReactElement {
  const [sources, setSources] = React.useState<ImportSourceView[] | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [selected, setSelected] = React.useState<Selection>({});
  const [results, setResults] = React.useState<Results>({});
  const [busy, setBusy] = React.useState<string | undefined>(undefined);
  const existingNames = props.existingNames;

  /**
   * 只在**挂载时**与**手动重试时**加载来源列表。
   *
   * 为什么不用 `existingNames` 当依赖：导入成功后外壳会刷新配置，父组件随之传入新的
   * existingNames 数组；若按它重载，刚渲染出来的 imported / skipped 结果会被立刻清空
   * （走查里实测到过）。默认勾选沿用「打开这一刻」的配置快照即可 —— 真正的同名判定
   * 在服务端 import/apply 里做，不会因为这里过期而误覆盖。
   */
  const [reloadToken, setReloadToken] = React.useState<number>(0);

  const load = React.useCallback((): void => {
    setLoading(true);
    setError(undefined);
    void fetchImportSources().then(
      (items) => {
        setSources(items);
        setLoading(false);
        setResults({});
        const next: Selection = {};
        for (const source of items) next[source.id] = importableNames(source.servers, existingNames);
        setSelected(next);
      },
      (failure: unknown) => {
        setError(errorMessage(failure));
        setLoading(false);
      },
    );
  }, [existingNames]);

  React.useEffect(() => {
    load();
  }, [reloadToken]);

  const toggle = (sourceId: string, name: string): void => {
    setSelected((current) => {
      const list = current[sourceId] ?? [];
      return { ...current, [sourceId]: list.includes(name) ? list.filter((item) => item !== name) : [...list, name] };
    });
  };

  const apply = (source: ImportSourceView): void => {
    const names = selected[source.id] ?? [];
    if (names.length === 0) {
      props.showToast(t("mcp.import.noSelection"));
      return;
    }
    setBusy(source.id);
    void applyImport(source.id, names).then(
      (result) => {
        setBusy(undefined);
        setResults((current) => ({ ...current, [source.id]: result }));
        setSelected((current) => ({ ...current, [source.id]: [] }));
        props.showToast(
          t("mcp.import.done", { imported: result.imported.length, skipped: result.skipped.length }),
          result.imported.length > 0 ? "success" : undefined,
        );
        if (result.imported.length > 0) props.onImported(result.imported);
      },
      (failure: unknown) => {
        setBusy(undefined);
        props.showToast(t("mcp.import.failed", { message: errorMessage(failure) }));
      },
    );
  };

  const sourceBody = (source: ImportSourceView): React.ReactElement => {
    const result = results[source.id];
    const picked = selected[source.id] ?? [];
    return React.createElement("section", {
        key: source.id,
        className: styles.importSection,
        "data-testid": "mcp-import-source-" + source.id,
      },
      React.createElement("div", { className: styles.importHead },
        React.createElement("p", { className: styles.importTitle, "data-testid": "mcp-import-label-" + source.id }, source.label),
        React.createElement("span", { "data-testid": "mcp-import-found-" + source.id },
          React.createElement(Badge, { tone: source.found ? "neutral" : "neutral" },
            source.found ? t("mcp.import.found", { count: source.servers.length }) : t("mcp.import.notFound")))),
      React.createElement("p", { className: styles.importMeta, "data-testid": "mcp-import-path-" + source.id },
        t("mcp.import.path") + "：" + source.path),

      source.warnings.length === 0
        ? null
        : React.createElement(Banner, { tone: "neutral", testId: "mcp-import-warnings-" + source.id },
            React.createElement("span", null, t("mcp.import.warnings", { count: source.warnings.length })),
            React.createElement("ul", { className: styles.warnList },
              source.warnings.map((warning, index) =>
                React.createElement("li", { key: index, className: styles.warnItem }, t("mcp.import.warningRow", { text: warning }))))),

      source.found && source.servers.length === 0
        ? React.createElement("p", { className: styles.intakeHint, "data-testid": "mcp-import-empty-" + source.id }, t("mcp.import.empty"))
        : null,

      React.createElement("ul", { className: styles.importList },
        source.servers.map((server) =>
          React.createElement("li", {
              key: server.serverName,
              className: styles.importRow,
              "data-testid": "mcp-import-row-" + source.id + "-" + server.serverName,
            },
            // 宿主 Checkbox 不转发未知 props，testid 挂在包裹的 span 上
            React.createElement("span", { className: styles.control, "data-testid": "mcp-import-check-" + source.id + "-" + server.serverName },
              React.createElement(Checkbox, {
                checked: picked.includes(server.serverName),
                disabled: !source.found || busy !== undefined,
                label: t("mcp.import.selectRow", { name: server.serverName }),
                onChange: () => toggle(source.id, server.serverName),
              })),
            React.createElement("p", { className: styles.pasteRowSummary, "data-testid": "mcp-import-summary-" + source.id + "-" + server.serverName }, rawSummary(server)),
            React.createElement("p", { className: styles.importMeta }, t("mcp.import.origin", { origin: rowOrigin(source, server) })),
            hiddenKeys(server).length === 0 && secretSummary(server) === ""
              ? null
              : React.createElement("p", { className: styles.importMeta, "data-testid": "mcp-import-masked-" + source.id + "-" + server.serverName },
                  (secretSummary(server) === "" ? "" : secretSummary(server) + " · ") + t("mcp.import.masked"))))),

      source.found
        ? React.createElement("div", { className: styles.intakeToolbar },
            React.createElement("span", { className: styles.small, "data-testid": "mcp-import-selected-" + source.id },
              t("mcp.import.selected", { count: picked.length, total: source.servers.length })),
            React.createElement(Button, {
              variant: "primary",
              "data-testid": "mcp-import-apply-" + source.id,
              disabled: busy !== undefined || picked.length === 0,
              onClick: () => apply(source),
            }, busy === source.id ? t("mcp.import.applying") : t("mcp.import.apply", { count: picked.length })))
        : null,

      result === undefined
        ? null
        : React.createElement("div", { className: styles.importResult, "data-testid": "mcp-import-result-" + source.id },
            React.createElement("p", { className: styles.resultOk, "data-testid": "mcp-import-imported-" + source.id },
              t("mcp.import.imported", { names: result.imported.length === 0 ? "—" : result.imported.join("、") })),
            result.skipped.length === 0
              ? null
              : React.createElement("p", { className: styles.small }, t("mcp.import.skipped", { count: result.skipped.length })),
            result.skipped.map((item, index) =>
              React.createElement("p", {
                key: index,
                className: styles.skippedRow,
                "data-testid": "mcp-import-skipped-" + source.id + "-" + index,
              }, t("mcp.import.skippedRow", { name: item.name, reason: item.reason })))));
  };

  const body = ((): React.ReactElement => {
    if (error !== undefined) {
      return React.createElement(Banner, {
        tone: "danger",
        testId: "mcp-import-error",
        action: { label: t("mcp.import.retry"), onClick: () => setReloadToken((token) => token + 1), testId: "mcp-import-retry" },
      }, t("mcp.import.loadFailed", { message: error }));
    }
    if (sources === undefined || loading) {
      return React.createElement(SkeletonRows, { rows: 3, testId: "mcp-import-loading" });
    }
    return React.createElement("div", { className: styles.intakeBody },
      sources.map((source) => sourceBody(source)));
  })();

  return React.createElement("div", { className: styles.intakeBody, "data-testid": "mcp-import-view" },
    React.createElement("p", { className: styles.intakeHint }, t("mcp.import.hint")),
    body);
}
