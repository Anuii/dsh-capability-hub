/**
 * 预设模板（D-C2 的第二种添加方式）。
 *
 * GET mcp/presets → 卡片列表（标题 / 说明 / 依赖命令是否可用）→ 选中后把模板预填进
 * T4b-1 的表单（外壳负责切换视图），用户可以改完再保存，也可以直接取消——「只预览不保存」
 * 在这条路径上是天然成立的。
 */

import * as React from "react";
import { Button, CodeBlock } from "@deepseek-ai/dsh-client-ui-primitives";
import { Banner, SkeletonRows } from "../../../kit/index.ts";
import { fetchPresets } from "../data.ts";
import { draftFromValues, type ServerDraft } from "../model.ts";
import { styles } from "../styles.ts";
import { t } from "../strings.ts";
import type { PresetView } from "../../contract/config.ts";
import { rawSummary, rawToSubmit } from "./pure.ts";
import { errorText } from "../../../shared/error-text.ts";

export interface PresetViewProps {
  /** 选中模板后把草稿交给外壳（切到表单视图）。 */
  onUsePreset(draft: ServerDraft, preset: PresetView): void;
}

function commandText(preset: PresetView): string {
  const command = preset.server.command;
  if (typeof command !== "string" || command === "") return t("mcp.preset.depends") + "：" + rawSummary(preset.server);
  if (preset.commandFound === false) return t("mcp.preset.commandMissing", { command });
  if (typeof preset.resolvedPath === "string" && preset.resolvedPath !== "")
    return t("mcp.preset.commandFound", { path: preset.resolvedPath });
  return t("mcp.preset.depends") + "：" + rawSummary(preset.server);
}

export function PresetView(props: PresetViewProps): React.ReactElement {
  const [presets, setPresets] = React.useState<PresetView[] | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [expanded, setExpanded] = React.useState<string | undefined>(undefined);

  const load = React.useCallback((): void => {
    setLoading(true);
    setError(undefined);
    void fetchPresets().then(
      (items) => {
        setPresets(items);
        setLoading(false);
      },
      (failure: unknown) => {
        setError(errorText(failure));
        setLoading(false);
      },
    );
  }, []);

  React.useEffect(() => load(), [load]);

  const body = ((): React.ReactElement => {
    if (error !== undefined) {
      return (
        <Banner
          tone="danger"
          testId="mcp-preset-error"
          action={{ label: t("mcp.preset.retry"), onClick: load, testId: "mcp-preset-retry" }}
        >
          {t("mcp.preset.loadFailed", { message: error })}
        </Banner>
      );
    }
    if (presets === undefined || loading) {
      return <SkeletonRows rows={3} testId="mcp-preset-loading" />;
    }
    if (presets.length === 0) {
      return (
        <p className={styles.intakeHint} data-testid="mcp-preset-empty">
          {t("mcp.preset.empty")}
        </p>
      );
    }
    return (
      <ul className={styles.presetList} data-testid="mcp-presets">
        {presets.map((preset) => (
          <li key={preset.id} className={styles.presetCard} data-testid={"mcp-preset-" + preset.id}>
            <p className={styles.presetTitle}>{preset.title}</p>
            <p className={styles.presetDesc}>{preset.description}</p>
            <p className={styles.small} data-testid={"mcp-preset-command-" + preset.id}>
              {commandText(preset)}
            </p>
            <div className={styles.presetFoot}>
              <Button
                variant="primary"
                data-testid={"mcp-preset-use-" + preset.id}
                onClick={() => props.onUsePreset(draftFromValues(rawToSubmit(preset.server)), preset)}
              >
                {t("mcp.preset.use")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid={"mcp-preset-json-" + preset.id}
                onClick={() => setExpanded((current) => (current === preset.id ? undefined : preset.id))}
              >
                {expanded === preset.id ? t("mcp.preset.hideJson") : t("mcp.preset.showJson")}
              </Button>
            </div>
            {expanded === preset.id ? (
              <div className={styles.presetCard} data-testid={"mcp-preset-json-body-" + preset.id}>
                <CodeBlock
                  code={JSON.stringify(rawToSubmit(preset.server), null, 2)}
                  lang="json"
                  showHeader={false}
                  wrap
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    );
  })();

  return (
    <div className={styles.intakeBody} data-testid="mcp-preset-view">
      <p className={styles.intakeHint}>{t("mcp.preset.hint")}</p>
      {body}
    </div>
  );
}
