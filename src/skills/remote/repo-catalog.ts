/**
 * 仓库列表 + 发现（D-B16）的唯一入口：RepoCatalog。
 *
 * 仓库列表的规则都在这里，路由只做参数解析：
 *   - 读（view）只读发现缓存、不联网；「是否已安装」每次按本机技能列表现算；
 *   - 加入仓库只补扫这一个（同一个请求里扫完再返回）；
 *   - 修改分支 / 子目录：真的变了才重扫这一个，没变只重读；
 *   - 移除仓库同时删掉它的发现结果；
 *   - 补扫失败已记在该仓库条目上，这里再吞掉取消等意外——增改仓库本身不因扫描失败而失败。
 *
 * 落盘：<hubHome>/skills/repos.json（repos.ts）与 discovery.json（repo-discovery.ts）。
 */

import { readDiscovery, refreshDiscovery, forgetDiscovery, type DiscoveryDeps } from "./repo-discovery.ts";
import type { RepoPatch } from "./repos.ts";
import type { DiscoveryView, RepoRecord } from "../contract/remote.ts";

export interface RepoChange {
  repos: RepoRecord[];
  discovery: DiscoveryView;
}

export interface RepoCatalog {
  list(): Promise<RepoRecord[]>;
  /** 只读视图（不联网） */
  view(workspace?: string): Promise<DiscoveryView>;
  /** 联网刷新：不给 repos = 全部；给了就只扫这些（必须在列表里，否则 NOT_FOUND） */
  refresh(options?: { repos?: string[]; workspace?: string; signal?: AbortSignal }): Promise<DiscoveryView>;
  add(
    input: { repo: string; ref?: string; subPath?: string },
    options?: { workspace?: string; signal?: AbortSignal },
  ): Promise<RepoChange & { repo: RepoRecord }>;
  update(
    repo: string,
    patch: RepoPatch,
    options?: { workspace?: string; signal?: AbortSignal },
  ): Promise<RepoChange & { repo: RepoRecord; changed: boolean }>;
  remove(repo: string, options?: { workspace?: string }): Promise<RepoChange>;
}

export function createRepoCatalog(deps: DiscoveryDeps): RepoCatalog {
  const view = (workspace?: string): Promise<DiscoveryView> =>
    readDiscovery(deps, workspace !== undefined && workspace !== "" ? { workspace } : {});

  /** 只补扫一个仓库；失败已记在该仓库条目上，这里只吞掉取消等意外。 */
  const rescanOne = async (repo: string, workspace?: string, signal?: AbortSignal): Promise<DiscoveryView> => {
    try {
      return await refreshDiscovery(deps, { repos: [repo], workspace, signal });
    } catch {
      return await view(workspace);
    }
  };

  return {
    list: () => deps.repos.list(),
    view,
    refresh: (options = {}) => refreshDiscovery(deps, options),
    async add(input, options = {}) {
      const record = await deps.repos.add(input.repo, input.ref, input.subPath);
      const discovery = await rescanOne(record.repo, options.workspace, options.signal);
      return { repo: record, repos: await deps.repos.list(), discovery };
    },
    async update(repo, patch, options = {}) {
      const { record, changed } = await deps.repos.update(repo, patch);
      const discovery = changed
        ? await rescanOne(record.repo, options.workspace, options.signal)
        : await view(options.workspace);
      return { repo: record, changed, repos: await deps.repos.list(), discovery };
    },
    async remove(repo, options = {}) {
      await deps.repos.remove(repo);
      await forgetDiscovery(deps.store, repo);
      return { repos: await deps.repos.list(), discovery: await view(options.workspace) };
    },
  };
}
