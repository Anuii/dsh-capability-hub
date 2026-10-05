/**
 * 「添加技能」= 仓库视图（D-B6 / D-B16，UI-DESIGN §3）：宽抽屉 860px。
 *
 * 自上而下：
 *   1. 一个输入框：像仓库地址（owner/name 或 GitHub 链接）就出现分支输入与「浏览」「加入仓库列表」，
 *      否则是「搜索 skills.sh」；搜索结果收在固定高度的框里，可浏览、可把所在仓库加入列表。
 *      临时浏览的结果与安装反馈出现在输入框正下方并自动滚到可见。
 *   2. 仓库列表（默认折叠成一行）：分支 · 子目录 · 扫描状态；悬停浏览 / 编辑 / 移除，编辑就地展开。
 *   3. 汇总发现（主体）：按仓库分组折叠（技能数超过 50 的仓库默认折叠），可按名称、已安装 / 未安装、仓库筛选；
 *      显示上次扫描时间，点「刷新」才联网；第一次没有缓存时自动扫一次；每组分批渲染 200 行。
 *   4. 底部（有勾选时才出现）：安装位置 + 安装；跨仓库的勾选按仓库分组依次安装。
 *
 * 纯逻辑在 discovery-model.ts；所有请求错误都转成界面状态。
 */

import * as React from "react";
import type { FieldError } from "../../../platform/contract/host.ts";
import { Button, Input, Pill } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  Badge,
  Drawer,
  ListFoot,
  ListGroup,
  ListRow,
  ListSurface,
  SkeletonRows,
  Toolbar,
  kit,
} from "../../../kit/index.ts";
import { listSkills } from "../data.ts";
import {
  addRepo,
  browseRepo,
  fetchDiscovery,
  installSkills,
  refreshDiscovery,
  removeRepo,
  searchSkills,
  updateRepo,
} from "./data.ts";
import { reloadSources } from "./cache.ts";
import { installResultText, installSummaryText, installTargetOptions } from "./model.ts";
import {
  DISCOVERY_PAGE,
  INSTALLED_FILTERS,
  discoveredKey,
  discoveryFilterKey,
  filterDiscovered,
  groupDiscovered,
  initialRepoFold,
  inputIntent,
  installPlan,
  installedCounts,
  normalizeRepoInput,
  relativeTime,
  repoConfigText,
  repoExpanded,
  repoScanText,
  shouldAutoScan,
  sliceVisible,
  toggleRepoFold,
  type InstalledFilter,
  type RepoFold,
} from "./discovery-model.ts";
import { errorMessage, fieldErrors } from "../format.ts";
import { styles } from "../styles.ts";
import { t } from "../strings.ts";
import type { RootInfo } from "../../contract/local.ts";
import type {
  BrowseResult,
  DiscoveryRepoView,
  DiscoveryView,
  InstallItemResult,
  InstallTarget,
  SearchResultItem,
} from "../../contract/remote.ts";

/** 仓库行的悬停提示：仓库@分支（+ 预置）。 */
export function repoChipTitle(record: { repo: string; ref?: string; preset: boolean }): string {
  const head = record.ref === undefined || record.ref === "" ? record.repo : record.repo + "@" + record.ref;
  return record.preset ? head + " · " + t("skills.install.repoPreset") : head;
}

export interface AddSkillDrawerProps {
  open: boolean;
  /** 当前会话工作区（安装到项目级根时要用；取不到为 undefined） */
  workspace: string | undefined;
  /** 安装完成后的回调：外壳会刷新「已安装」列表与回收站计数 */
  onInstalled?: () => void;
  onClose(): void;
}

interface Picked {
  repo: string;
  ref?: string;
  skillPath: string;
}

interface RepoResult extends InstallItemResult {
  repo: string;
}

interface EditState {
  repo: string;
  ref: string;
  subPath: string;
}

const sameRepo = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

function installedFilterLabel(id: InstalledFilter): string {
  if (id === "not") return t("skills.repoView.filter.not");
  if (id === "yes") return t("skills.repoView.filter.yes");
  return t("skills.repoView.filter.all");
}

