/**
 * GitHub 访问层：凭据链、默认分支查询、codeload tar.gz 下载、skills.sh 搜索。
 *
 * 凭据链（D-B9）：GITHUB_TOKEN → 子进程 `gh auth token`（5 秒超时，失败静默）→ 匿名。
 * 令牌只在 GitHubClient 内部持有，不进日志、不进响应、不落盘；日志经 redactor 二次兜底。
 *
 * fetch 可注入（RemoteOptions.fetchImpl），单测用假 fetch 全覆盖。
 */

import type { AuthMode } from '../contract/remote.ts';

import { execFile } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { upstream, rateLimited } from './errors.ts';
import { readTarEntries, type TarEntry } from './tar.ts';
import type { HubLogger } from '../../platform/contract/host.ts';

export const API_TIMEOUT_MS = 15_000;
export const CODELOAD_TIMEOUT_MS = 60_000;
export const SKILLS_SH_TIMEOUT_MS = 10_000;
export const GH_TOKEN_TIMEOUT_MS = 5_000;
export const SKILLS_SH_SEARCH_URL = 'https://skills.sh/api/search';
/** 查询剩余额度用的端点；GitHub 明确说明它**不消耗配额** */
export const RATE_LIMIT_URL = 'https://api.github.com/rate_limit';
export const USER_AGENT = 'dsh-capability-hub';

export interface AuthState {
  mode: AuthMode;
  /** 仅内部使用；绝不出现在日志/响应里 */
  token?: string;
  rateLimitRemaining?: number;
  /** epoch 秒 */
  rateLimitReset?: number;
}

export interface RateLimitInfo {
  remaining?: number;
  /** ISO 时间（本地时区可读化后仍给出原始 epoch 秒的 ISO） */
  resetAt?: string;
  limit?: number;
}

export interface GitHubClientOptions {
  fetchImpl?: typeof fetch;
  logger: HubLogger;
  /** 已知敏感值（令牌）写入 redactor；由构造方在取到令牌后调用 */
  onSecret?: (secret: string) => void;
  envTokenProvider?: () => string | undefined;
  ghTokenProvider?: () => Promise<string | undefined>;
  cacheAuth?: boolean;
}

export interface TarballResult {
  entries: TarEntry[];
  ref: string;
  bytes: number;
  /** 归档里第一级根目录名（形如 repo-HEAD） */
  rootName: string;
}

function defaultEnvToken(): string | undefined {
  const raw = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
  const token = raw?.trim();
  return token ? token : undefined;
}

/**
 * 默认的 gh 令牌提供者：执行 `gh auth token`，5 秒超时，任何失败静默返回 undefined。
 * 子进程 stdout 只用于取值，绝不打印。
 */
export async function ghAuthToken(): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve) => {
    execFile(
      'gh',
      ['auth', 'token'],
      { timeout: GH_TOKEN_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const token = String(stdout).trim();
        resolve(token === '' ? undefined : token);
      }
    );
  });
}

export function parseRateLimit(headers: Headers): RateLimitInfo {
  const remainingText = headers.get('x-ratelimit-remaining');
  const resetText = headers.get('x-ratelimit-reset');
  const limitText = headers.get('x-ratelimit-limit');
  const remaining = remainingText === null ? undefined : Number.parseInt(remainingText, 10);
  const resetSeconds = resetText === null ? undefined : Number.parseInt(resetText, 10);
  const limit = limitText === null ? undefined : Number.parseInt(limitText, 10);
  return {
    remaining: Number.isFinite(remaining as number) ? remaining : undefined,
    resetAt:
      Number.isFinite(resetSeconds as number) && (resetSeconds as number) > 0
        ? new Date((resetSeconds as number) * 1000).toISOString()
        : undefined,
    limit: Number.isFinite(limit as number) ? limit : undefined,
  };
}

