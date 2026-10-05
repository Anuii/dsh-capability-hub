/**
 * JSON 编辑模式（D-C3：每个服务器可切换 JSON，保存前同样校验）。
 *
 * 与表单共用同一份「落盘形态」：只列显式设置过的字段（默认值不落盘），
 * 敏感值是遮罩后的 ***hidden***，原样提交即由服务端保留原值。
 * 未知字段因此在文本里可见，保存时先 `mcp/validate`，服务端逐条返回 path + message。
 */

import * as React from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { Banner } from "../../kit/index.ts";
import { upsertServer, validateServer } from "./data.ts";
import { fieldErrorsOf, isPlainObject, parseJsonServer } from "./model.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { FieldError, ServerView } from "../contract/config.ts";
import { errorText } from "../../shared/error-text.ts";

export interface JsonEditorProps {
  originalName?: string;
  initialText: string;
  onSaved(server: ServerView, warnings: readonly string[]): void;
  onCancel(): void;
  onSwitchToForm(values: Record<string, unknown>): void;
}

export function JsonEditor(props: JsonEditorProps): React.ReactElement {
  const [text, setText] = React.useState<string>(props.initialText);
  const [errors, setErrors] = React.useState<FieldError[]>([]);
  const [parseError, setParseError] = React.useState<string | undefined>(undefined);
  const [formError, setFormError] = React.useState<string | undefined>(undefined);
  const [okText, setOkText] = React.useState<string | undefined>(undefined);
  const [busy, setBusy] = React.useState<boolean>(false);

  const parsed = React.useMemo(() => parseJsonServer(text), [text]);

  const save = (): void => {
    setFormError(undefined);
    setOkText(undefined);
    const result = parseJsonServer(text);
    if (result.values === undefined) {
      setParseError(result.error ?? t("mcp.json.parseError", { message: "" }));
      setErrors([]);
      return;
    }
    setParseError(undefined);
    setBusy(true);
    void (async () => {
      try {
        const validated = await validateServer(result.values as Record<string, unknown>, props.originalName);
        if (validated.errors.length > 0) {
          setErrors(validated.errors);
          return;
        }
        setErrors([]);
        setOkText(t("mcp.json.ok"));
        const saved = await upsertServer(props.originalName, result.values as Record<string, unknown>);
        props.onSaved(saved.server, saved.warnings);
      } catch (error) {
        setFormError(t("mcp.json.saveFailed", { message: errorText(error) }));
        const details = fieldErrorsOf(error);
        if (details.length > 0) setErrors(details);
      } finally {
        setBusy(false);
      }
    })();
  };

  const format = (): void => {
    const result = parseJsonServer(text);
    if (result.values === undefined) {
      setParseError(result.error ?? "");
      return;
    }
    setParseError(undefined);
    setText(JSON.stringify(result.values, null, 2));
  };

  return (
    <div className={styles.json} data-testid="mcp-json">
      <React.Fragment>
        <p className={styles.note}>{t("mcp.json.hint")}</p>
        {props.originalName === undefined ? <p className={styles.note}>{t("mcp.json.hiddenWarning")}</p> : null}
        <textarea
          className={styles.jsonTextarea}
          value={text}
          spellCheck={false}
          data-testid="mcp-json-textarea"
          onChange={(event: { target: { value: string } }) => setText(event.target.value)}
        />
        {parseError === undefined ? null : (
          <p className={styles.fieldError} data-testid="mcp-json-parse-error">
            {t("mcp.json.parseError", { message: parseError })}
          </p>
        )}
        {errors.length === 0 ? null : (
          <Banner tone="danger" testId="mcp-json-errors">
            <span>{t("mcp.json.errors", { count: errors.length })}</span>
            <ul className={styles.jsonErrors}>
              {errors.map((error, index) => (
                <li key={index} className={styles.jsonErrorRow} data-testid={"mcp-json-error-" + String(index)}>
                  <span className={styles.jsonErrorPath}>{error.path}</span>
                  {"：" + error.message}
                </li>
              ))}
            </ul>
          </Banner>
        )}
        {okText === undefined ? null : (
          <p className={styles.commandOk} data-testid="mcp-json-ok">
            {okText}
          </p>
        )}
        {formError === undefined ? null : (
          <Banner tone="danger" testId="mcp-json-form-error">
            {formError}
          </Banner>
        )}
        <div className={styles.actions}>
          <Button variant="primary" data-testid="mcp-json-save" {...(busy ? { disabled: true } : {})} onClick={save}>
            {busy ? t("mcp.saving") : t("mcp.json.save")}
          </Button>
          <Button data-testid="mcp-json-format" onClick={format}>
            {t("mcp.json.format")}
          </Button>
          <Button
            data-testid="mcp-json-to-form"
            onClick={() => {
              const result = parseJsonServer(text);
              if (result.values === undefined) {
                setParseError(result.error ?? "");
                return;
              }
              setParseError(undefined);
              props.onSwitchToForm(result.values);
            }}
          >
            {t("mcp.json.toForm")}
          </Button>
          <Button data-testid="mcp-json-cancel" onClick={props.onCancel}>
            {t("mcp.cancel")}
          </Button>
          {parsed.values === undefined ? (
            <span className={styles.small}>{t("mcp.json.parseError", { message: parsed.error ?? "" })}</span>
          ) : null}
        </div>
      </React.Fragment>
    </div>
  );
}
