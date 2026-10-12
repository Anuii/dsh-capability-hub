/**
 * 服务器表单（D-C2 的「手动填写」+ D-C3 的「高级区覆盖全部字段」+ D-C4 的 check-command）。
 *
 * UI-B 起这个表单渲染在**详情抽屉里**（新建时是同一个抽屉），所以它自己没有外壳，
 * 只有两节内容与一行操作：基础 / 高级设置（**默认折叠**）+ 保存。
 *
 * 草稿、校验、检查命令、显示遮罩值与保存的流程都在 server-form-store.ts（可单测）；
 * 这里只把它们渲染成字段。高级区**默认折叠**（UI-DESIGN §5）。
 */

import * as React from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { Banner, Section } from "../../kit/index.ts";
import { serverFormApi } from "./data.ts";
import { createServerFormStore } from "./server-form-store.ts";
import { ArrayField, FieldShell, NumberField, RecordField, SelectField, SwitchField, TextField } from "./fields.tsx";
import { draftHas, draftMeta, draftValue, errorsFor as errorsOf, numericText, type ServerDraft } from "./draft.ts";
import { lifecycleLabel } from "./view-model.ts";
import { useStoreState } from "../../kit/index.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { ServerView, Transport } from "../contract/config.ts";
import { LIFECYCLES } from "../rules/server.ts";
import { isPlainObject } from "../rules/values.ts";

export interface ServerFormProps {
  /** 被编辑服务器的原名；新建时省略。 */
  originalName?: string;
  initial: ServerDraft;
  /** 现有服务器名（重名校验用；调用方应包含全部名字）。 */
  existingNames: readonly string[];
  onSaved(server: ServerView, warnings: readonly string[]): void;
  onCancel(): void;
  onSwitchToJson(draft: ServerDraft): void;
  showToast(text: string): void;
}

/** 需要展开高级区的字段（除基础区之外）。 */
const ADVANCED_FIELDS: readonly string[] = [
  "envFrom",
  "allowEmpty",
  "envFromTimeoutMs",
  "toolCallTimeoutMs",
  "lifecycle",
  "idleTimeout",
  "includeTools",
  "excludeTools",
  "disabled",
  "debug",
  "meta",
];

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function stringMapOf(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) out[key] = textOf(item);
  return out;
}

function stringListOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** meta 里某个子字段是否已设置。 */
function metaHas(draft: ServerDraft, key: string): boolean {
  const meta = draftMeta(draft);
  return meta[key] !== undefined && meta[key] !== null && meta[key] !== "";
}

