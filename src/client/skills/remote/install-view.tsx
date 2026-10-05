/**
 * 「添加技能」= 仓库视图（D-B6 / D-B16，UI-DESIGN §3）：宽抽屉 860px。
 *
 * 自上而下：
 *   1. 仓库地址：粘贴 owner/name 或 GitHub 链接 →「浏览」（临时只看这一个仓库）或「加入仓库列表」；
 *      skills.sh 搜索，结果可浏览、可把所在仓库加入列表。
 *   2. 仓库列表（默认折叠成一行）：分支 · 子目录 · 扫描状态；悬停浏览 / 编辑 / 移除，编辑就地展开。
 *   3. 汇总发现（主体）：所有仓库的技能合成一张表，可按名称、已安装 / 未安装、仓库筛选；
 *      显示上次扫描时间，点「刷新」才联网；第一次没有缓存时自动扫一次；上千行时分批渲染。
 *      临时浏览某个仓库时，这一块换成该仓库的技能，「返回汇总」回来。
 *   4. 底部（有勾选时才出现）：安装位置 + 安装；跨仓库的勾选按仓库分组依次安装。
 *
 * 纯逻辑在 discovery-model.ts；所有请求错误都转成界面状态。
 */

import * as React from "react";
import { Button, Input, Pill } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, Drawer, ListFoot, ListGroup, ListRow, ListSurface, SkeletonRows, Toolbar, kit } from "../../shell/kit/index.ts";
import { listSkills } from "../data.ts";
import { addRepo, browseRepo, fetchDiscovery, installSkills, refreshDiscovery, removeRepo, searchSkills, updateRepo } from "./data.ts";
import { reloadSources } from "./cache.ts";
import { installResultText, installSummaryText, installTargetOptions } from "./model.ts";
import {
  DISCOVERY_PAGE,
  INSTALLED_FILTERS,
  discoveredKey,
  filterDiscovered,
  installPlan,
  installedCounts,
  relativeTime,
  repoConfigText,
  repoScanText,
  shouldAutoScan,
  sliceVisible,
  type InstalledFilter,
} from "./discovery-model.ts";
import { errorMessage, fieldErrors, type FieldError } from "../format.ts";
import { styles } from "../styles.ts";
import { t } from "../strings.ts";
import type { RootInfo } from "../types.ts";
import type { BrowseResult, DiscoveryRepoView, DiscoveryView, InstallItemResult, InstallTarget, SearchResultItem } from "./types.ts";

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
  // 顶部：仓库地址与 skills.sh 搜索
  const [repoInput, setRepoInput] = React.useState<string>("");
  const [refInput, setRefInput] = React.useState<string>("");
  const [browsing, setBrowsing] = React.useState<boolean>(false);
  const [browse, setBrowse] = React.useState<BrowseResult | undefined>(undefined);
  const [browseError, setBrowseError] = React.useState<string | undefined>(undefined);
  const [browseErrors, setBrowseErrors] = React.useState<readonly FieldError[]>([]);
  const [query, setQuery] = React.useState<string>("");
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
  const [limit, setLimit] = React.useState<number>(DISCOVERY_PAGE);
  // 勾选与安装
  const [selected, setSelected] = React.useState<ReadonlyMap<string, Picked>>(new Map());
  const [target, setTarget] = React.useState<InstallTarget>("user-agents");
  const [installing, setInstalling] = React.useState<boolean>(false);
  const [results, setResults] = React.useState<RepoResult[] | undefined>(undefined);
  const [installError, setInstallError] = React.useState<string | undefined>(undefined);
  const [installSummary, setInstallSummary] = React.useState<string | undefined>(undefined);

  const doRefresh = React.useCallback((repos?: readonly string[]): void => {
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
  }, [workspace]);

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
    setRepoInput(repo);
    if (ref !== undefined) setRefInput(ref);
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
        const wanted = preselectPath === undefined ? undefined : payload.skills.find((skill) => skill.skillPath === preselectPath);
        if (wanted !== undefined && wanted.installedId === undefined) {
          setSelected(new Map([[discoveredKey({ repo: payload.repo, skillPath: wanted.skillPath }), { repo: payload.repo, ref: payload.ref, skillPath: wanted.skillPath }]]));
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
        if (added !== undefined) setRepoNote(t("skills.repoView.added", { repo: added.repo, status: repoScanText(added) }));
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
    const q = query.trim();
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
        const list = await installSkills({ repo: group.repo, ...(group.ref === undefined ? {} : { ref: group.ref }), skillPaths: group.skillPaths, target }, workspace);
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
      void fetchDiscovery(workspace).then((view) => setDiscovery(view), () => undefined);
      if (browse !== undefined) doBrowse(browse.repo, browse.ref, undefined, true);
    }
  };

  /* ---------------- 渲染 ---------------- */

  const fieldErrorsNode = browseErrors.length === 0
    ? null
    : browseErrors.map((entry) => React.createElement("p", { key: entry.field + entry.message, className: styles.fieldError }, entry.field + "：" + entry.message));

  const topRow = React.createElement("div", { className: styles.form, "data-testid": "skills-repo-input" },
    React.createElement("div", { className: styles.repoRow, "data-testid": "skills-remote-browse" },
      React.createElement("span", { className: styles.repoGrow },
        React.createElement(Input, {
          value: repoInput,
          placeholder: t("skills.install.repoPlaceholder"),
          "aria-label": t("skills.install.repoPlaceholder"),
          "data-testid": "skills-remote-repo-input",
          onChange: (event: { target: { value: string } }) => setRepoInput(event.target.value),
        })),
      React.createElement("span", { className: styles.refGrow },
        React.createElement(Input, {
          value: refInput,
          placeholder: t("skills.install.refPlaceholder"),
          "aria-label": t("skills.install.refPlaceholder"),
          "data-testid": "skills-remote-ref-input",
          onChange: (event: { target: { value: string } }) => setRefInput(event.target.value),
        })),
      React.createElement(Button, {
        size: "sm",
        variant: "outline",
        disabled: browsing || repoInput.trim() === "",
        "data-testid": "skills-remote-browse-button",
        onClick: () => doBrowse(repoInput, refInput.trim() === "" ? undefined : refInput),
      }, browsing ? t("skills.install.browsing") : t("skills.install.browse")),
      React.createElement(Button, {
        size: "sm",
        variant: "outline",
        disabled: repoBusy || repoInput.trim() === "",
        "data-testid": "skills-repo-add",
        onClick: () => doAddToList(repoInput, refInput.trim() === "" ? undefined : refInput),
      }, t("skills.repoView.addToList"))),
    browseError === undefined ? null : React.createElement("p", { className: styles.errorBox, "data-testid": "skills-remote-browse-error" }, browseError),
    fieldErrorsNode,
    React.createElement("div", { className: styles.repoRow, "data-testid": "skills-remote-search" },
      React.createElement("span", { className: styles.repoGrow },
        React.createElement(Input, {
          value: query,
          placeholder: t("skills.remote.search.placeholder"),
          "aria-label": t("skills.remote.search.placeholder"),
          "data-testid": "skills-remote-search-input",
          onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
          onKeyDown: (event: { key: string }) => {
            if (event.key === "Enter") doSearch();
          },
        })),
      React.createElement(Button, {
        size: "sm",
        variant: "outline",
        disabled: searching,
        "data-testid": "skills-remote-search-button",
        onClick: doSearch,
      }, searching ? t("skills.remote.search.searching") : t("skills.remote.search.button"))),
    searchError === undefined ? null : React.createElement("p", { className: styles.errorBox, "data-testid": "skills-remote-search-error" }, searchError),
    searchResults === undefined
      ? null
      : searchResults.length === 0
        ? React.createElement("p", { className: styles.note, "data-testid": "skills-remote-search-empty" }, t("skills.remote.search.empty"))
        : React.createElement("div", { className: styles.form, "data-testid": "skills-remote-search-results", "data-count": String(searchResults.length) },
          // 一行摘要 + 展开 / 收起：结果再多也只占一个固定高度的滚动框，不把下面的内容顶出视野。
          React.createElement("div", { className: styles.inlineRow },
            React.createElement("span", { className: styles.note }, t("skills.repoView.searchSummary", { count: searchResults.length })),
            React.createElement("span", { className: styles.grow }),
            React.createElement(Button, {
              size: "sm",
              variant: "ghost",
              "aria-expanded": searchOpen,
              "data-testid": "skills-remote-search-toggle",
              onClick: () => setSearchOpen((open) => !open),
            }, searchOpen ? t("skills.repoView.collapse") : t("skills.repoView.expand"))),
          !searchOpen
            ? null
            : React.createElement("div", { className: styles.scrollBox, "data-testid": "skills-remote-search-box" },
              React.createElement(ListSurface, { testId: "skills-remote-search-list" },
                React.createElement(ListGroup, { testId: "skills-remote-search-group" },
                  searchResults.map((item, index) => React.createElement(ListRow, {
                    key: item.repo + "-" + item.name + "-" + String(index),
                    testId: "skills-remote-search-item-" + String(index),
                    title: item.name,
                    subtitle: item.repo + (item.installs === undefined ? "" : " · " + t("skills.remote.search.installs", { count: item.installs })),
                    badges: inList(item.repo) ? [React.createElement(Badge, { key: "in", tone: "neutral" }, t("skills.repoView.inList"))] : [],
                    hoverActions: [
                      { label: t("skills.remote.search.browse"), testId: "skills-remote-search-browse-" + String(index), onClick: () => doBrowse(item.repo, undefined, item.skillPath) },
                      ...(inList(item.repo)
                        ? []
                        : [{ label: t("skills.repoView.addToList"), testId: "skills-remote-search-add-" + String(index), onClick: () => doAddToList(item.repo) }]),
                    ],
                  })))))));

  const repoRow = (record: DiscoveryRepoView): React.ReactNode[] => {
    const failed = record.error !== undefined;
    const subtitle = repoConfigText(record) + " · " + (failed ? repoScanText(record) + "：" + record.error : repoScanText(record)) +
      (record.stale === true ? " · " + t("skills.repoView.stale") : "");
    const nodes: React.ReactNode[] = [React.createElement(ListRow, {
      key: record.repo,
      testId: "skills-repo-row-" + record.repo,
      title: record.repo,
      subtitle,
      subtitleTone: failed ? "danger" : "default",
      badges: record.preset ? [React.createElement(Badge, { key: "preset", tone: "neutral" }, t("skills.install.repoPreset"))] : [],
      hoverActions: [
        { label: t("skills.install.browse"), testId: "skills-repo-browse-" + record.repo, onClick: () => doBrowse(record.repo, record.ref) },
        { label: t("skills.repoView.edit"), testId: "skills-repo-edit-" + record.repo, onClick: () => setEditing({ repo: record.repo, ref: record.ref ?? "", subPath: record.subPath ?? "" }) },
        { label: t("skills.repoView.remove"), danger: true, testId: "skills-repo-remove-" + record.repo, onClick: () => doRemoveRepo(record.repo) },
      ],
    })];
    if (editing !== undefined && sameRepo(editing.repo, record.repo)) {
      nodes.push(React.createElement("li", { key: record.repo + ":edit", className: styles.repoEdit, "data-testid": "skills-repo-editor" },
        React.createElement("span", { className: styles.refGrow },
          React.createElement(Input, {
            value: editing.ref,
            placeholder: t("skills.install.refPlaceholder"),
            "aria-label": t("skills.install.refPlaceholder"),
            "data-testid": "skills-repo-edit-ref",
            onChange: (event: { target: { value: string } }) => setEditing({ ...editing, ref: event.target.value }),
          })),
        React.createElement("span", { className: styles.repoGrow },
          React.createElement(Input, {
            value: editing.subPath,
            placeholder: t("skills.repoView.subPathPlaceholder"),
            "aria-label": t("skills.repoView.subPathPlaceholder"),
            "data-testid": "skills-repo-edit-subpath",
            onChange: (event: { target: { value: string } }) => setEditing({ ...editing, subPath: event.target.value }),
          })),
        React.createElement(Button, { size: "sm", variant: "ghost", "data-testid": "skills-repo-edit-cancel", onClick: () => setEditing(undefined) }, t("skills.repoView.cancel")),
        React.createElement(Button, { size: "sm", variant: "outline", disabled: repoBusy, "data-testid": "skills-repo-edit-save", onClick: doSaveEdit }, t("skills.repoView.save"))));
    }
    return nodes;
  };

  const repoList = React.createElement("div", { className: styles.form },
    React.createElement(ListSurface, { testId: "skills-repo-list" },
      React.createElement(ListGroup, {
        title: t("skills.repoView.repos"),
        count: t("skills.repoView.repoCount", { count: repos.length }),
        expanded: reposOpen,
        onToggle: () => setReposOpen((open) => !open),
        testId: "skills-repo-group",
      }, repos.flatMap(repoRow))),
    repoNote === undefined ? null : React.createElement("p", { className: styles.note, "data-testid": "skills-repo-note" }, repoNote),
    repoError === undefined ? null : React.createElement("p", { className: styles.errorBox, "data-testid": "skills-remote-repo-error" }, repoError));

  const skillRow = (item: { repo: string; ref?: string; skillPath: string; dirName: string; name?: string; description?: string; installedId?: string }, showRepo: boolean): React.ReactElement => {
    const picked: Picked = { repo: item.repo, ...(item.ref === undefined ? {} : { ref: item.ref }), skillPath: item.skillPath };
    const key = discoveredKey(item);
    const installed = item.installedId !== undefined;
    return React.createElement(ListRow, {
      key,
      testId: "skills-discovered-" + item.repo + "-" + item.dirName,
      // 原生勾选框：宿主 Checkbox 的 label 是可见文字，会与行标题重复（名称只出现一次）。
      leading: React.createElement("input", {
        type: "checkbox",
        className: kit.check,
        checked: selected.has(key),
        disabled: installed,
        "aria-label": item.name ?? item.dirName,
        onClick: (event: React.MouseEvent) => event.stopPropagation(),
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => toggle(picked, event.target.checked),
      }),
      title: item.name ?? item.dirName,
      ...(showRepo ? { tag: { text: item.repo, title: item.repo + (item.ref === undefined ? "" : "@" + item.ref) + " · " + item.skillPath } } : {}),
      subtitle: item.description ?? item.skillPath,
      badges: installed ? [React.createElement(Badge, { key: "installed", tone: "neutral" }, t("skills.install.installed"))] : [],
      onOpen: installed ? undefined : () => toggle(picked, !selected.has(key)),
    });
  };

  const browseBlock = browse === undefined ? null : React.createElement("div", {
    className: styles.form,
    "data-testid": "skills-remote-browse-result",
    "data-repo": browse.repo,
    "data-ref": browse.ref,
    "data-skill-count": String(browse.skills.length),
  },
  React.createElement("div", { className: styles.inlineRow },
    React.createElement("span", { className: styles.note, "data-testid": "skills-remote-browse-summary" }, t("skills.repoView.browsing", { repo: browse.repo, ref: browse.ref })),
    React.createElement("span", { className: styles.grow }),
    React.createElement(Button, {
      size: "sm",
      variant: "ghost",
      "data-testid": "skills-remote-select-all",
      onClick: () => setSelected((previous) => {
        const map = new Map(previous);
        for (const skill of browse.skills) if (skill.installedId === undefined) map.set(discoveredKey({ repo: browse.repo, skillPath: skill.skillPath }), { repo: browse.repo, ref: browse.ref, skillPath: skill.skillPath });
        return map;
      }),
    }, t("skills.install.selectAll")),
    React.createElement(Button, { size: "sm", variant: "outline", "data-testid": "skills-repo-back", onClick: () => setBrowse(undefined) }, t("skills.repoView.back"))),
  React.createElement(ListSurface, { testId: "skills-remote-browse-list" },
    React.createElement(ListGroup, { title: t("skills.install.browseResults"), count: browse.skills.length, testId: "skills-remote-browse-group" },
      browse.skills.map((skill) => skillRow({ ...skill, repo: browse.repo, ref: browse.ref }, false)))));

  const discoveryBlock = ((): React.ReactNode => {
    if (browse !== undefined) return null;
    const all = discovery?.skills ?? [];
    const counts = installedCounts(all, dq, repoFilter);
    const filtered = filterDiscovered(all, { query: dq, installed: installedFilter, repo: repoFilter });
    const { visible, rest } = sliceVisible(filtered, limit);
    const toolbar = React.createElement(Toolbar, {
      testId: "skills-discovery-toolbar",
      search: { value: dq, onChange: (value: string) => { setDq(value); setLimit(DISCOVERY_PAGE); }, placeholder: t("skills.repoView.searchPlaceholder"), testId: "skills-discovery-search" },
      filters: {
        items: INSTALLED_FILTERS.map((id) => ({ id, label: installedFilterLabel(id), count: counts[id] })),
        value: installedFilter,
        onChange: (id: string) => { setInstalledFilter(id as InstalledFilter); setLimit(DISCOVERY_PAGE); },
        label: t("skills.filterLabel"),
      },
      afterFilters: React.createElement("select", {
        className: kit.select,
        value: repoFilter,
        "aria-label": t("skills.repoView.repoAll"),
        "data-testid": "skills-discovery-repo-filter",
        "data-active": repoFilter === "" ? undefined : "",
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => { setRepoFilter(event.target.value); setLimit(DISCOVERY_PAGE); },
      },
      React.createElement("option", { value: "" }, t("skills.repoView.repoAll")),
      repos.map((record) => React.createElement("option", { key: record.repo, value: record.repo }, record.repo + (record.skillCount === undefined ? "" : "（" + String(record.skillCount) + "）")))),
      end: React.createElement(React.Fragment, null,
        React.createElement("span", { className: styles.scanMeta, "data-testid": "skills-discovery-last-scan", title: discovery?.lastScannedAt ?? "" },
          scanning ? t("skills.repoView.refreshing") : t("skills.repoView.lastScan", { time: relativeTime(discovery?.lastScannedAt, Date.now()) })),
        React.createElement(Button, {
          size: "sm",
          variant: "outline",
          disabled: scanning,
          "data-testid": "skills-discovery-refresh",
          onClick: () => doRefresh(),
        }, t("skills.repoView.refresh"))),
    });
    let body: React.ReactNode;
    if (discoveryError !== undefined && discovery === undefined) {
      body = React.createElement("p", { className: styles.errorBox, "data-testid": "skills-discovery-error" }, t("skills.repoView.loadFailed", { message: discoveryError }));
    } else if (discovery === undefined || (scanning && !discovery.cached)) {
      body = React.createElement(React.Fragment, null,
        React.createElement("p", { className: styles.note, "data-testid": "skills-discovery-first-scan" }, t("skills.repoView.firstScan")),
        React.createElement(SkeletonRows, { testId: "skills-discovery-loading" }));
    } else if (filtered.length === 0) {
      body = React.createElement("p", { className: styles.note, "data-testid": "skills-discovery-empty" }, all.length === 0 ? t("skills.repoView.empty") : t("skills.repoView.emptyFiltered"));
    } else {
      body = React.createElement(React.Fragment, null,
        React.createElement(ListSurface, { testId: "skills-discovery-list" },
          React.createElement(ListGroup, { testId: "skills-discovery-group" }, visible.map((skill) => skillRow(skill, true)))),
        rest === 0 ? null : React.createElement(ListFoot, {
          testId: "skills-discovery-more",
          text: "",
          action: { label: t("skills.repoView.more", { count: Math.min(rest, DISCOVERY_PAGE), total: filtered.length }), onClick: () => setLimit((value) => value + DISCOVERY_PAGE), testId: "skills-discovery-more-button" },
        }));
    }
    return React.createElement("div", { className: styles.form, "data-testid": "skills-discovery", "data-count": String(filtered.length) },
      toolbar,
      discoveryError !== undefined && discovery !== undefined
        ? React.createElement("p", { className: styles.errorBox, "data-testid": "skills-discovery-refresh-error" }, discoveryError)
        : null,
      body);
  })();

  const footer = selected.size === 0 && !installing
    ? undefined
    : React.createElement(React.Fragment, null,
        React.createElement("span", { className: styles.fieldLabel }, t("skills.install.target")),
        React.createElement("div", { className: styles.chips, "data-testid": "skills-install-target" },
          targetOptions.map((option) => React.createElement(Pill, {
            key: option.id,
            active: target === option.id,
            title: option.path ?? t("skills.install.targetPathUnknown"),
            "data-testid": "skills-install-target-" + option.id,
            onClick: () => setTarget(option.id),
          }, option.label))),
        React.createElement("span", { className: kit.drawerFootSpacer }),
        React.createElement("span", { className: styles.code, "data-testid": "skills-remote-selected-count" }, t("skills.repoView.selected", { count: selected.size })),
        React.createElement(Button, {
          variant: "primary",
          disabled: installing || selected.size === 0,
          "data-testid": "skills-install-submit",
          onClick: () => void doInstall(),
        }, installing ? t("skills.install.running") : t("skills.install.submit")));

  return React.createElement(Drawer, {
    open: props.open,
    title: t("skills.install.title"),
    subtitle: t("skills.repoView.subtitle"),
    width: 860,
    testId: "skills-add",
    onClose: props.onClose,
    ...(footer === undefined ? {} : { footer }),
  },
  React.createElement("div", { className: styles.form, "data-testid": "skills-install-view", "data-browsing": browsing ? "1" : "0" },
    topRow,
    // 紧跟输入区的「焦点区」：安装反馈与临时浏览的结果都出现在这里，并自动滚到可见，
    // 不会被埋在仓库列表与汇总下面。
    React.createElement("div", { className: styles.form, ref: focusRef, "data-testid": "skills-repo-focus" },
      installSummary === undefined ? null : React.createElement("p", { className: styles.note, "data-testid": "skills-remote-install-summary" }, installSummary),
      installError === undefined ? null : React.createElement("p", { className: styles.errorBox, "data-testid": "skills-remote-install-error" }, installError),
      results === undefined
        ? null
        : React.createElement("ul", { className: styles.resultList, "data-testid": "skills-remote-install-results" },
          results.map((result, index) => React.createElement("li", {
            key: result.repo + result.skillPath + "-" + String(index),
            className: styles.resultRow,
            "data-ok": result.ok ? "1" : "0",
            "data-skill-path": result.skillPath,
          },
          React.createElement(Badge, { tone: result.ok ? "neutral" : "danger" }, result.ok ? t("skills.install.ok") : t("skills.install.failed")),
          React.createElement("span", { className: styles.note }, result.repo + " · " + installResultText(result))))),
      browseBlock),
    repoList,
    discoveryBlock));
}
