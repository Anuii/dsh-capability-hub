/**
 * MCP 表单的字段原子件：外壳（标签 / 说明 / 「已设置」徽标 / 「恢复默认」/ 错误）
 * 与各类编辑器（文本 / 数值 / 枚举 / 开关 / 字符串数组 / 键值 + 遮罩显示）。
 *
 * 约定：
 *   - 「已设置」= 草稿 values 里有这个键；「恢复默认」= 把它删掉（D-C1）；
 *   - 每个字段都带 `data-testid="mcp-field-<field>"` 与错误 `mcp-error-<field>`，走查脚本据此取证；
 *   - 敏感值（env / headers）默认就是 ***hidden***，点「显示」才由父组件调 reveal 拿明文。
 */

import * as React from "react";
import { Button, Input, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge } from "../../kit/index.ts";
import { HIDDEN_VALUE } from "./model.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";

/** 字段外壳。 */
export function FieldShell(props: {
  field: string;
  label: string;
  hint?: string;
  /** 草稿里显式设置过这个字段。 */
  set: boolean;
  required?: boolean;
  errors: readonly string[];
  showErrors: boolean;
  /** 省略 = 不提供「恢复默认」（serverName / transport 用）。 */
  onReset?: () => void;
  children?: React.ReactNode;
}): React.ReactElement {
  const badges: React.ReactNode[] = [];
  if (props.set) {
    badges.push(
      <Badge key="set" tone="neutral" testId={"mcp-set-" + props.field}>
        {t("mcp.form.set")}
      </Badge>,
    );
  }
  if (props.set && props.onReset !== undefined) {
    badges.push(
      <Button
        key="reset"
        size="sm"
        variant="ghost"
        title={t("mcp.form.resetTitle")}
        data-testid={"mcp-reset-" + props.field}
        onClick={props.onReset}
      >
        {t("mcp.form.reset")}
      </Button>,
    );
  }
  return (
    <div className={styles.field} data-testid={"mcp-field-" + props.field}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabel}>{props.label}</span>
        {props.required === true ? <Badge tone="neutral">{t("mcp.form.required")}</Badge> : null}
        {badges.length === 0 ? null : <span className={styles.fieldBadges}>{badges}</span>}
      </div>
      {props.hint === undefined ? null : <p className={styles.hint}>{props.hint}</p>}
      {props.children}
      {props.showErrors
        ? props.errors.map((message, index) => (
            <p key={index} className={styles.fieldError} data-testid={"mcp-error-" + props.field}>
              {message}
            </p>
          ))
        : null}
    </div>
  );
}

