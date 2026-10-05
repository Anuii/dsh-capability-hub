/**
 * 服务器表单（D-C2 的「手动填写」+ D-C3 的「高级区覆盖全部字段」+ D-C4 的 check-command）。
 *
 * UI-B 起这个表单渲染在**详情抽屉里**（新建时是同一个抽屉），所以它自己没有外壳，
 * 只有两节内容与一行操作：基础 / 高级设置（**默认折叠**）+ 保存。
 *
 * 数据流：
 *   草稿（ServerDraft）→ 本地校验（validateDraft，字段旁立刻出错误）
 *   → check-command（只查 PATH，不执行；找不到就警告，用户点「仍然保存」才继续）
 *   → mcp/validate（服务端裁决，details 按 server.<field> 映射回字段）
 *   → mcp/servers/upsert{ originalName, server } → onSaved()
 *
 * 遮罩（D-C5）：env / headers 的值来自视图，默认就是 ***hidden***；
 * 点「显示」调 reveal 拿明文，只写进本次编辑的组件状态，关闭表单即丢弃。
 */

import * as React from "react";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { Banner, Section } from "../../kit/index.ts";
import { checkCommand, revealServer, upsertServer, validateServer } from "./data.ts";
import { ArrayField, FieldShell, NumberField, RecordField, SelectField, SwitchField, TextField } from "./fields.tsx";
import {
  LIFECYCLES,
  draftHas,
  draftMeta,
  draftToSubmit,
  draftValue,
  errorMessage,
  errorsFor as errorsOf,
  fieldErrorsOf,
  groupErrors,
  isPlainObject,
  lifecycleLabel,
  numericText,
  validateDraft,
  withField,
  withMetaField,
  withoutField,
  type ServerDraft,
} from "./model.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { FieldError, ServerView, Transport } from "../contract/config.ts";

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
  "searchKeywords",
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
  const [draft, setDraft] = React.useState<ServerDraft>(props.initial);
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const [showAll, setShowAll] = React.useState<boolean>(false);
  /** 高级区**默认折叠**（UI-DESIGN §5），要改就点开。 */
  const [advanced, setAdvanced] = React.useState<boolean>(false);
  const [busy, setBusy] = React.useState<boolean>(false);
  const [checking, setChecking] = React.useState<boolean>(false);
  const [commandCheck, setCommandCheck] = React.useState<
    { command: string; found: boolean; resolvedPath?: string } | undefined
  >(undefined);
  const [commandWarning, setCommandWarning] = React.useState<string | undefined>(undefined);
  const [serverErrors, setServerErrors] = React.useState<FieldError[]>([]);
  const [formError, setFormError] = React.useState<string | undefined>(undefined);
  const [revealBusy, setRevealBusy] = React.useState<boolean>(false);
  const [revealError, setRevealError] = React.useState<string | undefined>(undefined);
  const [revealed, setRevealed] = React.useState<ReadonlySet<string>>(() => new Set<string>());
  const [syncToken, setSyncToken] = React.useState<number>(0);

  const transport: Transport = draft.values.transport === "streamable-http" ? "streamable-http" : "stdio";

  const localErrors = React.useMemo(
    () => validateDraft(draft, { existingNames: props.existingNames, originalName: props.originalName }),
    [draft, props.existingNames, props.originalName],
  );
  const groups = React.useMemo(() => {
    const merged = groupErrors(localErrors);
    for (const [field, messages] of Object.entries(groupErrors(serverErrors))) {
      merged[field] = [...(merged[field] ?? []), ...messages];
    }
    return merged;
  }, [localErrors, serverErrors]);

  const touch = (field: string): void => {
    setTouched((prev) => {
      if (prev.has(field)) return prev;
      const next = new Set(prev);
      next.add(field);
      return next;
    });
  };

  const setFieldValue = (field: string, value: unknown): void => {
    setDraft((prev) => withField(prev, field, value));
    touch(field);
  };

  const resetField = (field: string): void => {
    setDraft((prev) => withoutField(prev, field));
    touch(field);
    setSyncToken((token) => token + 1);
    setServerErrors((prev) => prev.filter((error) => error.path !== "server." + field));
  };

  const resetMetaField = (key: string): void => {
    setDraft((prev) => withMetaField(prev, key, undefined));
    touch("meta." + key);
    setSyncToken((token) => token + 1);
  };

  /** 切换传输方式只改这一个字段：与另一种传输相关的字段留在草稿里，切回来还在（提交时按当前传输裁剪）。 */
  const changeTransport = (next: string): void => {
    const value: Transport = next === "streamable-http" ? "streamable-http" : "stdio";
    setDraft((prev) => ({ values: { ...prev.values, transport: value } }));
    touch("transport");
    setSyncToken((token) => token + 1);
  };

  const runCheck = async (): Promise<{ found: boolean; resolvedPath?: string } | undefined> => {
    const command = textOf(draft.values.command).trim();
    if (command === "") return undefined;
    setChecking(true);
    try {
      const cwd = textOf(draft.values.cwd);
      const result = await checkCommand(command, cwd === "" ? undefined : cwd);
      setCommandCheck({
        command,
        found: result.found,
        ...(result.resolvedPath === undefined ? {} : { resolvedPath: result.resolvedPath }),
      });
      return result;
    } catch (error) {
      setFormError(t("mcp.form.saveFailed", { message: errorMessage(error) }));
      return undefined;
    } finally {
      setChecking(false);
    }
  };

  const doReveal = (field: "env" | "headers"): void => {
    const name = props.originalName;
    if (name === undefined) return;
    setRevealBusy(true);
    setRevealError(undefined);
    void revealServer(name)
      .then(
        (view) => {
          const values = field === "env" ? view.env : view.headers;
          setDraft((prev) => withField(prev, field, values));
          setRevealed((prev) => {
            const next = new Set(prev);
            next.add(field);
            return next;
          });
          setSyncToken((token) => token + 1);
          props.showToast(t("mcp.toast.revealed"));
        },
        (error: unknown) => setRevealError(t("mcp.editor.revealFailed", { message: errorMessage(error) })),
      )
      .finally(() => setRevealBusy(false));
  };

  const save = (ackCommand: boolean): void => {
    setShowAll(true);
    setFormError(undefined);
    const errors = validateDraft(draft, { existingNames: props.existingNames, originalName: props.originalName });
    if (errors.length > 0) {
      setServerErrors([]);
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const command = textOf(draft.values.command).trim();
        if (transport === "stdio" && command !== "") {
          const result = await runCheck();
          if (result !== undefined && !result.found) {
            if (!ackCommand) {
              setCommandWarning(t("mcp.command.missing", { command }));
              return;
            }
            setCommandWarning(t("mcp.command.missing", { command }));
          } else {
            setCommandWarning(undefined);
          }
        }
        const payload = draftToSubmit(draft);
        const validated = await validateServer(payload, props.originalName);
        if (validated.errors.length > 0) {
          setServerErrors(validated.errors);
          return;
        }
        const result = await upsertServer(props.originalName, payload);
        setServerErrors([]);
        props.onSaved(result.server, result.warnings);
      } catch (error) {
        setFormError(t("mcp.form.saveFailed", { message: errorMessage(error) }));
        const details = fieldErrorsOf(error);
        if (details.length > 0) setServerErrors(details);
      } finally {
        setBusy(false);
      }
    })();
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
      {...(opts.reset === false ? {} : { onReset: () => resetField(id) })}
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
      onReset={() => resetMetaField(key)}
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
          onChange={(value: string) => {
            setFieldValue("command", value);
            setCommandWarning(undefined);
          }}
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        data-testid="mcp-command-check"
        {...(checking ? { disabled: true } : {})}
        onClick={() => {
          void runCheck();
        }}
      >
        {checking ? t("mcp.command.checking") : t("mcp.command.check")}
      </Button>
    </div>
  );

  const commandResult = (
    <div className={styles.commandBox}>
      {commandCheck === undefined ? (
        <p className={styles.hint}>{t("mcp.command.check")}</p>
      ) : commandCheck.found ? (
        <p className={styles.commandOk} data-testid="mcp-command-result">
          {t("mcp.command.found", { path: commandCheck.resolvedPath ?? commandCheck.command })}
        </p>
      ) : (
        <p className={styles.commandWarn} data-testid="mcp-command-result">
          {t("mcp.command.missing", { command: commandCheck.command })}
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
              onChange={changeTransport}
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
          {revealError === undefined ? null : (
            <p className={styles.fieldError} data-testid="mcp-reveal-error">
              {revealError}
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
          advancedSet && !advanced ? (
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
            "searchKeywords",
            t("mcp.field.searchKeywords"),
            t("mcp.hint.searchKeywords"),
            <RecordField
              field="searchKeywords"
              entries={Object.fromEntries(
                Object.entries(
                  isPlainObject(draftValue(draft, "searchKeywords"))
                    ? (draftValue(draft, "searchKeywords") as Record<string, unknown>)
                    : {},
                ).map(([key, value]) => [key, stringListOf(value).join(", ")]),
              )}
              valuePlaceholder="关键词, 关键词"
              syncToken={syncToken}
              onChange={(entries: Record<string, string>) => {
                const map: Record<string, string[]> = {};
                for (const [key, value] of Object.entries(entries)) {
                  const list = value
                    .split(",")
                    .map((item) => item.trim())
                    .filter((item) => item !== "");
                  if (list.length > 0) map[key] = list;
                }
                setFieldValue("searchKeywords", map);
              }}
            />,
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
              onChange={(value: string) => {
                setDraft((prev) => withMetaField(prev, "description", value));
                touch("meta.description");
              }}
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
              onChange={(items: string[]) => {
                setDraft((prev) => withMetaField(prev, "tags", items));
                touch("meta.tags");
              }}
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
              onChange={(value: string) => {
                setDraft((prev) => withMetaField(prev, "homepage", value));
                touch("meta.homepage");
              }}
            />,
          )}
        </div>
      </Section>
      {formError === undefined ? null : (
        <Banner tone="danger" testId="mcp-form-error">
          {formError}
        </Banner>
      )}
      {serverErrors.length === 0 ? null : (
        <Banner tone="danger" testId="mcp-form-server-errors">
          {t("mcp.form.serverErrors", { count: serverErrors.length }) + " " + t("mcp.form.unknownField")}
          <ul className={styles.serverErrors}>
            {serverErrors.map((error, index) => (
              <li key={index} className={styles.serverErrorItem}>
                {error.path + "：" + error.message}
              </li>
            ))}
          </ul>
        </Banner>
      )}
      {commandWarning === undefined ? null : (
        <Banner tone="warn" testId="mcp-command-warning">
          {commandWarning}
        </Banner>
      )}
      <div className={styles.actions}>
        <Button
          variant="primary"
          data-testid="mcp-form-save"
          {...(busy ? { disabled: true } : {})}
          onClick={() => save(false)}
        >
          {busy ? t("mcp.saving") : t("mcp.form.save")}
        </Button>
        {commandWarning === undefined ? null : (
          <Button
            variant="outline"
            data-testid="mcp-form-save-anyway"
            {...(busy ? { disabled: true } : {})}
            onClick={() => save(true)}
          >
            {t("mcp.form.saveAnyway")}
          </Button>
        )}
        <Button
          data-testid="mcp-form-to-json"
          {...(busy ? { disabled: true } : {})}
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
