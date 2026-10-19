/**
 * 从 Official Registry 搜索并一键添加服务器（0.9.0 的第二种添加方式，另一种是粘贴 JSON）。
 *
 * 三个状态面，全部在这一个视图里：
 *   1. 搜索态：输入框（回车也搜索）+「搜索」；registry 的 search 实测很慢（10–60 秒），
 *      所以请求期间按钮显示「加载中…」并禁用，旁边一行「正在搜索…」，失败显示宿主给的中文错误 +「重试」；
 *   2. 结果态：每行 = 展示名 + 等宽「registry 名 · 版本」+ 接入方式标记 +「需要填 N 个变量」，点行进预览；
 *   3. 预览态：调详情 → 能生成时给「服务器名（默认宿主建议名）+ 逐个环境变量 + 只读 JSON + 保存」，
 *      不能生成时只说明原因（**没有保存按钮**）。
 *
 * 纯逻辑（行视图、名字校验、env 表单初值与「能不能保存」、提交体）在 ./pure.ts，可被 node:test 直接测。
 * 保存仍走既有的 POST mcp/servers/upsert（data.ts 的 upsertServer），服务器名用输入框的值覆盖宿主建议名。
 * 网络只经 data.ts 的接口封装，本文件里不出现 fetch。
 */

import * as React from "react";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, Banner, ListGroup, ListRow, ListSurface } from "../../../kit/index.ts";
import { errorCodeOf, fieldErrorsOf } from "../../../platform/client/api.ts";
import { errorText } from "../../../shared/error-text.ts";
import { fetchRegistryDetail, searchRegistry, upsertServer } from "../data.ts";
import { styles } from "../styles.ts";
import { t } from "../strings.ts";
import {
  buildSubmitConfig,
  envFieldViews,
  initialEnvValues,
  nameIssueText,
  previewConfigText,
  provenanceNote,
  registryRowView,
  saveGate,
  serverNameIssue,
} from "./pure.ts";
import type { RegistryDetail, RegistryItem } from "../../contract/registry.ts";
import type { DataProvenance } from "../../../shared/network.ts";

export interface RegistrySearchViewProps {
  /** 当前配置里的服务器名（重名判定用）。 */
  existingNames: readonly string[];
  /** 保存成功时调用（外壳负责刷新列表与汇总提示）。 */
  onSaved(names: readonly string[]): void;
  showToast(text: string, tone?: "success"): void;
}

interface SaveResult {
  ok: boolean;
  text: string;
}

/** 预览里那条 server 是不是能一键生成（有 raw 且没有 unsupported）。 */
function generatable(detail: RegistryDetail | undefined): boolean {
  return detail !== undefined && detail.raw !== undefined && detail.unsupported === undefined;
}

