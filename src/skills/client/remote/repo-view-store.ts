/**
 * 仓库视图（「添加技能」抽屉，D-B6 / D-B16）的状态与流程（ADR-0005）。
 *
 * 一个仓库持有整个视图的状态：输入框（浏览 / 加入 / 搜索）、临时浏览的结果、仓库列表的编辑、
 * 汇总发现与它的筛选、勾选与安装。动作完成后自己更新快照；组件（install-view.tsx）只渲染、转发操作。
 *
 * 数据访问经 RepoViewAdapter：正式运行是 data.ts 的 HTTP 封装（repoViewApi），单测是内存 fake。
 * 本文件不 import React、不发请求，node:test 直接测。
 */

import { createStore, type Store } from "../../../kit/store.ts";
import type { FieldError } from "../../../platform/contract/host.ts";
import type { RootInfo } from "../../contract/local.ts";
import type {
  BrowseResult,
  DiscoveryRepoView,
  DiscoveryView,
  InstallItemResult,
  InstallTarget,
  SearchResultItem,
} from "../../contract/remote.ts";
import { fieldErrors } from "../format.ts";
import { t } from "../strings.ts";
import {
  DISCOVERY_PAGE,
  discoveredKey,
  discoveryFilterKey,
  installPlan,
  normalizeRepoInput,
  repoScanText,
  shouldAutoScan,
  type InstalledFilter,
} from "./discovery-model.ts";
import { installSummaryText } from "./model.ts";
import { errorText } from "../../../shared/error-text.ts";

/** 访问宿主的 seam。 */
export interface RepoViewAdapter {
  roots(workspace: string | undefined): Promise<RootInfo[]>;
  /** 只读发现缓存，不联网 */
  discovery(workspace: string | undefined): Promise<DiscoveryView>;
  /** 联网扫描（不给 repos = 全部仓库） */
  scan(workspace: string | undefined, repos?: readonly string[]): Promise<DiscoveryView>;
  browse(repo: string, ref: string | undefined, workspace: string | undefined): Promise<BrowseResult>;
  search(query: string): Promise<SearchResultItem[]>;
  addRepo(repo: string, ref: string | undefined, workspace: string | undefined): Promise<DiscoveryView>;
  updateRepo(
    repo: string,
    patch: { ref: string; subPath: string },
    workspace: string | undefined,
  ): Promise<DiscoveryView>;
  removeRepo(repo: string, workspace: string | undefined): Promise<DiscoveryView>;
  install(
    input: { repo: string; ref?: string; skillPaths: readonly string[]; target: InstallTarget },
    workspace: string | undefined,
  ): Promise<InstallItemResult[]>;
}

/** 勾选的一个技能。 */
export interface Picked {
  repo: string;
  ref?: string;
  skillPath: string;
}

export interface RepoResult extends InstallItemResult {
  repo: string;
}

export interface RepoEdit {
  repo: string;
  ref: string;
  subPath: string;
}

export interface RepoViewState {
  roots: RootInfo[];
  /** 顶部唯一的输入框（像仓库地址就浏览 / 加入，否则搜索 skills.sh） */
  entry: string;
  ref: string;
  browsing: boolean;
  /** 临时浏览的仓库；有它时汇总发现让位 */
  browse?: BrowseResult;
  browseError?: string;
  browseFieldErrors: readonly FieldError[];
  searching: boolean;
  searchResults?: SearchResultItem[];
  searchError?: string;
  /** 搜索结果是否展开：从结果里浏览或加入仓库后自动收起 */
  searchOpen: boolean;
  discovery?: DiscoveryView;
  discoveryError?: string;
  scanning: boolean;
  reposOpen: boolean;
  editing?: RepoEdit;
  repoBusy: boolean;
  repoError?: string;
  repoNote?: string;
  /** 汇总发现的筛选 */
  query: string;
  installed: InstalledFilter;
  repoFilter: string;
  /** 每个仓库分组已经渲染了多少行（每批 200）；只对 scope 那一次筛选有效 */
  limits: { scope: string; byRepo: ReadonlyMap<string, number> };
  selected: ReadonlyMap<string, Picked>;
  target: InstallTarget;
  installing: boolean;
  results?: RepoResult[];
  installError?: string;
  installSummary?: string;
  /** 浏览结果 / 安装反馈出现时递增：组件据此把焦点区滚到可见 */
  focusTick: number;
}

export function initialRepoViewState(): RepoViewState {
  return {
    roots: [],
    entry: "",
    ref: "",
    browsing: false,
    browseFieldErrors: [],
    searching: false,
    searchOpen: false,
    scanning: false,
    reposOpen: false,
    repoBusy: false,
    query: "",
    installed: "all",
    repoFilter: "",
    limits: { scope: "", byRepo: new Map() },
    selected: new Map(),
    target: "user-agents",
    installing: false,
    focusTick: 0,
  };
}

