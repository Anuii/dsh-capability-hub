/**
 * skills-remote 工厂（PLAN §3.4）。
 *
 *   export function createSkillsRemoteModule(ctx, deps, options?) 
 *     → HubModule & { lockStash: LockStash }
 *
 * 契约要求 createSkillsRemoteModule(ctx, deps) 即可用；第三个参数是可选的注入点
 * （fetchImpl / ghTokenProvider / now 等），仅用于测试与宿主替换，默认全部走真实实现。
 */

import { GitHubClient, type GitHubClientOptions } from './github.ts';
import { Redactor, createRedactingLogger } from './redact.ts';
import { createSourceStore, type SourceStore } from './lockstore.ts';
import { createRepoStore, type RepoStore } from './repos.ts';
import { createDiscoveryStore } from './repo-discovery.ts';
import { createSkillsRemoteRoutes } from './routes.ts';
import type { HubContext, HubModule, LockStash, RemoteOptions, SkillsLocalApi } from './types.ts';

export interface SkillsRemoteDeps {
  skills: SkillsLocalApi;
}

export interface SkillsRemoteModule extends HubModule {
  lockStash: LockStash;
}

export function createSkillsRemoteModule(
  ctx: HubContext,
  deps: SkillsRemoteDeps,
  options: RemoteOptions = {}
): SkillsRemoteModule {
  const redactor = new Redactor();
  const logger = createRedactingLogger(ctx.logger, redactor);
  const scopedCtx: HubContext = { ...ctx, logger };

  const githubOptions: GitHubClientOptions = {
    logger,
    onSecret: (secret) => redactor.add(secret),
  };
  if (options.fetchImpl) githubOptions.fetchImpl = options.fetchImpl;
  if (options.envTokenProvider) githubOptions.envTokenProvider = options.envTokenProvider;
  if (options.ghTokenProvider) githubOptions.ghTokenProvider = options.ghTokenProvider;
  if (options.cacheAuth !== undefined) githubOptions.cacheAuth = options.cacheAuth;

  const github = new GitHubClient(githubOptions);
  const sources: SourceStore = createSourceStore(scopedCtx);
  const repos: RepoStore = createRepoStore(scopedCtx);

  const routes = createSkillsRemoteRoutes({
    ctx: scopedCtx,
    skills: deps.skills,
    github,
    sources,
    repos,
    discovery: createDiscoveryStore(scopedCtx),
    redactor,
    now: options.now,
  });

  logger.debug('skills-remote 模块已就绪', { hubHome: ctx.hubHome, profile: ctx.profileName });

  return {
    routes,
    lockStash: sources.stash,
  };
}

export type { SkillsLocalApi, LockStash, HubContext, HubModule } from './types.ts';