/** 单行文本。 */
export function TextField(props: {
  field: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange(value: string): void;
}): React.ReactElement {
  return (
    <div className={styles.control}>
      <div className={styles.controlGrow}>
        <Input
          value={props.value}
          data-testid={"mcp-input-" + props.field}
          {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
          {...(props.disabled === true ? { disabled: true } : {})}
          onChange={(event: { target: { value: string } }) => props.onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

/** 数值文本（草稿里存字符串，保存时转数字）。 */
export function NumberField(props: {
  field: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange(value: string): void;
}): React.ReactElement {
  return (
    <div className={styles.control}>
      <div className={styles.controlGrow}>
        <Input
          value={props.value}
          inputMode="numeric"
          data-testid={"mcp-input-" + props.field}
          {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
          {...(props.disabled === true ? { disabled: true } : {})}
          onChange={(event: { target: { value: string } }) => props.onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

/** 枚举下拉（宿主 primitives 没有 Select，用原生 select + 主题变量）。 */
export function SelectField(props: {
  field: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  onChange(value: string): void;
}): React.ReactElement {
  return (
    <div className={styles.control}>
      <select
        className={styles.select}
        value={props.value}
        data-testid={"mcp-input-" + props.field}
        {...(props.disabled === true ? { disabled: true } : {})}
        onChange={(event: { target: { value: string } }) => props.onChange(event.target.value)}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** 布尔开关。 */
export function SwitchField(props: {
  field: string;
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange(next: boolean): void;
}): React.ReactElement {
  return (
    <div className={styles.control}>
      <Switch
        checked={props.checked}
        label={props.label}
        {...(props.disabled === true ? { disabled: true } : {})}
        onChange={(next: boolean) => props.onChange(next)}
      />
    </div>
  );
}

/** 字符串数组：一行一项（空行不会提交）。 */
export function ArrayField(props: {
  field: string;
  items: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  /** 变化时自增：外部把值改掉（恢复默认 / 切换模式）时用它刷新本地行。 */
  syncToken: number;
  onChange(items: string[]): void;
}): React.ReactElement {
  const [rows, setRows] = React.useState<string[]>(() => [...props.items]);
  React.useEffect(() => {
    setRows([...props.items]);
  }, [props.syncToken]);
  const commit = (next: string[]): void => {
    setRows(next);
    props.onChange(next.filter((item) => item.trim() !== ""));
  };
  const list = rows.length === 0 ? [""] : rows;
  return (
    <div className={styles.control}>
      <div className={styles.controlGrow}>
        {list.map((item, index) => (
          <div key={index} className={styles.recordRow}>
            <div className={styles.recordValue}>
              <Input
                value={item}
                data-testid={"mcp-array-" + props.field + "-" + String(index)}
                {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
                {...(props.disabled === true ? { disabled: true } : {})}
                onChange={(event: { target: { value: string } }) => {
                  const next = [...list];
                  next[index] = event.target.value;
                  commit(next);
                }}
              />
            </div>
            <Button
              size="sm"
              variant="ghost"
              title={t("mcp.editor.remove")}
              data-testid={"mcp-array-" + props.field + "-remove-" + String(index)}
              {...(props.disabled === true ? { disabled: true } : {})}
              onClick={() => commit(list.filter((_, at) => at !== index))}
            >
              ×
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          data-testid={"mcp-array-" + props.field + "-add"}
          {...(props.disabled === true ? { disabled: true } : {})}
          onClick={() => commit([...list, ""])}
        >
          {t("mcp.editor.add")}
        </Button>
      </div>
    </div>
  );
}

/** 键值编辑器（env / envFrom / headers / searchKeywords）。 */
export function RecordField(props: {
  field: string;
  entries: Record<string, string>;
  /** 敏感值：默认遮罩，点「显示」才要明文。 */
  secret?: boolean;
  /** 已取到明文。 */
  revealed?: boolean;
  revealBusy?: boolean;
  onReveal?: () => void;
  /** searchKeywords 这类「值是一串列表」的字段用 csv。 */
  valueKind?: "text" | "csv";
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  disabled?: boolean;
  syncToken: number;
  onChange(entries: Record<string, string>): void;
}): React.ReactElement {
  const toRows = (entries: Record<string, string>): Array<{ key: string; value: string }> =>
    Object.entries(entries).map(([key, value]) => ({ key, value: props.valueKind === "csv" ? value : value }));
  const [rows, setRows] = React.useState<Array<{ key: string; value: string }>>(() => toRows(props.entries));
  React.useEffect(() => {
    setRows(toRows(props.entries));
  }, [props.syncToken, props.revealed]);

  const commit = (next: Array<{ key: string; value: string }>): void => {
    setRows(next);
    const map: Record<string, string> = {};
    for (const row of next) {
      if (row.key.trim() === "") continue;
      map[row.key] = row.value;
    }
    props.onChange(map);
  };

  const shown = props.revealed === true || props.secret !== true;
  const list = rows.length === 0 ? [] : rows;
  return (
    <div className={styles.control}>
      <div className={styles.controlGrow}>
        {list.map((row, index) => (
          <div key={index} className={styles.recordRow}>
            <div className={styles.recordKey}>
              <Input
                value={row.key}
                placeholder={props.keyPlaceholder ?? t("mcp.editor.keyPlaceholder")}
                data-testid={"mcp-record-" + props.field + "-key-" + String(index)}
                {...(props.disabled === true ? { disabled: true } : {})}
                onChange={(event: { target: { value: string } }) => {
                  const next = [...list];
                  next[index] = { key: event.target.value, value: row.value };
                  commit(next);
                }}
              />
            </div>
            <div className={styles.recordValue}>
              <Input
                value={row.value}
                placeholder={props.valuePlaceholder ?? t("mcp.editor.valuePlaceholder")}
                data-testid={"mcp-record-" + props.field + "-value-" + String(index)}
                {...(props.disabled === true ? { disabled: true } : {})}
                onChange={(event: { target: { value: string } }) => {
                  const next = [...list];
                  next[index] = { key: row.key, value: event.target.value };
                  commit(next);
                }}
              />
            </div>
            <Button
              size="sm"
              variant="ghost"
              title={t("mcp.editor.remove")}
              data-testid={"mcp-record-" + props.field + "-remove-" + String(index)}
              {...(props.disabled === true ? { disabled: true } : {})}
              onClick={() => commit(list.filter((_, at) => at !== index))}
            >
              ×
            </Button>
          </div>
        ))}
        <div className={styles.control}>
          <Button
            size="sm"
            variant="outline"
            data-testid={"mcp-record-" + props.field + "-add"}
            {...(props.disabled === true ? { disabled: true } : {})}
            onClick={() => commit([...list, { key: "", value: "" }])}
          >
            {t("mcp.editor.add")}
          </Button>
          {props.secret === true && props.onReveal !== undefined ? (
            <Button
              size="sm"
              variant="outline"
              title={t("mcp.editor.revealTitle")}
              data-testid={"mcp-reveal-" + props.field}
              {...(props.revealBusy === true ? { disabled: true } : {})}
              onClick={props.onReveal}
            >
              {props.revealBusy === true
                ? t("mcp.editor.revealing")
                : props.revealed === true
                  ? t("mcp.editor.hide")
                  : t("mcp.editor.reveal")}
            </Button>
          ) : null}
          {props.secret === true && props.revealed !== true && list.length > 0 ? (
            <span className={styles.small} data-testid={"mcp-hidden-" + props.field}>
              {t("mcp.editor.hidden") + " · " + HIDDEN_VALUE}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
