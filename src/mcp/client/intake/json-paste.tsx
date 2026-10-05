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
import { Banner } from "../../../kit/index.ts";
import { parseJsonText, upsertServer } from "../data.ts";
import { fieldErrorsOf } from "../model.ts";
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
import { errorText } from "../../../shared/error-text.ts";

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
        setParseError(errorText(error));
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
          const detailText =
            details.length > 0 ? "（" + details.map((item) => item.path + " " + item.message).join("；") + "）" : "";
          collected[row.index] = {
            ok: false,
            text: t("mcp.paste.resultFailed", { message: errorText(error) }) + detailText,
          };
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
  const placeholders =
    rows === undefined ? [] : placeholderNames(list.map((row) => ({ ...row.server, serverName: row.name })));

  return (
    <div className={styles.intakeBody} data-testid="mcp-paste">
      <p className={styles.intakeHint}>{t("mcp.paste.hint")}</p>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="mcp-paste-textarea">
          {t("mcp.paste.textLabel")}
        </label>
        <textarea
          id="mcp-paste-textarea"
          data-testid="mcp-paste-textarea"
          className={styles.jsonTextarea}
          value={text}
          placeholder={t("mcp.paste.placeholder")}
          spellCheck={false}
          onChange={(event: { target: { value: string } }) => setText(event.target.value)}
        />
      </div>
      <div className={styles.intakeToolbar}>
        <Button variant="primary" data-testid="mcp-paste-parse" disabled={parsing} onClick={parse}>
          {parsing ? t("mcp.paste.parsing") : t("mcp.paste.parse")}
        </Button>
        <Button variant="outline" data-testid="mcp-paste-clear" onClick={clear}>
          {t("mcp.paste.clear")}
        </Button>
        {rows === undefined || rows.length === 0 ? null : (
          <span className={styles.small} data-testid="mcp-paste-selected">
            {t("mcp.paste.found", { count: rows.length }) +
              " · " +
              t("mcp.paste.selected", { count: selected.length, total: rows.length })}
          </span>
        )}
      </div>
      {rows !== undefined || parseError !== undefined ? null : (
        <p className={styles.intakeHint} data-testid="mcp-paste-empty">
          {t("mcp.paste.empty")}
        </p>
      )}
      {parseError === undefined ? null : (
        <Banner tone="danger" testId="mcp-paste-parse-error">
          <span>{t("mcp.paste.parseFailed")}</span>
          {parseError.split("\n").map((line, index) => (
            <p key={index} className={styles.small} data-testid={"mcp-paste-parse-error-line-" + index}>
              {line}
            </p>
          ))}
        </Banner>
      )}
      {placeholders.length === 0 ? null : (
        <Banner tone="warn" testId="mcp-paste-hidden-warning">
          {t("mcp.paste.hiddenWarning", { names: placeholders.join("、") })}
        </Banner>
      )}
      {warnings.length === 0 ? null : (
        <Banner tone="neutral" testId="mcp-paste-warnings">
          <span>{t("mcp.paste.warnings", { count: warnings.length })}</span>
          <ul className={styles.warnList}>
            {warnings.map((warning, index) => (
              <li key={index} className={styles.warnItem}>
                {t("mcp.paste.warningRow", { text: warning })}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {rows === undefined ? null : rows.length === 0 ? null : (
        <ul className={styles.pasteRows} data-testid="mcp-paste-rows">
          {rows.map((row) => {
            const result = results[row.index];
            return (
              <li key={row.key} className={styles.pasteRow} data-testid={"mcp-paste-row-" + row.index}>
                <div className={styles.pasteRowHead}>
                  {/* 宿主 Checkbox 不转发未知 props，testid 只能挂在外层 span 上 */}
                  <span className={styles.control} data-testid={"mcp-paste-row-check-" + row.index}>
                    <Checkbox
                      checked={selected.includes(row.index)}
                      disabled={saving}
                      label={t("mcp.paste.selectRow", { name: row.name })}
                      onChange={() => setSelected((current) => toggleSelection(current, row.index))}
                    />
                  </span>
                  {row.status === "new" ? (
                    <span className={styles.small} data-testid={"mcp-paste-row-status-" + row.index}>
                      {t("mcp.paste.statusNew")}
                    </span>
                  ) : (
                    <span className={styles.warnItem} data-testid={"mcp-paste-row-status-" + row.index}>
                      {row.status === "conflict" ? t("mcp.paste.statusConflict") : t("mcp.paste.statusInvalid")}
                    </span>
                  )}
                  {row.status === "new" || row.suggestedName === undefined ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid={"mcp-paste-row-suggest-" + row.index}
                      onClick={() => rename(row, row.suggestedName as string)}
                    >
                      {t("mcp.paste.useSuggested", { name: row.suggestedName })}
                    </Button>
                  )}
                </div>
                <p className={styles.pasteRowSummary} data-testid={"mcp-paste-row-summary-" + row.index}>
                  {row.summary}
                </p>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>{t("mcp.paste.renameLabel")}</label>
                  <Input
                    data-testid={"mcp-paste-row-name-" + row.index}
                    value={row.name}
                    disabled={saving}
                    onChange={(event: { target: { value: string } }) => rename(row, event.target.value)}
                  />
                  <p className={styles.hint}>{t("mcp.paste.renameHint")}</p>
                </div>
                {result === undefined ? null : (
                  <p
                    className={result.ok ? styles.resultOk : styles.resultFail}
                    data-testid={"mcp-paste-row-result-" + row.index}
                  >
                    {result.text}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rows === undefined || rows.length === 0 ? null : (
        <div className={styles.intakeToolbar}>
          <Button
            size="sm"
            variant="outline"
            data-testid="mcp-paste-select-all"
            disabled={saving}
            onClick={() => setSelected(defaultSelection(rows))}
          >
            {t("mcp.paste.selectAll")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="mcp-paste-clear-selection"
            disabled={saving}
            onClick={() => setSelected([])}
          >
            {t("mcp.paste.clearSelection")}
          </Button>
          <span className={styles.spacer} />
          <Button
            variant="primary"
            data-testid="mcp-paste-save"
            disabled={saving || selected.length === 0 || blocked.length > 0}
            onClick={save}
          >
            {saving ? t("mcp.paste.saving") : t("mcp.paste.save", { count: selected.length })}
          </Button>
        </div>
      )}
      {blocked.length === 0 ? null : (
        <p className={styles.warnItem} data-testid="mcp-paste-blocked">
          {t("mcp.paste.blocked", { count: blocked.length })}
        </p>
      )}
    </div>
  );
}
