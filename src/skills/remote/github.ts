/**
 * GitHub 访问层：凭据链、默认分支查询、目录树（trees API）、raw 文件下载、
 * codeload tar.gz 下载、skills.sh 搜索、GitHub 镜像。
 *
 * 凭据链（D-B9）：GITHUB_TOKEN → 子进程 `gh auth token`（5 秒超时，失败静默）→ 匿名。
 * `gh` 不在 PATH 里时（ENOENT）在 Windows 上依次试常见安装位置（ghCandidatePaths）。
 * 令牌只在 GitHubClient 内部持有，不进日志、不进响应、不落盘；日志经 redactor 二次兜底。
 *
 * GitHub 镜像（D-B18）：前缀式，只作用于**下载类**地址（raw.githubusercontent.com /
 * codeload.github.com）—— 实际请求 = 镜像前缀 + 原始完整 URL。走镜像的请求绝不带
 * Authorization（令牌不给第三方）；api.github.com 与 skills.sh 永不走镜像。
 *
 * fetch 可注入（RemoteOptions.fetchImpl），单测用假 fetch 全覆盖。
 */

import path from "node:path";
import type { AuthMode } from "../contract/remote.ts";

import { execFile } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { upstream, rateLimited } from "../../shared/errors.ts";
import { readTarEntries, type TarEntry } from "./tar.ts";
import { mapLimited } from "./limited.ts";
import type { HubLogger } from "../../platform/contract/host.ts";

export const API_TIMEOUT_MS = 15_000;
export const CODELOAD_TIMEOUT_MS = 60_000;
export const SKILLS_SH_TIMEOUT_MS = 10_000;
export const GH_TOKEN_TIMEOUT_MS = 5_000;
/** 目录树查询（trees API，一次给出整棵树的 sha） */
export const TREES_TIMEOUT_MS = 30_000;
/** 单个 raw 文件下载 */
export const RAW_TIMEOUT_MS = 30_000;
/** 镜像自检（取一个很小的公开文件） */
export const MIRROR_TEST_TIMEOUT_MS = 15_000;
/** 镜像自检用的公开文件（raw.githubusercontent.com 上的小文件） */
export const MIRROR_TEST_URL = "https://raw.githubusercontent.com/vercel-labs/skills/main/README.md";
/**
 * 一次操作（一次检查 / 一次安装 / 一次更新）里同时最多几个网络请求（D-B18）。
 *
 * 放在**操作**层而不是「每个目录」层：检查更新会并行处理多个仓库，每个仓库下又有一批
 * raw 文件，各算各的上限会被乘开（4 组 × 每组 12 个 = 48 个在途）。整次操作共用这一个数。
 */
export const OPERATION_CONCURRENCY = 12;
/** 下载类地址的 host —— 只有这两个走镜像 */
export const MIRRORED_HOSTS: readonly string[] = ["raw.githubusercontent.com", "codeload.github.com"];
export const SKILLS_SH_SEARCH_URL = "https://skills.sh/api/search";
/** 查询剩余额度用的端点；GitHub 明确说明它**不消耗配额** */
export const RATE_LIMIT_URL = "https://api.github.com/rate_limit";
export const USER_AGENT = "dsh-capability-hub";

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
  /**
   * GitHub 镜像前缀（D-B18）。可以是固定字符串，也可以是「每次请求时现读」的提供者
   * （设置页保存后无需重建客户端）。undefined / 空串 = 不走镜像。
   */
  mirrorProvider?: string | (() => string | undefined | Promise<string | undefined>);
}

export interface TarballResult {
  entries: TarEntry[];
  ref: string;
  bytes: number;
  /** 归档里第一级根目录名（形如 repo-HEAD） */
  rootName: string;
}

/** 一棵目录树（GET /repos/{repo}/git/trees/{ref}?recursive=1）里的一条 */
export interface TreeEntry {
  path: string;
  /** blob（文件）/ tree（目录）/ commit（子模块） */
  type: string;
  sha: string;
  mode?: string;
}

/** 解析后的目录树：sha = 根 tree sha，按路径索引每一条 */
export interface TreeSnapshot {
  /** 实际解析到的 ref（缺省时是 "HEAD"） */
  ref: string;
  /** 根 tree 的 sha（根级技能的指纹） */
  sha: string;
  /** path → 条目 */
  byPath: Map<string, TreeEntry>;
  /** 树太大被 GitHub 截断（调用方必须回退 tar.gz） */
  truncated: boolean;
}