export interface RepoViewStore {
  readonly state: Store<RepoViewState>;
  /** 抽屉打开：读安装位置与发现缓存；从没扫过就自动扫一次（之后只有「刷新」才联网）。 */
  open(workspace: string | undefined): Promise<void>;
  setEntry(text: string): void;
  setRef(text: string): void;
  /** 浏览输入框里的仓库 */
  browseEntry(): Promise<void>;
  /** 临时浏览一个仓库；preselect = 浏览后预先勾上这个技能；keepResults = 不清掉上一次的安装结果 */
  browse(repo: string, ref?: string, preselect?: string, keepResults?: boolean): Promise<void>;
  back(): void;
  search(): Promise<void>;
  toggleSearchOpen(): void;
  /** 加入仓库列表（不给 repo = 输入框里的） */
  addRepo(repo?: string, ref?: string): Promise<void>;
  toggleReposOpen(): void;
  startEdit(record: DiscoveryRepoView): void;
  editField(field: "ref" | "subPath", value: string): void;
  cancelEdit(): void;
  saveEdit(): Promise<void>;
  removeRepo(repo: string): Promise<void>;
  /** 联网刷新汇总（不给 repos = 全部仓库） */
  scan(repos?: readonly string[]): Promise<void>;
  setFilter(filter: Partial<Pick<RepoViewState, "query" | "installed" | "repoFilter">>): void;
  /** 某个仓库分组再多显示一批 */
  showMore(repo: string): void;
  toggle(item: Picked, next: boolean): void;
  /** 勾上当前浏览的仓库里所有未安装的技能 */
  selectAllBrowsed(): void;
  setTarget(target: InstallTarget): void;
  /** 按仓库分组依次安装勾选的技能；返回成功个数（> 0 时调用方刷新技能列表与来源） */
  install(): Promise<number>;
}

const sameRepo = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

/** 当前筛选的标识（kit/fold.ts 的 scope，分批渲染也按它重来）。 */
export function filterScope(state: Pick<RepoViewState, "query" | "installed" | "repoFilter">): string {
  return discoveryFilterKey({ query: state.query, installed: state.installed, repo: state.repoFilter });
}

/** 某个仓库分组现在渲染多少行。 */
export function groupLimit(state: RepoViewState, repo: string): number {
  const byRepo = state.limits.scope === filterScope(state) ? state.limits.byRepo : undefined;
  return byRepo?.get(repo.toLowerCase()) ?? DISCOVERY_PAGE;
}

