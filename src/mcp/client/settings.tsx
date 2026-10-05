/**
 * 全局设置（UI-DESIGN §5：抽屉）：idleTimeout / outputGuard / failureBackoffMs。
 * 与服务器字段同一套规则（D-C1）：只保存改过的项，「恢复默认」= 从提交体里去掉。
 */

import * as React from "react";
import { Button, Input, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import { Banner } from "../../kit/index.ts";
import { updateSettings } from "./data.ts";
import {
  SETTINGS_DEFAULTS,
  errorMessage,
  fieldErrorsOf,
  groupErrors,
  numericText,
  settingsDraftFrom,
  settingsHas,
  settingsToSubmit,
  validateSettingsDraft,
  withSetting,
  withoutSetting,
  type SettingsDraft,
} from "./model.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { McpSettings } from "../contract/config.ts";

export interface SettingsPanelProps {
  settings: McpSettings;
  settingsSet: readonly string[];
  onSaved(settings: McpSettings, settingsSet: readonly string[]): void;
}

export function SettingsPanel(props: SettingsPanelProps): React.ReactElement {
  const [draft, setDraft] = React.useState<SettingsDraft>(() => settingsDraftFrom(props.settings, props.settingsSet));
  const [busy, setBusy] = React.useState<boolean>(false);
  const [message, setMessage] = React.useState<string | undefined>(undefined);
  const [errors, setErrors] = React.useState<string[]>([]);

  const groups = React.useMemo(() => groupErrors(validateSettingsDraft(draft)), [draft]);

  const setValue = (field: string, value: unknown): void => {
    setDraft((prev) => withSetting(prev, field, value));
    setMessage(undefined);
  };

  const reset = (field: string): void => {
    setDraft((prev) => withoutSetting(prev, field));
    setMessage(undefined);
  };

  const save = (): void => {
    const local = validateSettingsDraft(draft);
    if (local.length > 0) {
      setErrors(local.map((error) => error.message));
      return;
    }
    setErrors([]);
    setBusy(true);
    void updateSettings(settingsToSubmit(draft))
      .then(
        (result) => {
          setMessage(t("mcp.settings.saved"));
          props.onSaved(result.settings, result.settingsSet);
        },
        (error: unknown) => {
          const details = fieldErrorsOf(error);
          setErrors(
            details.length > 0
              ? details.map((item) => item.message)
              : [t("mcp.settings.saveFailed", { message: errorMessage(error) })],
          );
        },
      )
      .finally(() => setBusy(false));
  };

  const row = (id: string, label: string, hint: string, control: React.ReactNode): React.ReactElement => (
    <div className={styles.settingRow} data-testid={"mcp-setting-" + id}>
      <div className={styles.fieldHead}>
        <span className={styles.fieldLabel}>{label}</span>
        <span className={styles.fieldBadges}>
          {settingsHas(draft, id) ? (
            <Button size="sm" variant="ghost" data-testid={"mcp-settings-reset-" + id} onClick={() => reset(id)}>
              {t("mcp.form.reset")}
            </Button>
          ) : null}
        </span>
      </div>
      <p className={styles.hint}>{hint}</p>
      <div className={styles.control}>{control}</div>
      {(groups[id] ?? []).map((text, index) => (
        <p key={index} className={styles.fieldError} data-testid={"mcp-settings-error-" + id}>
          {text}
        </p>
      ))}
    </div>
  );

  return (
    <div className={styles.settings} data-testid="mcp-settings">
      <p className={styles.note}>{t("mcp.settings.hint")}</p>
      {row(
        "idleTimeout",
        t("mcp.settings.idleTimeout"),
        t("mcp.settings.idleTimeoutHint", { value: SETTINGS_DEFAULTS.idleTimeoutMin }),
        <Input
          value={numericText(draft.values.idleTimeout)}
          placeholder={String(SETTINGS_DEFAULTS.idleTimeoutMin)}
          data-testid="mcp-settings-input-idleTimeout"
          onChange={(event: { target: { value: string } }) => setValue("idleTimeout", event.target.value)}
        />,
      )}
      {row(
        "outputGuard.enabled",
        t("mcp.settings.outputGuard"),
        t("mcp.settings.outputGuardHint", {
          bytes: SETTINGS_DEFAULTS.outputGuard.maxBytes,
          lines: SETTINGS_DEFAULTS.outputGuard.maxLines,
        }),
        <Switch
          checked={
            draft.values["outputGuard.enabled"] === undefined
              ? props.settings.outputGuard.enabled
              : draft.values["outputGuard.enabled"] === true
          }
          label={t("mcp.settings.outputGuardEnabled")}
          onChange={(next: boolean) => setValue("outputGuard.enabled", next)}
        />,
      )}
      {row(
        "outputGuard.maxBytes",
        t("mcp.settings.maxBytes"),
        t("mcp.settings.maxBytesHint", { value: SETTINGS_DEFAULTS.outputGuard.maxBytes }),
        <Input
          value={numericText(draft.values["outputGuard.maxBytes"])}
          placeholder={String(SETTINGS_DEFAULTS.outputGuard.maxBytes)}
          data-testid="mcp-settings-input-outputGuard-maxBytes"
          onChange={(event: { target: { value: string } }) => setValue("outputGuard.maxBytes", event.target.value)}
        />,
      )}
      {row(
        "outputGuard.maxLines",
        t("mcp.settings.maxLines"),
        t("mcp.settings.maxLinesHint", { value: SETTINGS_DEFAULTS.outputGuard.maxLines }),
        <Input
          value={numericText(draft.values["outputGuard.maxLines"])}
          placeholder={String(SETTINGS_DEFAULTS.outputGuard.maxLines)}
          data-testid="mcp-settings-input-outputGuard-maxLines"
          onChange={(event: { target: { value: string } }) => setValue("outputGuard.maxLines", event.target.value)}
        />,
      )}
      {row(
        "failureBackoffMs",
        t("mcp.settings.failureBackoffMs"),
        t("mcp.settings.failureBackoffHint", { value: SETTINGS_DEFAULTS.failureBackoffMs }),
        <Input
          value={numericText(draft.values.failureBackoffMs)}
          placeholder={String(SETTINGS_DEFAULTS.failureBackoffMs)}
          data-testid="mcp-settings-input-failureBackoffMs"
          onChange={(event: { target: { value: string } }) => setValue("failureBackoffMs", event.target.value)}
        />,
      )}
      {errors.length === 0 ? null : (
        <Banner tone="danger" testId="mcp-settings-errors">
          {errors.join("；")}
        </Banner>
      )}
      <div className={styles.actions}>
        <Button variant="primary" data-testid="mcp-settings-save" disabled={busy} onClick={save}>
          {busy ? t("mcp.saving") : t("mcp.settings.save")}
        </Button>
        {message === undefined ? null : (
          <span className={styles.small} data-testid="mcp-settings-message">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