export function ServerForm(props: ServerFormProps): React.ReactElement {
  const namesRef = React.useRef(props.existingNames);
  namesRef.current = props.existingNames;
  const [store] = React.useState(() =>
    createServerFormStore(serverFormApi, {
      initial: props.initial,
      ...(props.originalName === undefined ? {} : { originalName: props.originalName }),
      existingNames: () => namesRef.current,
    }),
  );
  const s = useStoreState(store.state);
  const { draft, touched, showAll, syncToken, revealed, revealBusy } = s;
  const transport: Transport = draft.values.transport === "streamable-http" ? "streamable-http" : "stdio";
  // errors() 读的是草稿、宿主错误与现有服务器名，这三样一变就重算
  const groups = React.useMemo(() => store.errors(), [store, draft, s.serverErrors, props.existingNames]);

  const setFieldValue = (field: string, value: unknown): void => store.setField(field, value);
  const doReveal = (field: "env" | "headers"): void => {
    void store.reveal(field).then((ok) => {
      if (ok) props.showToast(t("mcp.toast.revealed"));
    });
  };
  const save = (acknowledgeMissingCommand: boolean): void => {
    void store.save(acknowledgeMissingCommand).then((result) => {
      if (result !== undefined) props.onSaved(result.server, result.warnings);
    });
  };

  /** 通用字段：外壳 + 编辑器。 */
  const field = (
    id: string,
    label: string,
    hint: string,
    control: React.ReactNode,
    opts: { required?: boolean; reset?: boolean } = {},
  ): React.ReactElement => (
    <FieldShell
      key={id}
      field={id}
      label={label}
      hint={hint}
      set={draftHas(draft, id)}
      {...(opts.required === true ? { required: true } : {})}
      errors={errorsOf(groups, id)}
      showErrors={showAll || touched.has(id)}
      {...(opts.reset === false ? {} : { onReset: () => store.resetField(id) })}
    >
      {control}
    </FieldShell>
  );

  const metaField = (key: string, label: string, hint: string, control: React.ReactNode): React.ReactElement => (
    <FieldShell
      key={"meta." + key}
      field={"meta." + key}
      label={label}
      hint={hint}
      set={metaHas(draft, key)}
      errors={errorsOf(groups, "meta." + key)}
      showErrors={showAll || touched.has("meta." + key)}
      onReset={() => store.resetMeta(key)}
    >
      {control}
    </FieldShell>
  );

  const mapField = (id: string, secret: boolean): React.ReactElement => (
    <RecordField
      field={id}
      entries={stringMapOf(draftValue(draft, id))}
      {...(secret
        ? {
            secret: true,
            revealed: revealed.has(id),
            revealBusy,
            ...(props.originalName === undefined ? {} : { onReveal: () => doReveal(id === "env" ? "env" : "headers") }),
          }
        : {})}
      syncToken={syncToken}
      onChange={(entries: Record<string, string>) => setFieldValue(id, entries)}
    />
  );

  const arrayField = (id: string, placeholder: string): React.ReactElement => (
    <ArrayField
      field={id}
      items={stringListOf(draftValue(draft, id))}
      placeholder={placeholder}
      syncToken={syncToken}
      onChange={(items: string[]) => setFieldValue(id, items)}
    />
  );

  const numberField = (id: string, placeholder: string): React.ReactElement => (
    <NumberField
      field={id}
      value={numericText(draftValue(draft, id))}
      placeholder={placeholder}
      onChange={(text: string) => setFieldValue(id, text)}
    />
  );

  const commandControl = (
    <div className={styles.control}>
      <div className={styles.controlGrow}>
        <TextField
          field="command"
          value={textOf(draftValue(draft, "command"))}
          placeholder="node"
          onChange={(value: string) => setFieldValue("command", value)}
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        data-testid="mcp-command-check"
        {...(s.checking ? { disabled: true } : {})}
        onClick={() => void store.checkCommand()}
      >
        {s.checking ? t("mcp.command.checking") : t("mcp.command.check")}
      </Button>
    </div>
  );

  const commandResult = (
    <div className={styles.commandBox}>
      {s.commandCheck === undefined ? (
        <p className={styles.hint}>{t("mcp.command.check")}</p>
      ) : s.commandCheck.found ? (
        <p className={styles.commandOk} data-testid="mcp-command-result">
          {t("mcp.command.found", { path: s.commandCheck.resolvedPath ?? s.commandCheck.command })}
        </p>
      ) : (
        <p className={styles.commandWarn} data-testid="mcp-command-result">
          {t("mcp.command.missing", { command: s.commandCheck.command })}
        </p>
      )}
    </div>
  );

  const advancedSet = ADVANCED_FIELDS.some((id) =>
    id === "meta" ? Object.keys(draftMeta(draft)).length > 0 : draftHas(draft, id),
  );

  const errorCount = Object.values(groups).reduce((total, list) => total + list.length, 0);

  return (
    <div className={styles.form} data-testid="mcp-form">
      <Section title={t("mcp.form.basic")} testId="mcp-form-basic">
        <div className={styles.formFields}>
          {field(
            "serverName",
            t("mcp.field.serverName"),
            t("mcp.hint.serverName"),
            <TextField
              field="serverName"
              value={textOf(draftValue(draft, "serverName"))}
              placeholder="my-server"
              onChange={(value: string) => setFieldValue("serverName", value)}
            />,
            { required: true, reset: false },
          )}
          {field(
            "transport",
            t("mcp.field.transport"),
            t("mcp.hint.transport"),
            <SelectField
              field="transport"
              value={transport}
              options={[
                { value: "stdio", label: "stdio" },
                { value: "streamable-http", label: "streamable-http" },
              ]}
              onChange={(next: string) => store.setTransport(next === "streamable-http" ? "streamable-http" : "stdio")}
            />,
            { required: true, reset: false },
          )}
          {transport === "stdio"
            ? field("command", t("mcp.field.command"), t("mcp.hint.command"), commandControl, { required: true })
            : null}
          {transport === "stdio" ? commandResult : null}
          {transport === "stdio"
            ? field("args", t("mcp.field.args"), t("mcp.hint.args"), arrayField("args", "-y"))
            : null}
          {transport === "stdio"
            ? field(
                "cwd",
                t("mcp.field.cwd"),
                t("mcp.hint.cwd"),
                <TextField
                  field="cwd"
                  value={textOf(draftValue(draft, "cwd"))}
                  onChange={(value: string) => setFieldValue("cwd", value)}
                />,
              )
            : null}
          {transport === "stdio" ? field("env", t("mcp.field.env"), t("mcp.hint.env"), mapField("env", true)) : null}
          {transport === "streamable-http"
            ? field(
                "url",
                t("mcp.field.url"),
                t("mcp.hint.url"),
                <TextField
                  field="url"
                  value={textOf(draftValue(draft, "url"))}
                  placeholder="https://example.com/mcp"
                  onChange={(value: string) => setFieldValue("url", value)}
                />,
                { required: true },
              )
            : null}
          {transport === "streamable-http"
            ? field("headers", t("mcp.field.headers"), t("mcp.hint.headers"), mapField("headers", true))
            : null}
          {s.revealError === undefined ? null : (
            <p className={styles.fieldError} data-testid="mcp-reveal-error">
              {s.revealError}
            </p>
          )}
        </div>
      </Section>
      <Section
        title={t("mcp.form.advanced")}
        collapsible
        defaultCollapsed
        testId="mcp-form-advanced"
        end={
          advancedSet ? (
            <span className={styles.small} data-testid="mcp-advanced-set">
              {t("mcp.form.set")}
            </span>
          ) : undefined
        }
      >
        <div className={styles.formFields} data-testid="mcp-advanced">
          {transport === "stdio"
            ? field("envFrom", t("mcp.field.envFrom"), t("mcp.hint.envFrom"), mapField("envFrom", false))
            : null}
          {transport === "stdio"
            ? field(
                "allowEmpty",
                t("mcp.field.allowEmpty"),
                t("mcp.hint.allowEmpty"),
                arrayField("allowEmpty", "MY_VAR"),
              )
            : null}
          {transport === "stdio"
            ? field(
                "envFromTimeoutMs",
                t("mcp.field.envFromTimeoutMs"),
                t("mcp.hint.envFromTimeoutMs", { value: 10000 }),
                numberField("envFromTimeoutMs", "10000"),
              )
            : null}
          {field(
            "toolCallTimeoutMs",
            t("mcp.field.toolCallTimeoutMs"),
            t("mcp.hint.toolCallTimeoutMs", { value: 60000 }),
            numberField("toolCallTimeoutMs", "60000"),
          )}
          {field(
            "lifecycle",
            t("mcp.field.lifecycle"),
            t("mcp.hint.lifecycle"),
            <SelectField
              field="lifecycle"
              value={textOf(draftValue(draft, "lifecycle")) === "" ? "lazy" : textOf(draftValue(draft, "lifecycle"))}
              options={LIFECYCLES.map((item) => ({ value: item, label: lifecycleLabel(item) }))}
              onChange={(value: string) => setFieldValue("lifecycle", value)}
            />,
          )}
          {field(
            "idleTimeout",
            t("mcp.field.idleTimeout"),
            t("mcp.hint.idleTimeout"),
            numberField("idleTimeout", "10"),
          )}
          {field(
            "includeTools",
            t("mcp.field.includeTools"),
            t("mcp.hint.includeTools"),
            arrayField("includeTools", "tool-name"),
          )}
          {field(
            "excludeTools",
            t("mcp.field.excludeTools"),
            t("mcp.hint.excludeTools"),
            arrayField("excludeTools", "tool-name"),
          )}
          {field(
            "disabled",
            t("mcp.field.disabled"),
            t("mcp.hint.disabled"),
            <SwitchField
              field="disabled"
              checked={draftValue(draft, "disabled") === true}
              label={t("mcp.field.disabled")}
              onChange={(next: boolean) => setFieldValue("disabled", next)}
            />,
          )}
          {field(
            "debug",
            t("mcp.field.debug"),
            t("mcp.hint.debug"),
            <SwitchField
              field="debug"
              checked={draftValue(draft, "debug") === true}
              label={t("mcp.field.debug")}
              onChange={(next: boolean) => setFieldValue("debug", next)}
            />,
          )}
          {metaField(
            "description",
            t("mcp.field.meta.description"),
            t("mcp.hint.meta.description"),
            <TextField
              field="meta.description"
              value={textOf(draftMeta(draft).description)}
              onChange={(value: string) => store.setMeta("description", value)}
            />,
          )}
          {metaField(
            "tags",
            t("mcp.field.meta.tags"),
            t("mcp.hint.meta.tags"),
            <ArrayField
              field="meta.tags"
              items={stringListOf(draftMeta(draft).tags)}
              placeholder="标签"
              syncToken={syncToken}
              onChange={(items: string[]) => store.setMeta("tags", items)}
            />,
          )}
          {metaField(
            "homepage",
            t("mcp.field.meta.homepage"),
            t("mcp.hint.meta.homepage"),
            <TextField
              field="meta.homepage"
              value={textOf(draftMeta(draft).homepage)}
              placeholder="https://example.com"
              onChange={(value: string) => store.setMeta("homepage", value)}
            />,
          )}
        </div>
      </Section>
      {s.formError === undefined ? null : (
        <Banner tone="danger" testId="mcp-form-error">
          {s.formError}
        </Banner>
      )}
      {s.serverErrors.length === 0 ? null : (
        <Banner tone="danger" testId="mcp-form-server-errors">
          {t("mcp.form.serverErrors", { count: s.serverErrors.length }) + " " + t("mcp.form.unknownField")}
          <ul className={styles.serverErrors}>
            {s.serverErrors.map((error, index) => (
              <li key={index} className={styles.serverErrorItem}>
                {error.path + "：" + error.message}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {s.commandWarning === undefined ? null : (
        <Banner tone="warn" testId="mcp-command-warning">
          {s.commandWarning}
        </Banner>
      )}
      <div className={styles.actions}>
        <Button
          variant="primary"
          data-testid="mcp-form-save"
          {...(s.saving ? { disabled: true } : {})}
          onClick={() => save(false)}
        >
          {s.saving ? t("mcp.saving") : t("mcp.form.save")}
        </Button>
        {s.commandWarning === undefined ? null : (
          <Button
            variant="outline"
            data-testid="mcp-form-save-anyway"
            {...(s.saving ? { disabled: true } : {})}
            onClick={() => save(true)}
          >
            {t("mcp.form.saveAnyway")}
          </Button>
        )}
        <Button
          data-testid="mcp-form-to-json"
          {...(s.saving ? { disabled: true } : {})}
          onClick={() => props.onSwitchToJson(draft)}
        >
          {t("mcp.form.toJson")}
        </Button>
        <Button data-testid="mcp-form-cancel" onClick={props.onCancel}>
          {t("mcp.cancel")}
        </Button>
        {showAll && errorCount > 0 ? (
          <span className={styles.small} data-testid="mcp-form-error-count">
            {t("mcp.form.errorCount", { count: errorCount })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