export function createRepoViewStore(adapter: RepoViewAdapter): RepoViewStore {
  const state = createStore<RepoViewState>(initialRepoViewState());
  let workspace: string | undefined;
  /** open() 每调一次加一；旧一轮的回应到了就丢掉（例如切换了工作区） */
  let generation = 0;
  const get = (): RepoViewState => state.get();
  const patch = (partial: Partial<RepoViewState>): void => state.patch(partial);

  const scan = async (repos?: readonly string[]): Promise<void> => {
    const round = generation;
    patch({ scanning: true, discoveryError: undefined });
    try {
      const discovery = await adapter.scan(workspace, repos);
      if (round === generation) patch({ discovery, scanning: false });
    } catch (failure) {
      if (round === generation) patch({ discoveryError: errorText(failure), scanning: false });
    }
  };

  const browse = async (repo: string, ref?: string, preselect?: string, keepResults = false): Promise<void> => {
    patch({
      browsing: true,
      browseError: undefined,
      browseFieldErrors: [],
      ...(keepResults ? {} : { results: undefined, installSummary: undefined }),
    });
    try {
      const result = await adapter.browse(repo, ref, workspace);
      const wanted = preselect === undefined ? undefined : result.skills.find((skill) => skill.skillPath === preselect);
      patch({
        browse: result,
        searchOpen: false,
        browsing: false,
        ...(keepResults ? {} : { focusTick: get().focusTick + 1 }),
        ...(wanted !== undefined && wanted.installedId === undefined
          ? {
              selected: new Map([
                [
                  discoveredKey({ repo: result.repo, skillPath: wanted.skillPath }),
                  { repo: result.repo, ref: result.ref, skillPath: wanted.skillPath },
                ],
              ]),
            }
          : {}),
      });
    } catch (failure) {
      patch({
        browse: undefined,
        browseFieldErrors: fieldErrors(failure),
        browseError: errorText(failure),
        browsing: false,
      });
    }
  };

  /** 仓库列表的增改删：宿主已补扫，直接换上新的发现视图。 */
  const changeRepos = async (run: () => Promise<DiscoveryView>, after?: (discovery: DiscoveryView) => void) => {
    patch({ repoBusy: true, repoError: undefined });
    try {
      const discovery = await run();
      patch({ discovery, repoBusy: false });
      after?.(discovery);
    } catch (failure) {
      patch({ repoError: errorText(failure), repoBusy: false });
    }
  };

  const optionalRef = (ref: string | undefined): string | undefined =>
    ref === undefined || ref.trim() === "" ? undefined : ref;

  return {
    state,
    async open(next) {
      workspace = next;
      generation += 1;
      const round = generation;
      void adapter.roots(next).then(
        (roots) => {
          if (round === generation) patch({ roots });
        },
        () => {
          // 拿不到技能目录只影响安装位置的完整路径提示，不阻塞安装
        },
      );
      try {
        const discovery = await adapter.discovery(next);
        if (round !== generation) return;
        patch({ discovery });
        if (shouldAutoScan(discovery)) await scan();
      } catch (failure) {
        if (round === generation) patch({ discoveryError: errorText(failure) });
      }
    },
    setEntry: (entry) => patch({ entry }),
    setRef: (ref) => patch({ ref }),
    browseEntry: () => browse(normalizeRepoInput(get().entry), optionalRef(get().ref)),
    browse,
    back: () => patch({ browse: undefined }),
    async search() {
      const query = get().entry.trim();
      if (query.length < 2) {
        patch({ searchError: t("skills.remote.search.tooShort"), searchResults: undefined });
        return;
      }
      patch({ searching: true, searchError: undefined });
      try {
        const searchResults = await adapter.search(query);
        patch({ searchResults, searchOpen: true, searching: false });
      } catch (failure) {
        patch({ searchResults: undefined, searchError: errorText(failure), searching: false });
      }
    },
    toggleSearchOpen: () => patch({ searchOpen: !get().searchOpen }),
    async addRepo(repo, ref) {
      const name = repo ?? normalizeRepoInput(get().entry);
      const branch = repo === undefined ? optionalRef(get().ref) : ref;
      if (name.trim() === "") {
        patch({ repoError: t("skills.remote.form.required") });
        return;
      }
      const before = get().discovery?.repos ?? [];
      patch({ repoNote: undefined, searchOpen: false });
      await changeRepos(
        () => adapter.addRepo(name, branch, workspace),
        (discovery) => {
          const added = discovery.repos.find((record) => !before.some((old) => sameRepo(old.repo, record.repo)));
          if (added !== undefined) {
            patch({ repoNote: t("skills.repoView.added", { repo: added.repo, status: repoScanText(added) }) });
          }
        },
      );
    },
    toggleReposOpen: () => patch({ reposOpen: !get().reposOpen }),
    startEdit: (record) =>
      patch({ editing: { repo: record.repo, ref: record.ref ?? "", subPath: record.subPath ?? "" } }),
    editField(field, value) {
      const editing = get().editing;
      if (editing !== undefined) patch({ editing: { ...editing, [field]: value } });
    },
    cancelEdit: () => patch({ editing: undefined }),
    async saveEdit() {
      const editing = get().editing;
      if (editing === undefined) return;
      await changeRepos(
        () => adapter.updateRepo(editing.repo, { ref: editing.ref, subPath: editing.subPath }, workspace),
        () => patch({ editing: undefined }),
      );
    },
    async removeRepo(repo) {
      await changeRepos(
        () => adapter.removeRepo(repo, workspace),
        () => {
          if (sameRepo(get().repoFilter, repo)) patch({ repoFilter: "" });
        },
      );
    },
    scan,
    setFilter: (filter) => patch(filter),
    showMore(repo) {
      const current = get();
      const scope = filterScope(current);
      const base = current.limits.scope === scope ? current.limits.byRepo : new Map<string, number>();
      patch({
        limits: { scope, byRepo: new Map(base).set(repo.toLowerCase(), groupLimit(current, repo) + DISCOVERY_PAGE) },
      });
    },
    toggle(item, next) {
      const selected = new Map(get().selected);
      const key = discoveredKey(item);
      if (next) selected.set(key, item);
      else selected.delete(key);
      patch({ selected });
    },
    selectAllBrowsed() {
      const current = get();
      if (current.browse === undefined) return;
      const { repo, ref, skills } = current.browse;
      const selected = new Map(current.selected);
      for (const skill of skills) {
        if (skill.installedId === undefined) {
          selected.set(discoveredKey({ repo, skillPath: skill.skillPath }), { repo, ref, skillPath: skill.skillPath });
        }
      }
      patch({ selected });
    },
    setTarget: (target) => patch({ target }),
    async install() {
      const current = get();
      const plan = installPlan(current.selected.values());
      if (plan.length === 0) return 0;
      patch({ installing: true, installError: undefined, results: undefined });
      const results: RepoResult[] = [];
      const failures: string[] = [];
      for (const group of plan) {
        try {
          const list = await adapter.install(
            {
              repo: group.repo,
              ...(group.ref === undefined ? {} : { ref: group.ref }),
              skillPaths: group.skillPaths,
              target: current.target,
            },
            workspace,
          );
          for (const item of list) results.push({ ...item, repo: group.repo });
        } catch (failure) {
          failures.push(group.repo + "：" + errorText(failure));
        }
      }
      const ok = results.filter((item) => item.ok).length;
      patch({
        results,
        installing: false,
        focusTick: get().focusTick + 1,
        ...(failures.length > 0 ? { installError: failures.join("；") } : {}),
        installSummary: installSummaryText(ok, results.length - ok),
        selected: new Map(),
      });
      if (ok > 0) {
        // 「已安装」是读取时现算的：重读缓存即可，不联网
        void adapter.discovery(workspace).then(
          (discovery) => patch({ discovery }),
          () => undefined,
        );
        const browsed = get().browse;
        if (browsed !== undefined) void browse(browsed.repo, browsed.ref, undefined, true);
      }
      return ok;
    },
  };
}
