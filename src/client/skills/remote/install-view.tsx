/**
 * 「添加技能」抽屉（UI-DESIGN §4）：宽 720px。
 *
 * 自上而下：仓库输入 → 常用仓库胶囊（可增删）+ skills.sh 搜索 → 浏览结果（勾选列表）
 * → 底部固定区（目标选择 + 安装）。
 *
 * 所有请求错误都转成界面状态；VALIDATION 的 details 落到对应字段上。
 * 「安装到当前项目」只把 target 参数发给宿主（界面与参数可查），不在本任务里真的往项目根写。
 */

import * as React from "react";
import { Button, Checkbox, Input, Pill } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, Drawer, ListGroup, ListRow, ListSurface, kit } from "../../shell/kit/index.ts";
import { listSkills } from "../data.ts";
import { addRepo, browseRepo, installSkills, listRepos, removeRepo, searchSkills } from "./data.ts";
import { reloadSources } from "./cache.ts";
import { installResultText, installSummaryText, installTargetOptions, targetLabel } from "./model.ts";
import { errorMessage, fieldErrors, type FieldError } from "../format.ts";
import { styles } from "../styles.ts";
import { t } from "../strings.ts";
import type { RootInfo } from "../types.ts";
import type { BrowseResult, InstallItemResult, InstallTarget, RepoRecord, SearchResultItem } from "./types.ts";

/** 胶囊的悬停提示：仓库@分支（+ 预置）。胶囊里只显示仓库名，其余信息全在提示里。 */
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