/** 解析 GET /rate_limit 的响应体（resources.core 优先，其次是兼容字段 rate） */
function parseRateLimitBody(payload: unknown): RateLimitInfo | undefined {
  const record = (payload ?? {}) as Record<string, unknown>;
  const resources = record['resources'];
  const core = ((resources as Record<string, unknown> | undefined)?.['core'] ?? record['rate']) as
    | Record<string, unknown>
    | undefined;
  if (!core || typeof core !== 'object') return undefined;
  const remaining = typeof core['remaining'] === 'number' ? core['remaining'] : undefined;
  const limit = typeof core['limit'] === 'number' ? core['limit'] : undefined;
  const reset = typeof core['reset'] === 'number' ? core['reset'] : undefined;
  const info: RateLimitInfo = {};
  if (remaining !== undefined) info.remaining = remaining;
  if (limit !== undefined) info.limit = limit;
  if (reset !== undefined && reset > 0) info.resetAt = new Date(reset * 1000).toISOString();
  if (info.remaining === undefined && info.limit === undefined && info.resetAt === undefined) return undefined;
  return info;
}

function formatLocal(iso?: string): string {
  if (!iso) return '稍后';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '稍后';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function rateLimitMessage(info: RateLimitInfo): string {
  const remaining = info.remaining ?? 0;
  return `GitHub 接口触发速率限制（剩余额度 ${remaining}，将于 ${formatLocal(info.resetAt)} 重置）。可在环境变量里设置 GITHUB_TOKEN，或先执行 gh auth login，以提高额度。`;
}

export function isRateLimitResponse(status: number, headers: Headers): boolean {
  if (status !== 403 && status !== 429) return false;
  const remaining = headers.get('x-ratelimit-remaining');
  if (remaining === '0') return true;
  return status === 429;
}

export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: HubLogger;
  private readonly envTokenProvider: () => string | undefined;
  private readonly ghTokenProvider: () => Promise<string | undefined>;
  private readonly cacheAuth: boolean;
  private readonly onSecret: (secret: string) => void;
  private cached?: AuthState;
  private lastRateLimit?: RateLimitInfo;

  constructor(options: GitHubClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
    this.envTokenProvider = options.envTokenProvider ?? defaultEnvToken;
    this.ghTokenProvider = options.ghTokenProvider ?? ghAuthToken;
    this.cacheAuth = options.cacheAuth ?? true;
    this.onSecret = options.onSecret ?? (() => {});
  }

  get lastKnownRateLimit(): RateLimitInfo | undefined {
    return this.lastRateLimit;
  }

  /** 凭据链：环境变量 → gh → 匿名。结果可缓存（默认缓存；注入 gh 的测试用 cacheAuth=false）。 */
  async auth(): Promise<AuthState> {
    if (this.cached) return this.cached;
    const fromEnv = this.envTokenProvider()?.trim();
    if (fromEnv) {
      this.onSecret(fromEnv);
      const state: AuthState = { mode: 'env', token: fromEnv };
      this.cached = this.cacheAuth ? state : undefined;
      return state;
    }
    const fromGh = (await this.ghTokenProvider())?.trim();
    if (fromGh) {
      this.onSecret(fromGh);
      const state: AuthState = { mode: 'gh', token: fromGh };
      this.cached = this.cacheAuth ? state : undefined;
      return state;
    }
    const state: AuthState = { mode: 'anonymous' };
    this.cached = this.cacheAuth ? state : undefined;
    return state;
  }

  /** 仅供测试/诊断：清掉凭据缓存 */
  resetAuthCache(): void {
    this.cached = undefined;
  }

  /**
   * 主动查询剩余额度（FIX-6 / D-3）：GET /rate_limit —— 该端点不消耗配额。
   * 任何失败（网络错误 / HTTP 非 2xx / 响应不是合法 JSON）都返回 undefined，
   * 由调用方省略该字段 —— 绝不因为查不到额度而报错。
   * 令牌只作为请求头发出去，绝不进日志、返回值或错误信息。
   */
  async rateLimit(): Promise<RateLimitInfo | undefined> {
    let response: Response;
    try {
      response = await this.request(RATE_LIMIT_URL, {
        accept: 'application/vnd.github+json',
        timeoutMs: API_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.warn('查询 GitHub 剩余额度失败', (error as Error).message);
      return undefined;
    }
    if (!response.ok) return undefined;
    try {
      const info = parseRateLimitBody(await response.json());
      if (info === undefined) return undefined;
      this.lastRateLimit = info;
      return info;
    } catch {
      return undefined;
    }
  }

  private headers(token: string | undefined, accept: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: accept, 'User-Agent': USER_AGENT };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  private async request(
    url: string,
    init: { accept: string; timeoutMs: number; method?: string; signal?: AbortSignal }
  ): Promise<Response> {
    const auth = await this.auth();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    const onAbort = () => controller.abort();
    init.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers: this.headers(auth.token, init.accept),
        signal: controller.signal,
        redirect: 'follow',
      });
      // FIX-6（D-3）：**每一个** GitHub 响应（成功或失败）都读一次 x-ratelimit-*。
      // 旧实现只在 throwForResponse（错误路径）里记，于是成功路径永远拿不到配额，
      // GET skills/github-auth 与 skills/updates/check 的 rateLimitRemaining 恒为 undefined。
      this.noteRateLimit(response);
      return response;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', onAbort);
    }
  }

  private noteRateLimit(response: Response): void {
    const info = parseRateLimit(response.headers);
    if (info.remaining !== undefined || info.resetAt !== undefined) this.lastRateLimit = info;
  }

  private throwForResponse(url: string, response: Response, what: string): never {
    if (isRateLimitResponse(response.status, response.headers)) {
      const info = parseRateLimit(response.headers);
      throw rateLimited(rateLimitMessage(info), { url, remaining: info.remaining, resetAt: info.resetAt });
    }
    if (response.status === 401 || response.status === 403) {
      throw upstream(`${what}被 GitHub 拒绝（HTTP ${response.status}）：仓库不存在、不是公开仓库，或当前凭据无权访问。`, {
        url,
        status: response.status,
      });
    }
    if (response.status === 404) {
      throw upstream(`${what}失败：在 GitHub 上找不到对应仓库或分支（HTTP 404）。请检查仓库名是否正确、是否为公开仓库。`, {
        url,
        status: response.status,
      });
    }
    throw upstream(`${what}失败：GitHub 返回 HTTP ${response.status}。`, { url, status: response.status });
  }

  /** 查询仓库默认分支。仓库不存在或网络异常时返回 undefined（调用方按 main/master 回退）。 */
  async defaultBranch(repo: string): Promise<string | undefined> {
    let response: Response;
    try {
      response = await this.request(`https://api.github.com/repos/${repo}`, {
        accept: 'application/vnd.github+json',
        timeoutMs: API_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.warn('查询默认分支时网络失败', (error as Error).message);
      return undefined;
    }
    if (!response.ok) return undefined;
    try {
      const data = (await response.json()) as { default_branch?: unknown };
      return typeof data.default_branch === 'string' ? data.default_branch : undefined;
    } catch {
      return undefined;
    }
  }

  /** 下载并解析 codeload tar.gz。ref 缺省时按 HEAD → 默认分支 → main → master 依次尝试。 */
  async downloadTarball(repo: string, ref?: string, signal?: AbortSignal): Promise<TarballResult> {
    const candidates = await this.candidateRefs(repo, ref);
    let lastError: unknown;
    let sawRateLimit = false;
    for (const candidate of candidates) {
      try {
        const result = await this.fetchTarball(repo, candidate, signal);
        return { ...result, ref: candidate };
      } catch (error) {
        lastError = error;
        const message = (error as { code?: string }).code;
        if (message === 'RATE_LIMITED') sawRateLimit = true;
      }
    }
    if (lastError !== undefined) throw lastError;
    throw sawRateLimit
      ? rateLimited(rateLimitMessage(this.lastRateLimit ?? {}))
      : upstream(`下载 ${repo} 失败：没有可用的分支。`);
  }

  private async candidateRefs(repo: string, ref?: string): Promise<string[]> {
    if (ref !== undefined && ref.trim() !== '') return [ref.trim()];
    const out: string[] = [];
    const push = (value: string | undefined) => {
      if (value && !out.includes(value)) out.push(value);
    };
    push(await this.defaultBranch(repo));
    push('main');
    push('master');
    push('HEAD');
    return out;
  }

  private async fetchTarball(repo: string, ref: string, signal?: AbortSignal): Promise<TarballResult> {
    const url = `https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`;
    let response: Response;
    try {
      response = await this.request(url, {
        accept: 'application/x-gzip',
        timeoutMs: CODELOAD_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      throw upstream(`下载 ${repo}@${ref} 失败：网络错误（${(error as Error).message}）。请检查网络连接后重试。`, {
        url,
        repo,
        ref,
      });
    }
    if (!response.ok) this.throwForResponse(url, response, `下载 ${repo}@${ref}`);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw upstream(`下载 ${repo}@${ref} 失败：读取响应体出错（${(error as Error).message}）。`, { url });
    }
    let tarBytes: Buffer;
    try {
      tarBytes = gunzipSync(bytes);
    } catch (error) {
      throw upstream(`下载 ${repo}@${ref} 失败：归档不是合法 gzip（${(error as Error).message}）。`, { url });
    }
    const entries = readTarEntries(tarBytes);
    if (entries.length === 0) {
      throw upstream(`下载 ${repo}@${ref} 失败：归档里没有任何文件，可能该分支为空。`, { url });
    }
    const rootName = entries[0]!.path.split('/')[0] ?? '';
    return { entries, ref, bytes: bytes.length, rootName };
  }

  /** skills.sh 公共搜索接口。拿不到就抛 UPSTREAM（docs 有说明）。 */
  async searchSkillsSh(query: string, limit = 20, offset = 0): Promise<unknown> {
    const url = `${SKILLS_SH_SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;
    let response: Response;
    try {
      response = await this.request(url, { accept: 'application/json', timeoutMs: SKILLS_SH_TIMEOUT_MS });
    } catch (error) {
      throw upstream(`搜索 skills.sh 失败：网络错误（${(error as Error).message}）。`, { url });
    }
    if (isRateLimitResponse(response.status, response.headers)) {
      throw rateLimited(rateLimitMessage(parseRateLimit(response.headers)), { url });
    }
    if (!response.ok) {
      throw upstream(`搜索 skills.sh 失败：服务返回 HTTP ${response.status}。`, { url, status: response.status });
    }
    try {
      return await response.json();
    } catch (error) {
      throw upstream(`搜索 skills.sh 失败：响应不是合法 JSON（${(error as Error).message}）。`, { url });
    }
  }
}

/** 解析 skills.sh 的响应（字段名与 CC Switch 实测一致：query / searchType / skills / count）。 */
export interface SkillsShSearchItem {
  name: string;
  description?: string;
  repo: string;
  skillPath?: string;
  installs?: number;
}

export function normalizeSkillsShResponse(
  payload: unknown,
  options: { skillPathLookup?: (repo: string, skillId: string) => string | undefined } = {}
): SkillsShSearchItem[] {
  const raw = (payload ?? {}) as { skills?: unknown };
  const list = Array.isArray(raw.skills) ? raw.skills : [];
  const out: SkillsShSearchItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const source = typeof record['source'] === 'string' ? record['source'] : '';
    const name = typeof record['name'] === 'string' ? record['name'] : '';
    const [owner, repo] = source.split('/');
    if (!owner || !repo || name === '') continue;
    // owner 必须是合法的 GitHub 用户名（不含点，因此 "skills.volces.com" 这类非 GitHub 来源被过滤）
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) continue;
    const skillId = typeof record['skillId'] === 'string' ? record['skillId'] : name;
    const installs = typeof record['installs'] === 'number' ? record['installs'] : undefined;
    const item2: SkillsShSearchItem = {
      name,
      repo: `${owner}/${repo}`,
      skillPath: options.skillPathLookup?.(source, skillId),
      installs,
    };
    const description = record['description'];
    if (typeof description === 'string' && description.trim() !== '') item2.description = description;
    out.push(item2);
  }
  return out;
}