/** 「添加技能」抽屉（仓库视图）。 */
export function AddSkillDrawer(props: AddSkillDrawerProps): React.ReactElement {
  const { workspace } = props;
  const [roots, setRoots] = React.useState<RootInfo[]>([]);
  // 顶部：唯一一个输入框——像仓库地址就浏览 / 加入，否则搜索 skills.sh（inputIntent）
  const [entry, setEntry] = React.useState<string>("");
  const [refInput, setRefInput] = React.useState<string>("");
  const [browsing, setBrowsing] = React.useState<boolean>(false);
  const [browse, setBrowse] = React.useState<BrowseResult | undefined>(undefined);
  const [browseError, setBrowseError] = React.useState<string | undefined>(undefined);
  const [browseErrors, setBrowseErrors] = React.useState<readonly FieldError[]>([]);
  const [searching, setSearching] = React.useState<boolean>(false);
  const [searchResults, setSearchResults] = React.useState<SearchResultItem[] | undefined>(undefined);
  const [searchError, setSearchError] = React.useState<string | undefined>(undefined);
  /** 搜索结果是否展开：从结果里浏览或加入仓库后自动收起，免得把下面的内容顶出视野。 */
  const [searchOpen, setSearchOpen] = React.useState<boolean>(false);
  /** 浏览结果 / 安装反馈出现时滚到这里，让用户看见下面的内容变了。 */
  const focusRef = React.useRef<HTMLDivElement | null>(null);
  const [focusTick, setFocusTick] = React.useState<number>(0);
  React.useEffect(() => {
    if (focusTick === 0) return;
    focusRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [focusTick]);
  // 仓库列表与汇总发现
  const [discovery, setDiscovery] = React.useState<DiscoveryView | undefined>(undefined);
  const [discoveryError, setDiscoveryError] = React.useState<string | undefined>(undefined);
  const [scanning, setScanning] = React.useState<boolean>(false);
  const [reposOpen, setReposOpen] = React.useState<boolean>(false);
  const [editing, setEditing] = React.useState<EditState | undefined>(undefined);
  const [repoBusy, setRepoBusy] = React.useState<boolean>(false);
  const [repoError, setRepoError] = React.useState<string | undefined>(undefined);
  const [repoNote, setRepoNote] = React.useState<string | undefined>(undefined);
  const [dq, setDq] = React.useState<string>("");
  const [installedFilter, setInstalledFilter] = React.useState<InstalledFilter>("all");
  const [repoFilter, setRepoFilter] = React.useState<string>("");
  /** 仓库分组的折叠（大仓库默认折叠；筛选中先全部展开）。 */
  const [repoFold, setRepoFold] = React.useState<RepoFold>(initialRepoFold);
  /** 每个仓库分组已经渲染了多少行（每批 200）；换一种筛选就重来。 */
  const [limits, setLimits] = React.useState<{ filterKey: string; byRepo: ReadonlyMap<string, number> }>({
    filterKey: "",
    byRepo: new Map(),
  });
  // 勾选与安装
  const [selected, setSelected] = React.useState<ReadonlyMap<string, Picked>>(new Map());
  const [target, setTarget] = React.useState<InstallTarget>("user-agents");
  const [installing, setInstalling] = React.useState<boolean>(false);
  const [results, setResults] = React.useState<RepoResult[] | undefined>(undefined);
  const [installError, setInstallError] = React.useState<string | undefined>(undefined);
  const [installSummary, setInstallSummary] = React.useState<string | undefined>(undefined);

  const doRefresh = React.useCallback(
    (repos?: readonly string[]): void => {
      setScanning(true);
      setDiscoveryError(undefined);
      void refreshDiscovery(workspace, repos).then(
        (view) => {
          setDiscovery(view);
          setScanning(false);
        },
        (failure: unknown) => {
          setDiscoveryError(errorMessage(failure));
          setScanning(false);
        },
      );
    },
    [workspace],
  );

  React.useEffect(() => {
    if (!props.open) return;
    let alive = true;
    void listSkills(workspace).then(
      (data) => {
        if (alive) setRoots(data.roots);
      },
      () => {
        // 拿不到根只影响安装位置的完整路径提示，不阻塞安装
      },
    );
    // 先读缓存立刻显示；从没扫过就自动扫一次（之后只有点「刷新」才联网）
    void fetchDiscovery(workspace).then(
      (view) => {
        if (!alive) return;
        setDiscovery(view);
        if (shouldAutoScan(view)) doRefresh();
      },
      (failure: unknown) => {
        if (alive) setDiscoveryError(errorMessage(failure));
      },
    );
    return () => {
      alive = false;
    };
  }, [workspace, props.open, doRefresh]);

  const targetOptions = installTargetOptions(roots, workspace);
  const repos = discovery?.repos ?? [];
  const inList = (repo: string): boolean => repos.some((record) => sameRepo(record.repo, repo));

  /* ---------------- 顶部：浏览 / 加入 / 搜索 ---------------- */

  /** 临时浏览一个仓库。keepResults=true 用于「安装后刷新已安装标记」，不清掉逐个结果。 */
  const doBrowse = (repo: string, ref: string | undefined, preselectPath?: string, keepResults = false): void => {
    setBrowsing(true);
    setBrowseError(undefined);
    setBrowseErrors([]);
    if (!keepResults) {
      setResults(undefined);
      setInstallSummary(undefined);
    }
    void browseRepo(repo, ref, workspace).then(
      (payload) => {
        setBrowse(payload);
        setSearchOpen(false);
        if (!keepResults) setFocusTick((tick) => tick + 1);
        const wanted =
          preselectPath === undefined ? undefined : payload.skills.find((skill) => skill.skillPath === preselectPath);
        if (wanted !== undefined && wanted.installedId === undefined) {
          setSelected(
            new Map([
              [
                discoveredKey({ repo: payload.repo, skillPath: wanted.skillPath }),
                { repo: payload.repo, ref: payload.ref, skillPath: wanted.skillPath },
              ],
            ]),
          );
        }
        setBrowsing(false);
      },
      (failure: unknown) => {
        setBrowse(undefined);
        setBrowseErrors(fieldErrors(failure));
        setBrowseError(errorMessage(failure));
        setBrowsing(false);
      },
    );
  };

  const applyRepoChange = (view: DiscoveryView): void => {
    setDiscovery(view);
    setRepoBusy(false);
  };

  const doAddToList = (repo: string, ref?: string): void => {
    if (repo.trim() === "") {
      setRepoError(t("skills.remote.form.required"));
      return;
    }
    setRepoBusy(true);
    setRepoError(undefined);
    setRepoNote(undefined);
    setSearchOpen(false);
    void addRepo(repo, ref, workspace).then(
      (change) => {
        applyRepoChange(change.discovery);
        const added = change.discovery.repos.find((record) => !repos.some((old) => sameRepo(old.repo, record.repo)));
        if (added !== undefined)
          setRepoNote(t("skills.repoView.added", { repo: added.repo, status: repoScanText(added) }));
      },
      (failure: unknown) => {
        setRepoError(errorMessage(failure));
        setRepoBusy(false);
      },
    );
  };

  const doSaveEdit = (): void => {
    if (editing === undefined) return;
    setRepoBusy(true);
    setRepoError(undefined);
    void updateRepo(editing.repo, { ref: editing.ref, subPath: editing.subPath }, workspace).then(
      (change) => {
        applyRepoChange(change.discovery);
        setEditing(undefined);
      },
      (failure: unknown) => {
        setRepoError(errorMessage(failure));
        setRepoBusy(false);
      },
    );
  };

  const doRemoveRepo = (repo: string): void => {
    setRepoBusy(true);
    setRepoError(undefined);
    void removeRepo(repo, workspace).then(
      (change) => {
        applyRepoChange(change.discovery);
        if (sameRepo(repoFilter, repo)) setRepoFilter("");
      },
      (failure: unknown) => {
        setRepoError(errorMessage(failure));
        setRepoBusy(false);
      },
    );
  };

  const doSearch = (): void => {
    const q = entry.trim();
    if (q.length < 2) {
      setSearchError(t("skills.remote.search.tooShort"));
      setSearchResults(undefined);
      return;
    }
    setSearching(true);
    setSearchError(undefined);
    void searchSkills(q).then(
      (list) => {
        setSearchResults(list);
        setSearchOpen(true);
        setSearching(false);
      },
      (failure: unknown) => {
        setSearchResults(undefined);
        setSearchError(errorMessage(failure));
        setSearching(false);
      },
    );
  };

  /* ---------------- 勾选与安装 ---------------- */

  const toggle = (item: Picked, next: boolean): void => {
    setSelected((previous) => {
      const map = new Map(previous);
      const key = discoveredKey(item);
      if (next) map.set(key, item);
      else map.delete(key);
      return map;
    });
  };

  const doInstall = async (): Promise<void> => {
    const plan = installPlan(selected.values());
    if (plan.length === 0) return;
    setInstalling(true);
    setInstallError(undefined);
    setResults(undefined);
    const collected: RepoResult[] = [];
    const failures: string[] = [];
    for (const group of plan) {
      try {
        const list = await installSkills(
          {
            repo: group.repo,
            ...(group.ref === undefined ? {} : { ref: group.ref }),
            skillPaths: group.skillPaths,
            target,
          },
          workspace,
        );
        for (const item of list) collected.push({ ...item, repo: group.repo });
      } catch (failure) {
        failures.push(group.repo + "：" + errorMessage(failure));
      }
    }
    setResults(collected);
    setInstalling(false);
    setFocusTick((tick) => tick + 1);
    if (failures.length > 0) setInstallError(failures.join("；"));
    const ok = collected.filter((item) => item.ok).length;
    setInstallSummary(installSummaryText(ok, collected.length - ok));
    setSelected(new Map());
    if (ok > 0) {
      props.onInstalled?.();
      void reloadSources(workspace);
      // 「已安装」是读取时现算的：重读缓存即可，不联网
      void fetchDiscovery(workspace).then(
        (view) => setDiscovery(view),
        () => undefined,
      );
      if (browse !== undefined) doBrowse(browse.repo, browse.ref, undefined, true);
    }
  };

  /* ---------------- 渲染 ---------------- */

  const fieldErrorsNode =
    browseErrors.length === 0
      ? null
      : browseErrors.map((entry) => (
          <p key={entry.path + entry.message} className={styles.fieldError}>
            {entry.path + "：" + entry.message}
          </p>
        ));

  const intent = inputIntent(entry);
  const browseEntry = (): void => doBrowse(normalizeRepoInput(entry), refInput.trim() === "" ? undefined : refInput);
  const topRow = (
    <div className={styles.form} data-testid="skills-repo-input">
      {/* 一个输入框：粘贴仓库地址 → 浏览 / 加入仓库列表（并出现分支输入）；输入关键词 → 搜索 skills.sh。 */}
      <div className={styles.repoRow} data-testid="skills-remote-browse" data-intent={intent}>
        <span className={styles.repoGrow}>
          <Input
            value={entry}
            placeholder={t("skills.repoView.entryPlaceholder")}
            aria-label={t("skills.repoView.entryPlaceholder")}
            data-testid="skills-repo-entry"
            onChange={(event: { target: { value: string } }) => setEntry(event.target.value)}
            onKeyDown={(event: { key: string }) => {
              if (event.key !== "Enter") return;
              if (intent === "repo") browseEntry();
              else if (intent === "search") doSearch();
            }}
          />
        </span>
        {intent !== "repo" ? null : (
          <span className={styles.refGrow}>
            <Input
              value={refInput}
              placeholder={t("skills.install.refPlaceholder")}
              aria-label={t("skills.install.refPlaceholder")}
              data-testid="skills-remote-ref-input"
              onChange={(event: { target: { value: string } }) => setRefInput(event.target.value)}
            />
          </span>
        )}
        {intent === "repo" ? (
          <React.Fragment>
            <Button
              size="sm"
              variant="outline"
              disabled={browsing}
              data-testid="skills-remote-browse-button"
              onClick={browseEntry}
            >
              {browsing ? t("skills.install.browsing") : t("skills.install.browse")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={repoBusy}
              data-testid="skills-repo-add"
              onClick={() => doAddToList(normalizeRepoInput(entry), refInput.trim() === "" ? undefined : refInput)}
            >
              {t("skills.repoView.addToList")}
            </Button>
          </React.Fragment>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={searching || intent === "empty"}
            data-testid="skills-remote-search-button"
            onClick={doSearch}
          >
            {searching ? t("skills.remote.search.searching") : t("skills.repoView.searchButton")}
          </Button>
        )}
      </div>
      {browseError === undefined ? null : (
        <p className={styles.errorBox} data-testid="skills-remote-browse-error">
          {browseError}
        </p>
      )}
      {fieldErrorsNode}
      {searchError === undefined ? null : (
        <p className={styles.errorBox} data-testid="skills-remote-search-error">
          {searchError}
        </p>
      )}
      {searchResults === undefined ? null : searchResults.length === 0 ? (
        <p className={styles.note} data-testid="skills-remote-search-empty">
          {t("skills.remote.search.empty")}
        </p>
      ) : (
        <div
          className={styles.form}
          data-testid="skills-remote-search-results"
          data-count={String(searchResults.length)}
        >
          {/* 一行摘要 + 展开 / 收起：结果再多也只占一个固定高度的滚动框，不把下面的内容顶出视野。 */}
          <div className={styles.inlineRow}>
            <span className={styles.note}>{t("skills.repoView.searchSummary", { count: searchResults.length })}</span>
            <span className={styles.grow} />
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={searchOpen}
              data-testid="skills-remote-search-toggle"
              onClick={() => setSearchOpen((open) => !open)}
            >
              {searchOpen ? t("skills.repoView.collapse") : t("skills.repoView.expand")}
            </Button>
          </div>
          {!searchOpen ? null : (
            <div className={styles.scrollBox} data-testid="skills-remote-search-box">
              <ListSurface testId="skills-remote-search-list">
                <ListGroup testId="skills-remote-search-group">
                  {searchResults.map((item, index) => (
                    <ListRow
                      key={item.repo + "-" + item.name + "-" + String(index)}
                      testId={"skills-remote-search-item-" + String(index)}
                      title={item.name}
                      subtitle={
                        item.repo +
                        (item.installs === undefined
                          ? ""
                          : " · " + t("skills.remote.search.installs", { count: item.installs }))
                      }
                      badges={
                        inList(item.repo)
                          ? [
                              <Badge key="in" tone="neutral">
                                {t("skills.repoView.inList")}
                              </Badge>,
                            ]
                          : []
                      }
                      hoverActions={[
                        {
                          label: t("skills.remote.search.browse"),
                          testId: "skills-remote-search-browse-" + String(index),
                          onClick: () => doBrowse(item.repo, undefined, item.skillPath),
                        },
                        ...(inList(item.repo)
                          ? []
                          : [
                              {
                                label: t("skills.repoView.addToList"),
                                testId: "skills-remote-search-add-" + String(index),
                                onClick: () => doAddToList(item.repo),
                              },
                            ]),
                      ]}
                    />
                  ))}
                </ListGroup>
              </ListSurface>
            </div>
          )}
        </div>
      )}
    </div>
  );

  const repoRow = (record: DiscoveryRepoView): React.ReactNode[] => {
    const failed = record.error !== undefined;
    const subtitle =
      repoConfigText(record) +
      " · " +
      (failed ? repoScanText(record) + "：" + record.error : repoScanText(record)) +
      (record.stale === true ? " · " + t("skills.repoView.stale") : "");
    const nodes: React.ReactNode[] = [
      <ListRow
        key={record.repo}
        testId={"skills-repo-row-" + record.repo}
        title={record.repo}
        subtitle={subtitle}
        subtitleTone={failed ? "danger" : "default"}
        badges={
          record.preset
            ? [
                <Badge key="preset" tone="neutral">
                  {t("skills.install.repoPreset")}
                </Badge>,
              ]
            : []
        }
        hoverActions={[
          {
            label: t("skills.install.browse"),
            testId: "skills-repo-browse-" + record.repo,
            onClick: () => doBrowse(record.repo, record.ref),
          },
          {
            label: t("skills.repoView.edit"),
            testId: "skills-repo-edit-" + record.repo,
            onClick: () => setEditing({ repo: record.repo, ref: record.ref ?? "", subPath: record.subPath ?? "" }),
          },
          {
            label: t("skills.repoView.remove"),
            danger: true,
            testId: "skills-repo-remove-" + record.repo,
            onClick: () => doRemoveRepo(record.repo),
          },
        ]}
      />,
    ];
    if (editing !== undefined && sameRepo(editing.repo, record.repo)) {
      nodes.push(
        <li key={record.repo + ":edit"} className={styles.repoEdit} data-testid="skills-repo-editor">
          <span className={styles.refGrow}>
            <Input
              value={editing.ref}
              placeholder={t("skills.install.refPlaceholder")}
              aria-label={t("skills.install.refPlaceholder")}
              data-testid="skills-repo-edit-ref"
              onChange={(event: { target: { value: string } }) => setEditing({ ...editing, ref: event.target.value })}
            />
          </span>
          <span className={styles.repoGrow}>
            <Input
              value={editing.subPath}
              placeholder={t("skills.repoView.subPathPlaceholder")}
              aria-label={t("skills.repoView.subPathPlaceholder")}
              data-testid="skills-repo-edit-subpath"
              onChange={(event: { target: { value: string } }) =>
                setEditing({ ...editing, subPath: event.target.value })
              }
            />
          </span>
          <Button size="sm" variant="ghost" data-testid="skills-repo-edit-cancel" onClick={() => setEditing(undefined)}>
            {t("skills.repoView.cancel")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={repoBusy}
            data-testid="skills-repo-edit-save"
            onClick={doSaveEdit}
          >
            {t("skills.repoView.save")}
          </Button>
        </li>,
      );
    }
    return nodes;
  };

  const repoList = (
    <div className={styles.form}>
      <ListSurface testId="skills-repo-list">
        <ListGroup
          title={t("skills.repoView.repos")}
          count={t("skills.repoView.repoCount", { count: repos.length })}
          expanded={reposOpen}
          onToggle={() => setReposOpen((open) => !open)}
          testId="skills-repo-group"
        >
          {repos.flatMap(repoRow)}
        </ListGroup>
      </ListSurface>
      {repoNote === undefined ? null : (
        <p className={styles.note} data-testid="skills-repo-note">
          {repoNote}
        </p>
      )}
      {repoError === undefined ? null : (
        <p className={styles.errorBox} data-testid="skills-remote-repo-error">
          {repoError}
        </p>
      )}
    </div>
  );

  const skillRow = (
    item: {
      repo: string;
      ref?: string;
      skillPath: string;
      dirName: string;
      name?: string;
      description?: string;
      installedId?: string;
    },
    showRepo: boolean,
  ): React.ReactElement => {
    const picked: Picked = {
      repo: item.repo,
      ...(item.ref === undefined ? {} : { ref: item.ref }),
      skillPath: item.skillPath,
    };
    const key = discoveredKey(item);
    const installed = item.installedId !== undefined;
    return (
      <ListRow
        key={key}
        testId={"skills-discovered-" + item.repo + "-" + item.dirName}
        /* 原生勾选框：宿主 Checkbox 的 label 是可见文字，会与行标题重复（名称只出现一次）。 */ leading={
          <input
            type="checkbox"
            className={kit.check}
            checked={selected.has(key)}
            disabled={installed}
            aria-label={item.name ?? item.dirName}
            onClick={(event: React.MouseEvent) => event.stopPropagation()}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => toggle(picked, event.target.checked)}
          />
        }
        title={item.name ?? item.dirName}
        {...(showRepo
          ? {
              tag: {
                text: item.repo,
                title: item.repo + (item.ref === undefined ? "" : "@" + item.ref) + " · " + item.skillPath,
              },
            }
          : {})}
        subtitle={item.description ?? item.skillPath}
        badges={
          installed
            ? [
                <Badge key="installed" tone="neutral">
                  {t("skills.install.installed")}
                </Badge>,
              ]
            : []
        }
        onOpen={installed ? undefined : () => toggle(picked, !selected.has(key))}
      />
    );
  };

  const browseBlock =
    browse === undefined ? null : (
      <div
        className={styles.form}
        data-testid="skills-remote-browse-result"
        data-repo={browse.repo}
        data-ref={browse.ref}
        data-skill-count={String(browse.skills.length)}
      >
        <div className={styles.inlineRow}>
          <span className={styles.note} data-testid="skills-remote-browse-summary">
            {t("skills.repoView.browsing", { repo: browse.repo, ref: browse.ref })}
          </span>
          <span className={styles.grow} />
          <Button
            size="sm"
            variant="ghost"
            data-testid="skills-remote-select-all"
            onClick={() =>
              setSelected((previous) => {
                const map = new Map(previous);
                for (const skill of browse.skills)
                  if (skill.installedId === undefined)
                    map.set(discoveredKey({ repo: browse.repo, skillPath: skill.skillPath }), {
                      repo: browse.repo,
                      ref: browse.ref,
                      skillPath: skill.skillPath,
                    });
                return map;
              })
            }
          >
            {t("skills.install.selectAll")}
          </Button>
          <Button size="sm" variant="outline" data-testid="skills-repo-back" onClick={() => setBrowse(undefined)}>
            {t("skills.repoView.back")}
          </Button>
        </div>
        <ListSurface testId="skills-remote-browse-list">
          <ListGroup
            title={t("skills.install.browseResults")}
            count={browse.skills.length}
            testId="skills-remote-browse-group"
          >
            {browse.skills.map((skill) => skillRow({ ...skill, repo: browse.repo, ref: browse.ref }, false))}
          </ListGroup>
        </ListSurface>
      </div>
    );

  const discoveryBlock = ((): React.ReactNode => {
    if (browse !== undefined) return null;
    const all = discovery?.skills ?? [];
    const counts = installedCounts(all, dq, repoFilter);
    const filter = { query: dq, installed: installedFilter, repo: repoFilter };
    const filtered = filterDiscovered(all, filter);
    // 按仓库分组（0.3.4）：大仓库默认折叠，筛选中先全部展开；每组分批渲染 200 行。
    const filterKey = discoveryFilterKey(filter);
    const groups = groupDiscovered(
      all,
      filtered,
      repos.map((record) => record.repo),
    );
    const limitOf = (repo: string): number =>
      (limits.filterKey === filterKey ? limits.byRepo.get(repo.toLowerCase()) : undefined) ?? DISCOVERY_PAGE;
    const showMore = (repo: string): void =>
      setLimits((current) => {
        const base = current.filterKey === filterKey ? current.byRepo : new Map<string, number>();
        return { filterKey, byRepo: new Map(base).set(repo.toLowerCase(), limitOf(repo) + DISCOVERY_PAGE) };
      });
    const toolbar = (
      <Toolbar
        testId="skills-discovery-toolbar"
        search={{
          value: dq,
          onChange: setDq,
          placeholder: t("skills.repoView.searchPlaceholder"),
          testId: "skills-discovery-search",
        }}
        filters={{
          items: INSTALLED_FILTERS.map((id) => ({ id, label: installedFilterLabel(id), count: counts[id] })),
          value: installedFilter,
          onChange: (id: string) => setInstalledFilter(id as InstalledFilter),
          label: t("skills.filterLabel"),
        }}
        afterFilters={
          <select
            className={kit.select}
            value={repoFilter}
            aria-label={t("skills.repoView.repoAll")}
            data-testid="skills-discovery-repo-filter"
            data-active={repoFilter === "" ? undefined : ""}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => setRepoFilter(event.target.value)}
          >
            <option value="">{t("skills.repoView.repoAll")}</option>
            {repos.map((record) => (
              <option key={record.repo} value={record.repo}>
                {record.repo + (record.skillCount === undefined ? "" : "（" + String(record.skillCount) + "）")}
              </option>
            ))}
          </select>
        }
        end={
          <React.Fragment>
            <span
              className={styles.scanMeta}
              data-testid="skills-discovery-last-scan"
              title={discovery?.lastScannedAt ?? ""}
            >
              {scanning
                ? t("skills.repoView.refreshing")
                : t("skills.repoView.lastScan", { time: relativeTime(discovery?.lastScannedAt, Date.now()) })}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={scanning}
              data-testid="skills-discovery-refresh"
              onClick={() => doRefresh()}
            >
              {t("skills.repoView.refresh")}
            </Button>
          </React.Fragment>
        }
      />
    );
    let body: React.ReactNode;
    if (discoveryError !== undefined && discovery === undefined) {
      body = (
        <p className={styles.errorBox} data-testid="skills-discovery-error">
          {t("skills.repoView.loadFailed", { message: discoveryError })}
        </p>
      );
    } else if (discovery === undefined || (scanning && !discovery.cached)) {
      body = (
        <React.Fragment>
          <p className={styles.note} data-testid="skills-discovery-first-scan">
            {t("skills.repoView.firstScan")}
          </p>
          <SkeletonRows testId="skills-discovery-loading" />
        </React.Fragment>
      );
    } else if (filtered.length === 0) {
      body = (
        <p className={styles.note} data-testid="skills-discovery-empty">
          {all.length === 0 ? t("skills.repoView.empty") : t("skills.repoView.emptyFiltered")}
        </p>
      );
    } else {
      body = (
        <ListSurface testId="skills-discovery-list">
          {groups.map((group) => {
            const open = repoExpanded(repoFold, filterKey, group);
            const { visible, rest } = sliceVisible(group.skills, limitOf(group.repo));
            const record = repos.find((item) => sameRepo(item.repo, group.repo));
            const ref = record?.resolvedRef ?? record?.ref;
            return (
              <div key={group.repo} className={styles.groupStack} data-testid={"skills-discovery-repo-" + group.repo}>
                <ListGroup
                  title={group.repo}
                  {...(ref === undefined ? {} : { meta: "@" + ref })}
                  count={t("skills.root.count", { count: filterKey === "" ? group.total : group.skills.length })}
                  expanded={open}
                  onToggle={() => setRepoFold((current) => toggleRepoFold(current, filterKey, group))}
                  testId={"skills-discovery-group-" + group.repo}
                >
                  {visible.map((skill) => skillRow(skill, false))}
                </ListGroup>
                {!open || rest === 0 ? null : (
                  <ListFoot
                    testId={"skills-discovery-more-" + group.repo}
                    text=""
                    action={{
                      label: t("skills.repoView.more", {
                        count: Math.min(rest, DISCOVERY_PAGE),
                        total: group.skills.length,
                      }),
                      onClick: () => showMore(group.repo),
                      testId: "skills-discovery-more-button-" + group.repo,
                    }}
                  />
                )}
              </div>
            );
          })}
        </ListSurface>
      );
    }
    return (
      <div className={styles.form} data-testid="skills-discovery" data-count={String(filtered.length)}>
        {toolbar}
        {discoveryError !== undefined && discovery !== undefined ? (
          <p className={styles.errorBox} data-testid="skills-discovery-refresh-error">
            {discoveryError}
          </p>
        ) : null}
        {body}
      </div>
    );
  })();

  const footer =
    selected.size === 0 && !installing ? undefined : (
      <React.Fragment>
        <span className={styles.fieldLabel}>{t("skills.install.target")}</span>
        <div className={styles.chips} data-testid="skills-install-target">
          {targetOptions.map((option) => (
            <Pill
              key={option.id}
              active={target === option.id}
              title={option.path ?? t("skills.install.targetPathUnknown")}
              data-testid={"skills-install-target-" + option.id}
              onClick={() => setTarget(option.id)}
            >
              {option.label}
            </Pill>
          ))}
        </div>
        <span className={kit.drawerFootSpacer} />
        <span className={styles.code} data-testid="skills-remote-selected-count">
          {t("skills.repoView.selected", { count: selected.size })}
        </span>
        <Button
          variant="primary"
          disabled={installing || selected.size === 0}
          data-testid="skills-install-submit"
          onClick={() => void doInstall()}
        >
          {installing ? t("skills.install.running") : t("skills.install.submit")}
        </Button>
      </React.Fragment>
    );

  return (
    <Drawer
      open={props.open}
      title={t("skills.install.title")}
      subtitle={t("skills.repoView.subtitle")}
      width={860}
      testId="skills-add"
      onClose={props.onClose}
      {...(footer === undefined ? {} : { footer })}
    >
      <div className={styles.form} data-testid="skills-install-view" data-browsing={browsing ? "1" : "0"}>
        {topRow}
        {/* 紧跟输入区的「焦点区」：安装反馈与临时浏览的结果都出现在这里，并自动滚到可见， */}
        {/* 不会被埋在仓库列表与汇总下面。 */}
        <div className={styles.form} ref={focusRef} data-testid="skills-repo-focus">
          {installSummary === undefined ? null : (
            <p className={styles.note} data-testid="skills-remote-install-summary">
              {installSummary}
            </p>
          )}
          {installError === undefined ? null : (
            <p className={styles.errorBox} data-testid="skills-remote-install-error">
              {installError}
            </p>
          )}
          {results === undefined ? null : (
            <ul className={styles.resultList} data-testid="skills-remote-install-results">
              {results.map((result, index) => (
                <li
                  key={result.repo + result.skillPath + "-" + String(index)}
                  className={styles.resultRow}
                  data-ok={result.ok ? "1" : "0"}
                  data-skill-path={result.skillPath}
                >
                  <Badge tone={result.ok ? "neutral" : "danger"}>
                    {result.ok ? t("skills.install.ok") : t("skills.install.failed")}
                  </Badge>
                  <span className={styles.note}>{result.repo + " · " + installResultText(result)}</span>
                </li>
              ))}
            </ul>
          )}
          {browseBlock}
        </div>
        {repoList}
        {discoveryBlock}
      </div>
    </Drawer>
  );
}