/** 「添加技能」抽屉。 */
export function AddSkillDrawer(props: AddSkillDrawerProps): React.ReactElement {
  const { workspace } = props;
  const [roots, setRoots] = React.useState<RootInfo[]>([]);
  const [repoInput, setRepoInput] = React.useState<string>("");
  const [refInput, setRefInput] = React.useState<string>("");
  const [browsing, setBrowsing] = React.useState<boolean>(false);
  const [browse, setBrowse] = React.useState<BrowseResult | undefined>(undefined);
  const [browseError, setBrowseError] = React.useState<string | undefined>(undefined);
  const [browseErrors, setBrowseErrors] = React.useState<readonly FieldError[]>([]);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set<string>());
  const [target, setTarget] = React.useState<InstallTarget>("user-agents");
  const [installing, setInstalling] = React.useState<boolean>(false);
  const [results, setResults] = React.useState<InstallItemResult[] | undefined>(undefined);
  const [installError, setInstallError] = React.useState<string | undefined>(undefined);
  const [installSummary, setInstallSummary] = React.useState<string | undefined>(undefined);
  const [query, setQuery] = React.useState<string>("");
  const [searching, setSearching] = React.useState<boolean>(false);
  const [searchResults, setSearchResults] = React.useState<SearchResultItem[] | undefined>(undefined);
  const [searchError, setSearchError] = React.useState<string | undefined>(undefined);
  const [repos, setRepos] = React.useState<RepoRecord[] | undefined>(undefined);
  const [repoDraft, setRepoDraft] = React.useState<string>("");
  const [repoRefDraft, setRepoRefDraft] = React.useState<string>("");
  const [repoBusy, setRepoBusy] = React.useState<boolean>(false);
  const [repoError, setRepoError] = React.useState<string | undefined>(undefined);
  /** 「+ 添加」默认收起：点开才出现输入框（UI-C：常用仓库那一行要保持整洁）。 */
  const [addRepoOpen, setAddRepoOpen] = React.useState<boolean>(false);

  React.useEffect(() => {
    if (!props.open) return;
    let alive = true;
    void listSkills(workspace).then(
      (data) => {
        if (alive) setRoots(data.roots);
      },
      () => {
        // 拿不到根只影响「目标完整路径」的展示，不阻塞安装
      },
    );
    void listRepos().then(
      (list) => {
        if (alive) setRepos(list);
      },
      (failure: unknown) => {
        if (alive) setRepoError(errorMessage(failure));
      },
    );
    return () => {
      alive = false;
    };
  }, [workspace, props.open]);

  const targetOptions = installTargetOptions(roots, workspace);

  /**
   * 浏览仓库。keepResults=true 用于「安装成功后刷新这一屏的已安装标记」——
   * 这时不能把逐个安装结果清掉（那正是用户要看的东西）。
   */
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
        const free = payload.skills.filter((skill) => skill.installedId === undefined);
        const wanted = preselectPath === undefined ? undefined : payload.skills.find((skill) => skill.skillPath === preselectPath);
        setSelected(
          new Set(
            wanted === undefined || wanted.installedId !== undefined
              ? free.map((skill) => skill.skillPath)
              : [wanted.skillPath],
          ),
        );
        setBrowsing(false);
      },
      (failure: unknown) => {
        setBrowse(undefined);
        setSelected(new Set<string>());
        setBrowseErrors(fieldErrors(failure));
        setBrowseError(errorMessage(failure));
        setBrowsing(false);
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
        setSearching(false);
      },
      (failure: unknown) => {
        setSearchResults(undefined);
        setSearchError(errorMessage(failure));
        setSearching(false);
      },
    );
  };

  const doInstall = (): void => {
    if (browse === undefined || selected.size === 0) return;
    setInstalling(true);
    setInstallError(undefined);
    setResults(undefined);
    void installSkills(
      { repo: browse.repo, ref: browse.ref, skillPaths: [...selected], target },
      workspace,
    ).then(
      (list) => {
        setResults(list);
        setInstalling(false);
        const ok = list.filter((item) => item.ok).length;
        setInstallSummary(installSummaryText(ok, list.length - ok));
        if (ok > 0) {
          props.onInstalled?.();
          void reloadSources(workspace);
          // 刷新「已安装」标记，但保留刚才的逐个结果
          doBrowse(browse.repo, browse.ref, undefined, true);
        }
      },
      (failure: unknown) => {
        setInstallError(errorMessage(failure));
        setInstalling(false);
      },
    );
  };

  const doAddRepo = (): void => {
    if (repoDraft.trim() === "") {
      setRepoError(t("skills.remote.form.required"));
      return;
    }
    setRepoBusy(true);
    setRepoError(undefined);
    void addRepo(repoDraft, repoRefDraft).then(
      (list) => {
        setRepos(list);
        setRepoDraft("");
        setRepoRefDraft("");
        setRepoBusy(false);
        setAddRepoOpen(false);
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
    void removeRepo(repo).then(
      (list) => {
        setRepos(list);
        setRepoBusy(false);
      },
      (failure: unknown) => {
        setRepoError(errorMessage(failure));
        setRepoBusy(false);
      },
    );
  };

  const toggle = (path: string, next: boolean): void => {
    setSelected((previous) => {
      const set = new Set(previous);
      if (next) set.add(path);
      else set.delete(path);
      return set;
    });
  };

  const fieldErrorsNode = browseErrors.length === 0
    ? null
    : browseErrors.map((entry) => React.createElement("p", { key: entry.field + entry.message, className: styles.fieldError }, `${entry.field}：${entry.message}`));

  return React.createElement(Drawer, {
    open: props.open,
    title: t("skills.install.title"),
    subtitle: t("skills.install.subtitle"),
    width: 720,
    testId: "skills-add",
    onClose: props.onClose,
    footer: React.createElement(React.Fragment, null,
      React.createElement("span", { className: styles.fieldLabel }, t("skills.install.target")),
      React.createElement("div", { className: styles.chips, "data-testid": "skills-install-target" },
        targetOptions.map((option) => React.createElement(Pill, {
          key: option.id,
          active: target === option.id,
          "data-testid": "skills-install-target-" + option.id,
          onClick: () => setTarget(option.id),
        }, option.label))),
      React.createElement("span", { className: kit.drawerFootSpacer }),
      React.createElement(Button, {
        variant: "primary",
        disabled: installing || selected.size === 0,
        "data-testid": "skills-install-submit",
        onClick: doInstall,
      }, installing ? t("skills.install.running") : t("skills.install.submit"))),
  },
  React.createElement("div", { className: styles.form, "data-testid": "skills-install-view", "data-browsing": browsing ? "1" : "0" },
    /* ---------- 仓库输入 ---------- */
    // 同一行：仓库输入占满剩余宽度 · 分支固定 140px · 「浏览」靠右（UI-C）。
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
        disabled: browsing,
        "data-testid": "skills-remote-browse-button",
        onClick: () => doBrowse(repoInput, refInput.trim() === "" ? undefined : refInput),
      }, browsing ? t("skills.install.browsing") : t("skills.install.browse"))),
    browseError === undefined ? null : React.createElement("p", { className: styles.errorBox, "data-testid": "skills-remote-browse-error" }, browseError),
    fieldErrorsNode,

    /* ---------- 常用仓库（胶囊里只有名称；× 悬停才出现；「+ 添加」点开才出输入框） ---------- */
    React.createElement("div", { className: styles.form, "data-testid": "skills-remote-repos" },
      React.createElement("span", { className: styles.fieldLabel }, t("skills.install.commonRepos")),
      repos === undefined
        ? React.createElement("p", { className: styles.loading }, t("skills.loading"))
        : React.createElement("div", { className: styles.chips, "data-testid": "skills-remote-repo-list" },
          repos.map((record) => React.createElement("span", {
            key: record.repo,
            className: styles.chip,
            "data-repo": record.repo,
            "data-preset": record.preset ? "1" : "0",
          },
          // 胶囊里只留仓库名：「· 预置」挪到悬停提示里（UI-C）。
          React.createElement(Pill, {
            active: false,
            title: repoChipTitle(record),
            "data-testid": "skills-remote-repo-browse-" + record.repo,
            onClick: () => doBrowse(record.repo, record.ref),
          }, record.repo),
          React.createElement("button", {
            type: "button",
            className: styles.chipRemove,
            title: t("skills.install.repoRemove"),
            "aria-label": t("skills.install.repoRemove") + " " + record.repo,
            "data-testid": "skills-remote-repo-remove-" + record.repo,
            disabled: repoBusy,
            onClick: () => doRemoveRepo(record.repo),
          }, "\u00d7"))),
          addRepoOpen
            ? null
            : React.createElement(Pill, {
              active: false,
              "data-testid": "skills-remote-repo-add-toggle",
              onClick: () => setAddRepoOpen(true),
            }, "+ " + t("skills.install.repoAdd"))),
      addRepoOpen
        ? React.createElement("div", { className: styles.repoRow },
          React.createElement("span", { className: styles.repoGrow },
            React.createElement(Input, {
              value: repoDraft,
              placeholder: t("skills.install.repoAddPlaceholder"),
              "aria-label": t("skills.install.repoAddPlaceholder"),
              "data-testid": "skills-remote-repo-add-input",
              onChange: (event: { target: { value: string } }) => setRepoDraft(event.target.value),
            })),
          React.createElement("span", { className: styles.refGrow },
            React.createElement(Input, {
              value: repoRefDraft,
              placeholder: t("skills.install.refPlaceholder"),
              "aria-label": t("skills.install.refPlaceholder"),
              "data-testid": "skills-remote-repo-add-ref",
              onChange: (event: { target: { value: string } }) => setRepoRefDraft(event.target.value),
            })),
          React.createElement(Button, {
            size: "sm",
            variant: "outline",
            disabled: repoBusy,
            "data-testid": "skills-remote-repo-add",
            onClick: doAddRepo,
          }, t("skills.install.repoAdd")))
        : null,
      repoError === undefined ? null : React.createElement("p", { className: styles.errorBox, "data-testid": "skills-remote-repo-error" }, repoError)),

    /* ---------- skills.sh 搜索 ---------- */
    React.createElement("div", { className: styles.form, "data-testid": "skills-remote-search" },
      React.createElement("span", { className: styles.fieldLabel }, t("skills.remote.search.title")),
      React.createElement("div", { className: styles.repoRow },
        React.createElement("span", { className: styles.repoGrow },
          React.createElement(Input, {
            value: query,
            placeholder: t("skills.remote.search.placeholder"),
            "aria-label": t("skills.remote.search.placeholder"),
            "data-testid": "skills-remote-search-input",
            onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
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
        : React.createElement("div", { className: styles.form, "data-testid": "skills-remote-search-results", "data-count": String(searchResults.length) },
          searchResults.length === 0
            ? React.createElement("p", { className: styles.note, "data-testid": "skills-remote-search-empty" }, t("skills.remote.search.empty"))
            : React.createElement(ListSurface, { testId: "skills-remote-search-list" },
            React.createElement(ListGroup, { title: t("skills.remote.search.results"), count: searchResults.length, testId: "skills-remote-search-group" },
            searchResults.map((item, index) => React.createElement(ListRow, {
              key: item.repo + "-" + item.name + "-" + String(index),
              testId: "skills-remote-search-item-" + String(index),
              title: item.name,
              subtitle: item.repo + (item.installs === undefined ? "" : " · " + t("skills.remote.search.installs", { count: item.installs })),
              hoverActions: [{
                label: t("skills.remote.search.browse"),
                testId: "skills-remote-search-browse-" + String(index),
                onClick: () => doBrowse(item.repo, undefined, item.skillPath),
              }],
            })))))),

    /* ---------- 浏览结果 ---------- */
    browse === undefined
      ? React.createElement("p", { className: styles.note, "data-testid": "skills-install-idle" }, t("skills.install.idle"))
      : React.createElement("div", { className: styles.form, "data-testid": "skills-remote-browse-result", "data-repo": browse.repo, "data-ref": browse.ref, "data-skill-count": String(browse.skills.length) },
        React.createElement("div", { className: styles.inlineRow },
          React.createElement("span", { className: styles.note, "data-testid": "skills-remote-browse-summary" }, t("skills.install.browseResult", { repo: browse.repo, ref: browse.ref, count: browse.skills.length })),
          React.createElement("span", { className: styles.grow }),
          React.createElement("span", { className: styles.code, "data-testid": "skills-remote-selected-count" }, t("skills.install.selectedCount", { count: selected.size })),
          React.createElement(Button, {
            size: "sm",
            variant: "ghost",
            "data-testid": "skills-remote-select-all",
            onClick: () => setSelected(new Set(browse.skills.filter((skill) => skill.installedId === undefined).map((skill) => skill.skillPath))),
          }, t("skills.install.selectAll")),
          React.createElement(Button, {
            size: "sm",
            variant: "ghost",
            "data-testid": "skills-remote-select-none",
            onClick: () => setSelected(new Set<string>()),
          }, t("skills.install.selectNone"))),
        React.createElement(ListSurface, { testId: "skills-remote-browse-list" },
          React.createElement(ListGroup, { title: t("skills.install.browseResults"), count: browse.skills.length, testId: "skills-remote-browse-group" },
          browse.skills.map((skill) => React.createElement(ListRow, {
            key: skill.skillPath,
            testId: "skills-remote-browse-skill-" + skill.dirName,
            leading: React.createElement(Checkbox, {
              checked: selected.has(skill.skillPath),
              disabled: skill.installedId !== undefined,
              label: skill.name ?? skill.dirName,
              onChange: (next: boolean) => toggle(skill.skillPath, next),
            }),
            title: skill.name ?? skill.dirName,
            subtitle: skill.description === undefined ? skill.skillPath : skill.skillPath + " · " + skill.description,
            badges: skill.installedId === undefined
              ? []
              : [React.createElement(Badge, { key: "installed", tone: "neutral" }, t("skills.install.installed"))],
            onOpen: skill.installedId === undefined ? () => toggle(skill.skillPath, !selected.has(skill.skillPath)) : undefined,
          }))))),
    browse === undefined ? null : React.createElement("span", { className: styles.code, "data-testid": "skills-remote-target-path" },
      targetOptions.find((option) => option.id === target)?.path ?? t("skills.install.targetPathUnknown")),
    workspace === undefined || workspace.trim() === ""
      ? React.createElement("p", { className: styles.note }, t("skills.install.targetNoWorkspace"))
      : null,
    installSummary === undefined ? null : React.createElement("p", { className: styles.note, "data-testid": "skills-remote-install-summary" }, installSummary),
    installError === undefined ? null : React.createElement("p", { className: styles.errorBox, "data-testid": "skills-remote-install-error" }, installError),
    results === undefined
      ? null
      : React.createElement("ul", { className: styles.resultList, "data-testid": "skills-remote-install-results" },
        results.map((result, index) => React.createElement("li", {
          key: result.skillPath + "-" + String(index),
          className: styles.resultRow,
          "data-ok": result.ok ? "1" : "0",
          "data-skill-path": result.skillPath,
        },
        React.createElement(Badge, { tone: result.ok ? "neutral" : "danger" }, result.ok ? t("skills.install.ok") : t("skills.install.failed")),
        React.createElement("span", { className: styles.note }, installResultText(result)))))));
}
