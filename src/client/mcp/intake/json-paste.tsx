/**
 * 粘贴 JSON（D-C2 的第一种添加方式）。
 *
 * 流程：文本框 → POST mcp/parse-json → 预览识别出的服务器（含同名冲突与非法名）→
 * 勾选 / 改名 → 逐个 POST mcp/servers/upsert → 逐条显示结果。
 *
 * 纯逻辑（识别计划、改名建议、勾选与阻断）在 ./pure.ts，可被 node:test 直接测。
 * 遮罩：粘贴走的是用户原文；但如果原文里带 ***hidden*** 占位符，新建时会被当成真实值
 * （宿主已知问题 FIX-2/3），这里给出显式警告，不静默提交。
 */

import * as React from "react";
import { Button, Checkbox, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { Banner } from "../../shell/kit/index.ts";
import { parseJsonText, upsertServer } from "../data.ts";
import { errorMessage, fieldErrorsOf } from "../model.ts";
import { styles } from "../styles.ts";
import { t } from "../strings.ts";
import {
  blockedRows,
  defaultSelection,
  planPasteRows,
  placeholderNames,
  rawToSubmit,
  renameRow,
  toggleSelection,
  type PasteRow,
} from "./pure.ts";

export interface JsonPasteViewProps {
  /** 当前配置里的服务器名（同名冲突判定用）。 */
  existingNames: readonly string[];
  /** 有服务器保存成功时调用（外壳负责刷新列表与后台探测）。 */
  onSaved(names: readonly string[]): void;
  showToast(text: string, tone?: "success"): void;
}

interface RowResult {
  ok: boolean;
  text: string;
}

export function JsonPasteView(props: JsonPasteViewProps): React.ReactElement {
  const [text, setText] = React.useState<string>("");
  const [rows, setRows] = React.useState<PasteRow[] | undefined>(undefined);
  const [warnings, setWarnings] = React.useState<string[]>([]);
  const [parseError, setParseError] = React.useState<string | undefined>(undefined);
  const [selected, setSelected] = React.useState<number[]>([]);
  const [parsing, setParsing] = React.useState<boolean>(false);
  const [saving, setSaving] = React.useState<boolean>(false);
  const [results, setResults] = React.useState<Record<number, RowResult>>({});

  const existingNames = props.existingNames;

  const parse = (): void => {
    if (text.trim() === "") {
      props.showToast(t("mcp.paste.needText"));
      return;
    }
    setParsing(true);
    setParseError(undefined);
    setWarnings([]);
    setResults({});
    void parseJsonText(text).then(
      (payload) => {
        setParsing(false);
        if (payload.servers.length === 0) {
          setRows([]);
          setSelected([]);
          setWarnings(payload.warnings);
          // 服务端原文照实显示（JSON 语法错误、结构无法识别等都在这里）
          setParseError(payload.warnings.length > 0 ? payload.warnings.join("\n") : t("mcp.paste.noServers"));
          return;
        }
        const next = planPasteRows(payload.servers, existingNames);
        setRows(next);
        setSelected(defaultSelection(next));
        setWarnings(payload.warnings);
      },
      (error: unknown) => {
        setParsing(false);
        setRows(undefined);
        setParseError(errorMessage(error));
      },
    );
  };

  const clear = (): void => {
    setText("");
    setRows(undefined);
    setWarnings([]);
    setParseError(undefined);
    setSelected([]);
    setResults({});
  };

  const rename = (row: PasteRow, name: string): void => {
    setRows((current) => (current === undefined ? current : renameRow(current, row.index, name, existingNames)));
  };

  const save = (): void => {
    if (rows === undefined || selected.length === 0 || saving) return;
    const targets = rows.filter((row) => selected.includes(row.index));
    setSaving(true);
    void (async () => {
      const collected: Record<number, RowResult> = {};
      const okNames: string[] = [];
      for (const row of targets) {
        try {
          const result = await upsertServer(undefined, rawToSubmit({ ...row.server, serverName: row.name }));
          const extra = result.warnings.length > 0 ? " · " + result.warnings.join("；") : "";
          collected[row.index] = { ok: true, text: t("mcp.paste.resultSaved") + extra };
          okNames.push(row.name);
        } catch (error: unknown) {
          const details = fieldErrorsOf(error);
          const detailText = details.length > 0 ? "（" + details.map((item) => item.path + " " + item.message).join("；") + "）" : "";
          collected[row.index] = { ok: false, text: t("mcp.paste.resultFailed", { message: errorMessage(error) }) + detailText };
        }
        setResults({ ...collected });
      }
      setSaving(false);
      setSelected((current) => current.filter((index) => collected[index] === undefined));
      if (okNames.length > 0) {
        // 汇总提示（含「去运行态看缓存」动作）由外壳出，避免这里再叠一条 Toast
        props.onSaved(okNames);
      } else {
        props.showToast(t("mcp.paste.savedNone"));
      }
    })();
  };

  const list = rows ?? [];
  const blocked = blockedRows(list, selected);
  const placeholders = rows === undefined ? [] : placeholderNames(list.map((row) => ({ ...row.server, serverName: row.name })));

  return React.createElement("div", { className: styles.intakeBody, "data-testid": "mcp-paste" },
    React.createElement("p", { className: styles.intakeHint }, t("mcp.paste.hint")),
    React.createElement("div", { className: styles.field },
      React.createElement("label", { className: styles.fieldLabel, htmlFor: "mcp-paste-textarea" }, t("mcp.paste.textLabel")),
      React.createElement("textarea", {
        id: "mcp-paste-textarea",
        "data-testid": "mcp-paste-textarea",
        className: styles.jsonTextarea,
        value: text,
        placeholder: t("mcp.paste.placeholder"),
        spellCheck: false,
        onChange: (event: { target: { value: string } }) => setText(event.target.value),
      })),
    React.createElement("div", { className: styles.intakeToolbar },
      React.createElement(Button, {
        variant: "primary",
        "data-testid": "mcp-paste-parse",
        disabled: parsing,
        onClick: parse,
      }, parsing ? t("mcp.paste.parsing") : t("mcp.paste.parse")),
      React.createElement(Button, {
        variant: "outline",
        "data-testid": "mcp-paste-clear",
        onClick: clear,
      }, t("mcp.paste.clear")),
      rows === undefined || rows.length === 0
        ? null
        : React.createElement("span", { className: styles.small, "data-testid": "mcp-paste-selected" },
            t("mcp.paste.found", { count: rows.length }) + " · " + t("mcp.paste.selected", { count: selected.length, total: rows.length }))),

    rows !== undefined || parseError !== undefined
      ? null
      : React.createElement("p", { className: styles.intakeHint, "data-testid": "mcp-paste-empty" }, t("mcp.paste.empty")),

    parseError === undefined
      ? null
      : React.createElement(Banner, { tone: "danger", testId: "mcp-paste-parse-error" },
          React.createElement("span", null, t("mcp.paste.parseFailed")),
          parseError.split("\n").map((line, index) =>
            React.createElement("p", { key: index, className: styles.small, "data-testid": "mcp-paste-parse-error-line-" + index }, line))),

    placeholders.length === 0
      ? null
      : React.createElement(Banner, { tone: "warn", testId: "mcp-paste-hidden-warning" },
          t("mcp.paste.hiddenWarning", { names: placeholders.join("、") })),

    warnings.length === 0
      ? null
      : React.createElement(Banner, { tone: "neutral", testId: "mcp-paste-warnings" },
          React.createElement("span", null, t("mcp.paste.warnings", { count: warnings.length })),
          React.createElement("ul", { className: styles.warnList },
            warnings.map((warning, index) =>
              React.createElement("li", { key: index, className: styles.warnItem }, t("mcp.paste.warningRow", { text: warning }))))),

    rows === undefined
      ? null
      : rows.length === 0
        ? null
        : React.createElement("ul", { className: styles.pasteRows, "data-testid": "mcp-paste-rows" },
            rows.map((row) => {
              const result = results[row.index];
              return React.createElement("li", {
                  key: row.key,
                  className: styles.pasteRow,
                  "data-testid": "mcp-paste-row-" + row.index,
                },
                React.createElement("div", { className: styles.pasteRowHead },
                  // 宿主 Checkbox 不转发未知 props，testid 只能挂在外层 span 上
                  React.createElement("span", { className: styles.control, "data-testid": "mcp-paste-row-check-" + row.index },
                    React.createElement(Checkbox, {
                      checked: selected.includes(row.index),
                      disabled: saving,
                      label: t("mcp.paste.selectRow", { name: row.name }),
                      onChange: () => setSelected((current) => toggleSelection(current, row.index)),
                    })),
                  row.status === "new"
                    ? React.createElement("span", { className: styles.small, "data-testid": "mcp-paste-row-status-" + row.index }, t("mcp.paste.statusNew"))
                    : React.createElement("span", { className: styles.warnItem, "data-testid": "mcp-paste-row-status-" + row.index },
                        row.status === "conflict" ? t("mcp.paste.statusConflict") : t("mcp.paste.statusInvalid")),
                  row.status === "new" || row.suggestedName === undefined
                    ? null
                    : React.createElement(Button, {
                        size: "sm",
                        variant: "outline",
                        "data-testid": "mcp-paste-row-suggest-" + row.index,
                        onClick: () => rename(row, row.suggestedName as string),
                      }, t("mcp.paste.useSuggested", { name: row.suggestedName }))),
                React.createElement("p", { className: styles.pasteRowSummary, "data-testid": "mcp-paste-row-summary-" + row.index }, row.summary),
                React.createElement("div", { className: styles.field },
                  React.createElement("label", { className: styles.fieldLabel }, t("mcp.paste.renameLabel")),
                  React.createElement(Input, {
                    "data-testid": "mcp-paste-row-name-" + row.index,
                    value: row.name,
                    disabled: saving,
                    onChange: (event: { target: { value: string } }) => rename(row, event.target.value),
                  }),
                  React.createElement("p", { className: styles.hint }, t("mcp.paste.renameHint"))),
                result === undefined
                  ? null
                  : React.createElement("p", {
                      className: result.ok ? styles.resultOk : styles.resultFail,
                      "data-testid": "mcp-paste-row-result-" + row.index,
                    }, result.text));
            })),

    rows === undefined || rows.length === 0
      ? null
      : React.createElement("div", { className: styles.intakeToolbar },
          React.createElement(Button, {
            size: "sm",
            variant: "outline",
            "data-testid": "mcp-paste-select-all",
            disabled: saving,
            onClick: () => setSelected(defaultSelection(rows)),
          }, t("mcp.paste.selectAll")),
          React.createElement(Button, {
            size: "sm",
            variant: "outline",
            "data-testid": "mcp-paste-clear-selection",
            disabled: saving,
            onClick: () => setSelected([]),
          }, t("mcp.paste.clearSelection")),
          React.createElement("span", { className: styles.spacer }),
          React.createElement(Button, {
            variant: "primary",
            "data-testid": "mcp-paste-save",
            disabled: saving || selected.length === 0 || blocked.length > 0,
            onClick: save,
          }, saving ? t("mcp.paste.saving") : t("mcp.paste.save", { count: selected.length }))),

    blocked.length === 0
      ? null
      : React.createElement("p", { className: styles.warnItem, "data-testid": "mcp-paste-blocked" },
          t("mcp.paste.blocked", { count: blocked.length })));
}