export function RegistrySearchView(props: RegistrySearchViewProps): React.ReactElement {
  const [query, setQuery] = React.useState<string>("");
  const [searching, setSearching] = React.useState<boolean>(false);
  const [searchError, setSearchError] = React.useState<string | undefined>(undefined);
  const [items, setItems] = React.useState<RegistryItem[] | undefined>(undefined);
  const [nextCursor, setNextCursor] = React.useState<string | undefined>(undefined);
  /** 这批结果是怎么来的（D-B19）：cache 标「缓存于 X · 点「重试」刷新」、mirror 标「经镜像」、direct 不显示 */
  const [provenance, setProvenance] = React.useState<DataProvenance | undefined>(undefined);
  const [moreLoading, setMoreLoading] = React.useState<boolean>(false);
  /** 上一次真正发出去的搜索词（重试 / 加载更多用它，而不是输入框里后来改过的内容）。 */
  const [lastQuery, setLastQuery] = React.useState<string | undefined>(undefined);
  /** 失败的那次请求用的游标：有游标就在已有结果后面重试，没有就重开一次搜索。 */
  const [retryCursor, setRetryCursor] = React.useState<string | undefined>(undefined);
  const [preview, setPreview] = React.useState<RegistryItem | undefined>(undefined);
  const [detail, setDetail] = React.useState<RegistryDetail | undefined>(undefined);
  const [detailLoading, setDetailLoading] = React.useState<boolean>(false);
  const [detailError, setDetailError] = React.useState<string | undefined>(undefined);
  const [nameDraft, setNameDraft] = React.useState<string>("");
  const [envValues, setEnvValues] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState<boolean>(false);
  const [saveResult, setSaveResult] = React.useState<SaveResult | undefined>(undefined);
  /** 已经保存成功的名字：保存成功后按钮锁住，直到用户又改了名字或变量。 */
  const [savedName, setSavedName] = React.useState<string | undefined>(undefined);

  const runSearch = (text: string, cursor?: string): void => {
    const keyword = text.trim();
    if (keyword === "") {
      props.showToast(t("mcp.registry.needQuery"));
      return;
    }
    const append = cursor !== undefined;
    setLastQuery(keyword);
    setSearchError(undefined);
    if (append) setMoreLoading(true);
    else {
      setSearching(true);
      setItems(undefined);
      setNextCursor(undefined);
      setProvenance(undefined);
      // 重新搜索就离开预览，免得旧详情挂在新结果上
      setPreview(undefined);
      setDetail(undefined);
      setDetailError(undefined);
      setSaveResult(undefined);
      setSavedName(undefined);
    }
    void searchRegistry(keyword, cursor).then(
      (payload) => {
        setSearching(false);
        setMoreLoading(false);
        setRetryCursor(undefined);
        setNextCursor(payload.nextCursor);
        // 逐页刷新：当前这一屏就以最后一页的来源为准（同一关键词通常一致）
        setProvenance(payload.provenance);
        setItems((current) => (append ? [...(current ?? []), ...payload.items] : payload.items));
      },
      (error: unknown) => {
        setSearching(false);
        setMoreLoading(false);
        // 追加失败不动已有结果，只把错误挂出来；重试会重发同一个游标
        setRetryCursor(cursor);
        setSearchError(errorText(error));
      },
    );
  };

  const openPreview = (item: RegistryItem): void => {
    setPreview(item);
    setDetail(undefined);
    setDetailError(undefined);
    setDetailLoading(true);
    setSaveResult(undefined);
    setSavedName(undefined);
    setNameDraft("");
    setEnvValues({});
    void fetchRegistryDetail(item.name).then(
      (payload) => {
        setDetailLoading(false);
        setDetail(payload);
        setNameDraft(payload.raw?.serverName ?? "");
        setEnvValues(initialEnvValues(payload.item, payload.raw));
      },
      (error: unknown) => {
        setDetailLoading(false);
        setDetailError(errorText(error));
      },
    );
  };

  const backToResults = (): void => {
    setPreview(undefined);
    setDetail(undefined);
    setDetailError(undefined);
    setSaveResult(undefined);
    setSavedName(undefined);
  };

  /** 用户又改了东西：保存成功那一条提示与「已保存」锁都失效。 */
  const touch = (): void => {
    setSaveResult(undefined);
    setSavedName(undefined);
  };

  const save = (): void => {
    if (detail === undefined || saving) return;
    if (!saveGate({ detail, name: nameDraft, existingNames: props.existingNames, envValues }).ok) return;
    const body = buildSubmitConfig(detail, nameDraft, envValues);
    if (body === undefined) return;
    setSaving(true);
    setSaveResult(undefined);
    void upsertServer(undefined, body).then(
      (result) => {
        setSaving(false);
        const extra = result.warnings.length > 0 ? " · " + result.warnings.join("；") : "";
        setSavedName(result.server.serverName);
        setSaveResult({ ok: true, text: t("mcp.registry.saved", { name: result.server.serverName }) + extra });
        // 汇总提示由外壳出（与粘贴 JSON 的批量保存同一套）
        props.onSaved([result.server.serverName]);
      },
      (error: unknown) => {
        setSaving(false);
        const details = fieldErrorsOf(error);
        const detailText =
          details.length > 0 ? "（" + details.map((entry) => entry.path + " " + entry.message).join("；") + "）" : "";
        // 409 = 同名冲突：说清楚是名字的问题，并提示改名，而不是一句泛泛的失败
        setSaveResult({
          ok: false,
          text:
            errorCodeOf(error) === "CONFLICT"
              ? t("mcp.registry.saveConflict", { name: nameDraft })
              : t("mcp.registry.saveFailed", { message: errorText(error) }) + detailText,
        });
      },
    );
  };

  /* ---------------- 预览态 ---------------- */

  if (preview !== undefined) {
    const row = registryRowView(preview);
    const nameIssue = serverNameIssue(nameDraft, props.existingNames);
    const gate = saveGate({ detail, name: nameDraft, existingNames: props.existingNames, envValues });
    const fields = generatable(detail) && detail !== undefined ? envFieldViews(preview, detail.raw, envValues) : [];
    const configText = previewConfigText(detail, nameDraft, envValues);
    const saved = savedName !== undefined && savedName === nameDraft;
    const showNameIssue = nameIssue !== undefined && !saved;
    return (
      <div className={styles.intakeBody} data-testid="mcp-registry-preview">
        <div className={styles.intakeToolbar}>
          <Button size="sm" variant="outline" data-testid="mcp-registry-back" onClick={backToResults}>
            {t("mcp.registry.back")}
          </Button>
        </div>
        <div className={styles.registryHead}>
          <p className={styles.registryTitle} data-testid="mcp-registry-heading">
            {row.heading}
          </p>
          <p className={styles.registryMono} data-testid="mcp-registry-name-plain">
            {preview.name}
          </p>
          <p className={styles.small} data-testid="mcp-registry-meta">
            {t("mcp.registry.version", { version: preview.version }) +
              (row.kindLabels.length === 0 ? "" : " · " + row.kindLabels.join(" · "))}
          </p>
        </div>
        {row.description === undefined ? null : (
          <p className={styles.intakeHint} data-testid="mcp-registry-description">
            {row.description}
          </p>
        )}
        {detailLoading ? (
          <p className={styles.intakeHint} data-testid="mcp-registry-detail-loading">
            {t("mcp.registry.detailLoading")}
          </p>
        ) : null}
        {detailError === undefined ? null : (
          <Banner
            tone="danger"
            testId="mcp-registry-detail-error"
            action={{
              label: t("mcp.registry.retry"),
              onClick: () => openPreview(preview),
              testId: "mcp-registry-detail-retry",
            }}
          >
            {t("mcp.registry.detailFailed", { message: detailError })}
          </Banner>
        )}
        {detail !== undefined && detail.unsupported !== undefined ? (
          <Banner tone="warn" testId="mcp-registry-unsupported">
            {t("mcp.registry.unsupported", { message: detail.unsupported })}
          </Banner>
        ) : null}
        {detail === undefined || detail.notes.length === 0 ? null : (
          <div className={styles.stack} data-testid="mcp-registry-notes">
            <p className={styles.fieldLabel}>{t("mcp.registry.notes")}</p>
            <ul className={styles.warnList}>
              {detail.notes.map((note, index) => (
                <li key={index} className={styles.warnItem} data-testid={"mcp-registry-note-" + index}>
                  {note}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!generatable(detail) || detail === undefined ? null : (
          <React.Fragment>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="mcp-registry-name">
                {t("mcp.registry.nameLabel")}
              </label>
              <Input
                id="mcp-registry-name"
                data-testid="mcp-registry-name"
                value={nameDraft}
                disabled={saving}
                onChange={(event: { target: { value: string } }) => {
                  setNameDraft(event.target.value);
                  touch();
                }}
              />
              {showNameIssue ? (
                <p className={styles.fieldError} data-testid="mcp-registry-name-error">
                  {nameIssueText(nameIssue, nameDraft)}
                </p>
              ) : (
                <p className={styles.hint}>{t("mcp.registry.nameHint")}</p>
              )}
            </div>
            {fields.length === 0 ? null : (
              <div className={styles.stack} data-testid="mcp-registry-env">
                <p className={styles.fieldLabel}>{t("mcp.registry.envTitle")}</p>
                {fields.map((field) => (
                  <div className={styles.field} key={field.key}>
                    <label className={styles.fieldLabel} htmlFor={"mcp-registry-env-" + field.key}>
                      {field.required
                        ? field.key + " · " + t("mcp.registry.envRequired")
                        : field.key + " · " + t("mcp.registry.envOptional")}
                    </label>
                    <Input
                      id={"mcp-registry-env-" + field.key}
                      data-testid={"mcp-registry-env-" + field.key}
                      value={field.value}
                      placeholder={field.placeholder}
                      disabled={saving}
                      onChange={(event: { target: { value: string } }) => {
                        setEnvValues((current) => ({ ...current, [field.key]: event.target.value }));
                        touch();
                      }}
                    />
                    {!field.missing ? null : (
                      <p className={styles.fieldError} data-testid={"mcp-registry-env-error-" + field.key}>
                        {t("mcp.registry.envMissingOne")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className={styles.field}>
              <p className={styles.fieldLabel}>{t("mcp.registry.configTitle")}</p>
              {/* 只读：这是将要提交的落盘形态（白名单字段 + 界面上的名字与环境变量） */}
              <pre className={styles.jsonPreview} data-testid="mcp-registry-config">
                {configText}
              </pre>
            </div>
            <div className={styles.intakeToolbar}>
              <Button
                variant="primary"
                data-testid="mcp-registry-save"
                disabled={saving || saved || !gate.ok}
                onClick={save}
              >
                {saving ? t("mcp.registry.saving") : t("mcp.registry.save")}
              </Button>
              {gate.missingEnv.length === 0 ? null : (
                <span className={styles.fieldError} data-testid="mcp-registry-blocked">
                  {t("mcp.registry.envMissing", { names: gate.missingEnv.join("、") })}
                </span>
              )}
            </div>
            {saveResult === undefined ? null : (
              <p className={saveResult.ok ? styles.resultOk : styles.resultFail} data-testid="mcp-registry-save-result">
                {saveResult.text}
              </p>
            )}
          </React.Fragment>
        )}
      </div>
    );
  }

  /* ---------------- 搜索态 ---------------- */

  const list = items ?? [];
  const provenanceText = provenanceNote(provenance);
  return (
    <div className={styles.intakeBody} data-testid="mcp-registry">
      <p className={styles.intakeHint}>{t("mcp.registry.hint")}</p>
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="mcp-registry-query">
          {t("mcp.registry.queryLabel")}
        </label>
        <Input
          id="mcp-registry-query"
          data-testid="mcp-registry-query"
          value={query}
          placeholder={t("mcp.registry.placeholder")}
          disabled={searching}
          onChange={(event: { target: { value: string } }) => setQuery(event.target.value)}
          onKeyDown={(event: { key: string; preventDefault(): void }) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            runSearch(query);
          }}
        />
      </div>
      <div className={styles.intakeToolbar}>
        <Button
          variant="primary"
          data-testid="mcp-registry-search"
          disabled={searching}
          onClick={() => runSearch(query)}
        >
          {searching ? t("mcp.registry.loading") : t("mcp.registry.search")}
        </Button>
        {searching ? (
          <span className={styles.small} data-testid="mcp-registry-searching">
            {t("mcp.registry.searching")}
          </span>
        ) : null}
      </div>
      {searchError === undefined ? null : (
        <Banner
          tone="danger"
          testId="mcp-registry-search-error"
          action={{
            label: t("mcp.registry.retry"),
            onClick: () => runSearch(lastQuery ?? query, retryCursor),
            testId: "mcp-registry-search-retry",
          }}
        >
          {t("mcp.registry.searchFailed", { message: searchError })}
        </Banner>
      )}
      {items !== undefined && list.length === 0 && searchError === undefined ? (
        <p className={styles.intakeHint} data-testid="mcp-registry-empty">
          {t("mcp.registry.empty")}
        </p>
      ) : null}
      {list.length === 0 ? null : (
        <React.Fragment>
          <p className={styles.small} data-testid="mcp-registry-count">
            {t("mcp.registry.results", { count: list.length })}
          </p>
          {/* D-B19：来源标注。缓存时给一个「重试」——联网失败但拿到缓存也照样显示结果，不弹错误横幅。 */}
          {provenanceText === undefined ? null : (
            <div className={styles.intakeToolbar} data-testid="mcp-registry-provenance-row">
              <span className={styles.small} data-testid="mcp-registry-provenance">
                {provenanceText}
              </span>
              {provenance?.route !== "cache" ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="mcp-registry-provenance-retry"
                  disabled={searching || moreLoading}
                  onClick={() => runSearch(lastQuery ?? query)}
                >
                  {t("mcp.registry.retry")}
                </Button>
              )}
            </div>
          )}
          <div className={styles.registryResults} data-testid="mcp-registry-results-scroll">
            <ListSurface testId="mcp-registry-results">
              <ListGroup>
                {list.map((item, index) => {
                  const row = registryRowView(item);
                  return (
                    <ListRow
                      key={item.name + "-" + String(index)}
                      testId={"mcp-registry-row-" + index}
                      title={row.heading}
                      subtitle={row.name + " · " + row.version}
                      subtitleMono
                      badges={row.kindLabels.map((label, badgeIndex) => (
                        <Badge key={badgeIndex} tone="neutral">
                          {label}
                        </Badge>
                      ))}
                      {...(row.needsEnv === undefined
                        ? {}
                        : { note: { text: row.needsEnv, testId: "mcp-registry-row-env-" + index } })}
                      onOpen={() => openPreview(item)}
                    />
                  );
                })}
              </ListGroup>
            </ListSurface>
          </div>
        </React.Fragment>
      )}
      {nextCursor === undefined ? null : (
        <div className={styles.intakeToolbar}>
          <Button
            size="sm"
            variant="outline"
            data-testid="mcp-registry-more"
            disabled={moreLoading}
            onClick={() => runSearch(lastQuery ?? query, nextCursor)}
          >
            {moreLoading ? t("mcp.registry.loading") : t("mcp.registry.more")}
          </Button>
        </div>
      )}
    </div>
  );
}