/** 镜像是否作用于这个地址（只有下载类地址走镜像；api.github.com 与 skills.sh 永不） */
export function isMirroredUrl(url: string): boolean {
  try {
    return MIRRORED_HOSTS.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** 实际请求地址 = 镜像前缀 + 原始完整 URL（例：https://ghfast.top/https://raw.githubusercontent.com/...） */
export function applyMirror(url: string, mirror: string | undefined): string {
  const prefix = (mirror ?? "").trim();
  if (prefix === "" || !isMirroredUrl(url)) return url;
  return prefix.endsWith("/") ? prefix + url : `${prefix}/${url}`;
}

/** 镜像失败时的中文说明：说清是哪个镜像、怎么清掉重试（绝不静默回退直连）。 */
export function mirrorFailureMessage(mirror: string, reason: string): string {
  return `通过镜像 ${mirror} 下载失败：${reason}；可在技能页「⋯ → GitHub 镜像」里清空镜像后重试。`;
}

function defaultEnvToken(): string | undefined {
  const raw = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  const token = raw?.trim();
  return token ? token : undefined;
}

/**
 * gh 可执行文件的候选路径（纯函数，便于单测）。
 *
 * Windows 上 GitHub CLI 装完后常不在 PATH 里（MSI / winget / scoop 各写各的位置），
 * 于是 `execFile("gh")` 直接 ENOENT。这里按「先 PATH、再这些位置」的顺序给候选：
 *   0. "gh"（PATH 查找；非 win32 上这是唯一候选）
 *   1. %LOCALAPPDATA%\Programs\GitHub CLI\gh.exe
 *   2. %ProgramFiles%\GitHub CLI\gh.exe
 *   3. %ProgramFiles(x86)%\GitHub CLI\gh.exe
 *   4. %LOCALAPPDATA%\Microsoft\WinGet\Links\gh.exe
 *   5. %USERPROFILE%\scoop\shims\gh.exe
 */
export function ghCandidatePaths(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): string[] {
  const candidates = ["gh"];
  if (platform !== "win32") return candidates;
  const localAppData = env["LOCALAPPDATA"];
  const programFiles = env["ProgramFiles"];
  const programFilesX86 = env["ProgramFiles(x86)"];
  const userProfile = env["USERPROFILE"];
  if (localAppData) {
    candidates.push(path.join(localAppData, "Programs", "GitHub CLI", "gh.exe"));
    candidates.push(path.join(localAppData, "Microsoft", "WinGet", "Links", "gh.exe"));
  }
  if (programFiles) candidates.push(path.join(programFiles, "GitHub CLI", "gh.exe"));
  if (programFilesX86) candidates.push(path.join(programFilesX86, "GitHub CLI", "gh.exe"));
  if (userProfile) candidates.push(path.join(userProfile, "scoop", "shims", "gh.exe"));
  return candidates;
}

/** 子进程错误是否表示「这个可执行文件根本不存在」 */
export function isExecutableMissing(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === "ENOENT") return true;
  const message = String((error as { message?: unknown }).message ?? "");
  return /不是内部或外部命令|is not recognized as an internal or external command|not recognized as the name/i.test(
    message,
  );
}

/** 一次 `gh auth token` 的结果：拿到令牌 / 命令不存在 / 命令存在但失败（未登录等） */
export interface GhProbeResult {
  token?: string;
  /** 可执行文件不存在（ENOENT / Windows 的「不是内部或外部命令」） */
  missing: boolean;
}

/** 默认探测：执行一次 `gh auth token`（5 秒超时）。stdout 只用于取值，绝不打印、绝不进日志。 */
export function probeGhToken(command: string): Promise<GhProbeResult> {
  return new Promise<GhProbeResult>((resolve) => {
    execFile(
      command,
      ["auth", "token"],
      {
        timeout: GH_TOKEN_TIMEOUT_MS,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
      (error, stdout) => {
        if (error) {
          resolve({ missing: isExecutableMissing(error) });
          return;
        }
        const token = String(stdout).trim();
        resolve({ token: token === "" ? undefined : token, missing: false });
      },
    );
  });
}

/**
 * 默认的 gh 令牌提供者：执行 `gh auth token`，5 秒超时，任何失败静默返回 undefined。
 *
 * D-B9：先按现在的方式执行 "gh"（走 PATH）；**只有**因为「找不到可执行文件」（ENOENT
 * 或 Windows 的「不是内部或外部命令」）失败时才继续试 ghCandidatePaths 里的常见安装位置。
 * 命令存在但失败（未登录、超时等）就此打住 —— 那是用户的凭据状态，不是路径问题。
 * 令牌只在进程内传递，绝不打印、不进日志、不进返回值。
 */
export async function ghAuthToken(
  options: {
    env?: Record<string, string | undefined>;
    platform?: string;
    probe?: (command: string) => Promise<GhProbeResult>;
  } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const probe = options.probe ?? probeGhToken;
  const candidates = ghCandidatePaths(env, options.platform ?? process.platform);
  for (const candidate of candidates) {
    const result = await probe(candidate);
    if (result.token !== undefined && result.token !== "") return result.token;
    if (!result.missing) return undefined;
  }
  return undefined;
}

export function parseRateLimit(headers: Headers): RateLimitInfo {
  const remainingText = headers.get("x-ratelimit-remaining");
  const resetText = headers.get("x-ratelimit-reset");
  const limitText = headers.get("x-ratelimit-limit");
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
  const resources = record["resources"];
  const core = ((resources as Record<string, unknown> | undefined)?.["core"] ?? record["rate"]) as
    | Record<string, unknown>
    | undefined;
  if (!core || typeof core !== "object") return undefined;
  const remaining = typeof core["remaining"] === "number" ? core["remaining"] : undefined;
  const limit = typeof core["limit"] === "number" ? core["limit"] : undefined;
  const reset = typeof core["reset"] === "number" ? core["reset"] : undefined;
  const info: RateLimitInfo = {};
  if (remaining !== undefined) info.remaining = remaining;
  if (limit !== undefined) info.limit = limit;
  if (reset !== undefined && reset > 0) info.resetAt = new Date(reset * 1000).toISOString();
  if (info.remaining === undefined && info.limit === undefined && info.resetAt === undefined) return undefined;
  return info;
}

function formatLocal(iso?: string): string {
  if (!iso) return "稍后";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "稍后";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function rateLimitMessage(info: RateLimitInfo): string {
  const remaining = info.remaining ?? 0;
  return `GitHub 接口触发速率限制（剩余额度 ${remaining}，将于 ${formatLocal(info.resetAt)} 重置）。可在环境变量里设置 GITHUB_TOKEN，或先执行 gh auth login，以提高额度。`;
}

export function isRateLimitResponse(status: number, headers: Headers): boolean {
  if (status !== 403 && status !== 429) return false;
  const remaining = headers.get("x-ratelimit-remaining");
  if (remaining === "0") return true;
  return status === 429;
}

export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: HubLogger;
  private readonly envTokenProvider: () => string | undefined;
  private readonly ghTokenProvider: () => Promise<string | undefined>;
  private readonly cacheAuth: boolean;
  private readonly onSecret: (secret: string) => void;
  private mirror: string | undefined;
  /** setMirror 显式设过（优先于 mirrorProvider 的每次现读） */
  private mirrorExplicit = false;
  private readonly mirrorProvider?: string | (() => string | undefined | Promise<string | undefined>);
  private cached?: AuthState;
  private lastRateLimit?: RateLimitInfo;

  constructor(options: GitHubClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
    this.envTokenProvider = options.envTokenProvider ?? defaultEnvToken;
    this.ghTokenProvider = options.ghTokenProvider ?? ghAuthToken;
    this.cacheAuth = options.cacheAuth ?? true;
    this.onSecret = options.onSecret ?? (() => {});
    this.mirrorProvider = options.mirrorProvider;
    this.mirror = typeof options.mirrorProvider === "string" ? options.mirrorProvider : undefined;
  }

  get lastKnownRateLimit(): RateLimitInfo | undefined {
    return this.lastRateLimit;
  }

  /**
   * 设置页保存镜像后即时生效（不必重建客户端）。
   * 显式设过之后就以这个值为准（settings.json 里写的也是同一个值，两者一致）。
   */
  setMirror(mirror: string | undefined): void {
    this.mirror = mirror;
    this.mirrorExplicit = true;
  }

  private async currentMirror(): Promise<string | undefined> {
    if (this.mirrorExplicit) return this.mirror;
    if (typeof this.mirrorProvider === "function") return await this.mirrorProvider();
    return this.mirror;
  }

  /** 凭据链：环境变量 → gh → 匿名。结果可缓存（默认缓存；注入 gh 的测试用 cacheAuth=false）。 */
  async auth(): Promise<AuthState> {
    if (this.cached) return this.cached;
    const fromEnv = this.envTokenProvider()?.trim();
    if (fromEnv) {
      this.onSecret(fromEnv);
      const state: AuthState = { mode: "env", token: fromEnv };
      this.cached = this.cacheAuth ? state : undefined;
      return state;
    }
    const fromGh = (await this.ghTokenProvider())?.trim();
    if (fromGh) {
      this.onSecret(fromGh);
      const state: AuthState = { mode: "gh", token: fromGh };
      this.cached = this.cacheAuth ? state : undefined;
      return state;
    }
    const state: AuthState = { mode: "anonymous" };
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
        accept: "application/vnd.github+json",
        timeoutMs: API_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.warn("查询 GitHub 剩余额度失败", (error as Error).message);
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
    const headers: Record<string, string> = { Accept: accept, "User-Agent": USER_AGENT };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return headers;
  }

  private async request(
    url: string,
    init: { accept: string; timeoutMs: number; method?: string; signal?: AbortSignal },
  ): Promise<Response> {
    const auth = await this.auth();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    const onAbort = () => controller.abort();
    init.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.fetchImpl(url, {
        method: init.method ?? "GET",
        headers: this.headers(auth.token, init.accept),
        signal: controller.signal,
        redirect: "follow",
      });
      // FIX-6（D-3）：**每一个** GitHub 响应（成功或失败）都读一次 x-ratelimit-*。
      // 旧实现只在 throwForResponse（错误路径）里记，于是成功路径永远拿不到配额，
      // GET skills/github-auth 与 skills/updates/check 的 rateLimitRemaining 恒为 undefined。
      this.noteRateLimit(response);
      return response;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * **下载类**请求（D-B18）：raw.githubusercontent.com / codeload.github.com 会按设置
   * 走 GitHub 镜像；走镜像时**绝不带 Authorization 头**（令牌不给第三方），也不读
   * x-ratelimit-*（那是镜像的响应头，与 GitHub 配额无关）。
   *
   * 镜像失败不静默回退直连：抛 UPSTREAM，文案写明「通过镜像 … 下载失败：…；可在技能页
   * 「⋯ → GitHub 镜像」里清空镜像后重试」。
   */
  private async downloadRequest(
    url: string,
    init: { accept: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<Response> {
    const mirror = await this.currentMirror();
    const effective = applyMirror(url, mirror);
    const mirrored = effective !== url;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs);
    const onAbort = () => controller.abort();
    init.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const headers: Record<string, string> = { Accept: init.accept, "User-Agent": USER_AGENT };
      if (!mirrored) {
        const auth = await this.auth();
        if (auth.token) headers["Authorization"] = `Bearer ${auth.token}`;
      }
      const response = await this.fetchImpl(effective, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "follow",
      });
      if (mirrored) {
        // 镜像不负责「这个文件不存在」的语义：非 2xx 一律按镜像失败报，绝不给用户
        // 一个「上游删了技能」的错觉，也绝不悄悄回退直连。
        if (!response.ok) {
          throw upstream(mirrorFailureMessage(mirror!, `镜像返回 HTTP ${response.status}`), { url, mirror });
        }
      } else {
        this.noteRateLimit(response);
      }
      return response;
    } catch (error) {
      if (mirrored) {
        throw upstream(mirrorFailureMessage(mirror!, `网络错误（${(error as Error).message}）`), {
          url,
          mirror,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
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
      throw upstream(
        `${what}被 GitHub 拒绝（HTTP ${response.status}）：仓库不存在、不是公开仓库，或当前凭据无权访问。`,
        {
          url,
          status: response.status,
        },
      );
    }
    if (response.status === 404) {
      throw upstream(
        `${what}失败：在 GitHub 上找不到对应仓库或分支（HTTP 404）。请检查仓库名是否正确、是否为公开仓库。`,
        {
          url,
          status: response.status,
        },
      );
    }
    throw upstream(`${what}失败：GitHub 返回 HTTP ${response.status}。`, { url, status: response.status });
  }

  /** 查询仓库默认分支。仓库不存在或网络异常时返回 undefined（调用方按 main/master 回退）。 */
  async defaultBranch(repo: string): Promise<string | undefined> {
    let response: Response;
    try {
      response = await this.request(`https://api.github.com/repos/${repo}`, {
        accept: "application/vnd.github+json",
        timeoutMs: API_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.warn("查询默认分支时网络失败", (error as Error).message);
      return undefined;
    }
    if (!response.ok) return undefined;
    try {
      const data = (await response.json()) as { default_branch?: unknown };
      return typeof data.default_branch === "string" ? data.default_branch : undefined;
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
        if (message === "RATE_LIMITED") sawRateLimit = true;
      }
    }
    if (lastError !== undefined) throw lastError;
    throw sawRateLimit
      ? rateLimited(rateLimitMessage(this.lastRateLimit ?? {}))
      : upstream(`下载 ${repo} 失败：没有可用的分支。`);
  }

  private async candidateRefs(repo: string, ref?: string): Promise<string[]> {
    if (ref !== undefined && ref.trim() !== "") return [ref.trim()];
    const out: string[] = [];
    const push = (value: string | undefined) => {
      if (value && !out.includes(value)) out.push(value);
    };
    push(await this.defaultBranch(repo));
    push("main");
    push("master");
    push("HEAD");
    return out;
  }

  private async fetchTarball(repo: string, ref: string, signal?: AbortSignal): Promise<TarballResult> {
    const url = `https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`;
    let response: Response;
    try {
      response = await this.downloadRequest(url, {
        accept: "application/x-gzip",
        timeoutMs: CODELOAD_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      // 走镜像时的失败文案已由 downloadRequest 写好（含镜像地址与清空指引），原样抛出
      if ((error as { code?: string }).code === "UPSTREAM") throw error;
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
    const rootName = entries[0]!.path.split("/")[0] ?? "";
    return { entries, ref, bytes: bytes.length, rootName };
  }

  /**
   * 取仓库的整棵目录树（D-B18）：`GET /repos/{repo}/git/trees/{ref}?recursive=1`。
   *
   * ref 缺省时用 "HEAD"（GitHub 接受，返回默认分支的树）—— 检查更新**不再**先查默认分支，
   * 于是 4 个仓库只要 4 次请求。返回 sha 是 git tree 指纹：目录内容变了它就变。
   */
  async tree(repo: string, ref?: string, signal?: AbortSignal): Promise<TreeSnapshot> {
    const useRef = ref !== undefined && ref.trim() !== "" ? ref.trim() : "HEAD";
    const url = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(useRef)}?recursive=1`;
    let response: Response;
    try {
      response = await this.request(url, {
        accept: "application/vnd.github+json",
        timeoutMs: TREES_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      throw upstream(`查询 ${repo}@${useRef} 的目录树失败：网络错误（${(error as Error).message}）。`, {
        url,
        repo,
        ref: useRef,
      });
    }
    if (!response.ok) this.throwForResponse(url, response, `查询 ${repo}@${useRef} 的目录树`);
    let payload: { sha?: unknown; truncated?: unknown; tree?: unknown };
    try {
      payload = (await response.json()) as typeof payload;
    } catch (error) {
      throw upstream(`查询 ${repo}@${useRef} 的目录树失败：响应不是合法 JSON（${(error as Error).message}）。`, {
        url,
      });
    }
    // 响应必须是目录树：缺 tree / sha 说明这不是 trees API 的响应（例如被中间层换成了别的 JSON），
    // 此时按失败处理 —— 调用方会回退下载整份归档，而不是把一个空树当成「目录不存在」。
    if (!Array.isArray(payload.tree) || typeof payload.sha !== "string" || payload.sha === "") {
      throw upstream(`查询 ${repo}@${useRef} 的目录树失败：响应不是合法的目录树。`, { url });
    }
    const rawTree = payload.tree as unknown[];
    const byPath = new Map<string, TreeEntry>();
    for (const item of rawTree) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const entryPath = typeof record["path"] === "string" ? record["path"] : "";
      const type = typeof record["type"] === "string" ? record["type"] : "";
      const sha = typeof record["sha"] === "string" ? record["sha"] : "";
      if (entryPath === "" || sha === "") continue;
      const entry: TreeEntry = { path: entryPath, type, sha };
      if (typeof record["mode"] === "string") entry.mode = record["mode"];
      byPath.set(entryPath, entry);
    }
    return {
      ref: useRef,
      sha: typeof payload.sha === "string" ? payload.sha : "",
      byPath,
      truncated: payload.truncated === true,
    };
  }

  /**
   * 取一个 raw 文件的字节（D-B18）：`https://raw.githubusercontent.com/{repo}/{ref}/{path}`。
   * 走 downloadRequest —— 也就是会按设置走镜像（且走镜像时不带令牌）。
   */
  async rawFile(repo: string, ref: string, filePath: string, signal?: AbortSignal): Promise<Buffer> {
    const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${filePath}`;
    let response: Response;
    try {
      response = await this.downloadRequest(url, {
        accept: "application/octet-stream",
        timeoutMs: RAW_TIMEOUT_MS,
        signal,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "UPSTREAM") throw error;
      throw upstream(`下载 ${repo}@${ref} 的 ${filePath} 失败：网络错误（${(error as Error).message}）。`, { url });
    }
    if (!response.ok) this.throwForResponse(url, response, `下载 ${repo}@${ref} 的 ${filePath}`);
    try {
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw upstream(`下载 ${repo}@${ref} 的 ${filePath} 失败：读取响应体出错（${(error as Error).message}）。`, {
        url,
      });
    }
  }

  /**
   * 镜像自检（D-B18）：经该镜像取一个很小的公开文件，测通不通、耗时多少。
   * **不保存设置**；失败不抛错，返回 ok:false + 中文原因。
   */
  async testMirror(mirror: string): Promise<{ ok: boolean; ms?: number; message?: string }> {
    const prefix = (mirror ?? "").trim();
    if (prefix === "") return { ok: false, message: "镜像地址是空的，请先填写（例如 https://ghfast.top/）。" };
    const effective = applyMirror(MIRROR_TEST_URL, prefix);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MIRROR_TEST_TIMEOUT_MS);
    const started = Date.now();
    try {
      const response = await this.fetchImpl(effective, {
        method: "GET",
        headers: { Accept: "application/octet-stream", "User-Agent": USER_AGENT },
        signal: controller.signal,
        redirect: "follow",
      });
      const ms = Date.now() - started;
      if (!response.ok) {
        return { ok: false, ms, message: `镜像返回 HTTP ${response.status}，没能取到测试文件。` };
      }
      // 读掉响应体，确保确实传完了
      await response.arrayBuffer();
      return { ok: true, ms };
    } catch (error) {
      const ms = Date.now() - started;
      const reason = (error as Error).name === "AbortError" ? "请求超时" : (error as Error).message;
      return { ok: false, ms, message: `连接镜像失败：${reason}。` };
    } finally {
      clearTimeout(timer);
    }
  }

  /** skills.sh 公共搜索接口。拿不到就抛 UPSTREAM（docs 有说明）。 */
  async searchSkillsSh(query: string, limit = 20, offset = 0): Promise<unknown> {
    const url = `${SKILLS_SH_SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;
    let response: Response;
    try {
      response = await this.request(url, { accept: "application/json", timeoutMs: SKILLS_SH_TIMEOUT_MS });
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
  options: { skillPathLookup?: (repo: string, skillId: string) => string | undefined } = {},
): SkillsShSearchItem[] {
  const raw = (payload ?? {}) as { skills?: unknown };
  const list = Array.isArray(raw.skills) ? raw.skills : [];
  const out: SkillsShSearchItem[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const source = typeof record["source"] === "string" ? record["source"] : "";
    const name = typeof record["name"] === "string" ? record["name"] : "";
    const [owner, repo] = source.split("/");
    if (!owner || !repo || name === "") continue;
    // owner 必须是合法的 GitHub 用户名（不含点，因此 "skills.volces.com" 这类非 GitHub 来源被过滤）
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) continue;
    if (!/^[A-Za-z0-9._-]+$/.test(repo)) continue;
    const skillId = typeof record["skillId"] === "string" ? record["skillId"] : name;
    const installs = typeof record["installs"] === "number" ? record["installs"] : undefined;
    const item2: SkillsShSearchItem = {
      name,
      repo: `${owner}/${repo}`,
      skillPath: options.skillPathLookup?.(source, skillId),
      installs,
    };
    const description = record["description"];
    if (typeof description === "string" && description.trim() !== "") item2.description = description;
    out.push(item2);
  }
  return out;
}
