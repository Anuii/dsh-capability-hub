/**
 * mcp-runtime 的核心：把「一个恒定的 mcp 工具」实现为一个懒加载的 MCP 网关。
 *
 * 对应决策：
 * - D-D1 只注册一个工具 mcp，参数 schema 恒定；描述 = 恒定前缀 + 已启用服务器名，不写工具数量。
 * - D-D2 动作 search / describe / call / connect / instructions / status；
 *        search、describe、instructions、status 只读缓存，**绝不起进程**。
 * - D-D3 会话隔离：实例键 = 会话 id + 服务器名；子代理会话各持一套；会话结束全部回收。
 * - D-D4 生命周期二维（启动时机 × 回收）：lazy / lazy-keep-alive / eager / keep-alive。
 * - D-D5 idleTimeout 默认 10 分钟、0 = 不回收；关闭时结束整棵进程树。
 * - D-D6 输出护栏默认 50 KiB / 2000 行，保头部，超出落文件并告诉模型路径。
 * - D-D7 失败退避，失败以文本返回；connect 带 force 可绕过；取消不算失败。
 * - D-D8 envFrom 失败拒绝启动，绝不注入空值。
 * - D-C6 新增/改配置的服务器后台自动探测一次；每次成功调用后顺带刷新。
 *
 * 并发模型（很重要，别改回去）：会话 id 是**参数**，不是实例上的可变字段。
 * 曾经把「当前会话」放在模块级变量里，两个会话交替发起异步调用时会互相串台 ——
 * 那正好是 D-D3 要防的东西。现在每个动作都把 session 一路显式传下去。
 */
import {
  DESCRIPTION_PREFIX,
  describeEnabledServers,
  REFRESH_AFTER_MS,
  IDLE_SWEEP_INTERVAL_MS,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_OUTPUT_MAX_BYTES,
  DEFAULT_OUTPUT_MAX_LINES,
  DEFAULT_FAILURE_BACKOFF_MS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  CACHE_TOOL_DESCRIPTION_MAX_CHARS,
} from './constants.ts';
import { assertSdk } from './atoms/sdk-transport.ts';
import { createProcessSupervisor } from './atoms/supervisor.ts';
import { realClock } from './atoms/clock.ts';
import { MetadataCache, computeConfigHash, isEntryStale, isEntryValid } from './atoms/metadata-cache.ts';
import { ConnectionPool, McpInstance } from './atoms/connection.ts';
import { applyOutputGuard, createSpillWriter } from './atoms/output-guard.ts';
import { renderCallToolResult } from './atoms/result-text.ts';
import { isToolIncluded, keywordsFor, qualify, matchesPattern, toolCandidates } from './atoms/tool-name.ts';
import { rankDocuments, searchByRegex } from './atoms/search-ranking.ts';
import { errorText } from './atoms/errors.ts';
import { PROXY_TOOL_PARAMETERS } from './tool-schema.ts';
import type { EffectiveMcpConfig, EffectiveServer, McpConfigSource, McpRuntime, McpSdk, RuntimeStatus } from './contract.ts';
import type { HubContext } from '../../platform/contract/host.ts';
import type { CacheEntry, CachedTool } from './atoms/metadata-cache.ts';
import type { Clock } from './atoms/clock.ts';
import type { ProcessSupervisor } from './atoms/supervisor.ts';
import type { RankDocument } from './atoms/search-ranking.ts';

export const TOOL_NAME = 'mcp' as const;

const NO_SERVERS_HINT = '当前没有已启用的 MCP 服务器。请到「能力中心 → MCP 服务器」标签添加并启用一个。';

/** 探测实例用的伪会话 id：它会出现在运行态面板里（标为「元数据探测」），但不属于任何真实会话。 */
export function probeSessionId(serverName: string): string {
  return 'probe:' + serverName;
}

/**
 * 运行态里一个工具的描述（FIX-9）：只取**第一行**，最多 CACHE_TOOL_DESCRIPTION_MAX_CHARS（160）个字符。
 *
 * 两条边界都是刻意的：
 * - 只取第一行：MCP 工具的 description 常常是「一句话 + 空行 + 用法示例」，UI 只要那行摘要；
 * - 截断**不追加省略号**：上限就是上限，追加符号会让长度变成 161；
 *   长度按 UTF-16 码元算（与 JavaScript 的 \`length\` 一致），若切口正好落在代理对中间就把那个字符整字丢掉，
 *   绝不吐半个代理对给前端。
 */
export function clipToolDescription(text: string): string {
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? '';
  const trimmed = firstLine.trim();
  if (trimmed.length <= CACHE_TOOL_DESCRIPTION_MAX_CHARS) return trimmed;
  const clipped = trimmed.slice(0, CACHE_TOOL_DESCRIPTION_MAX_CHARS);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
}

export type ProbeReason = 'initial' | 'config-change' | 'lazy' | 'manual' | 'refresh-after-call' | 'startup';

export interface SessionRef {
  sessionId: string;
  parentSessionId?: string;
  title?: string;
}

interface Logger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export interface McpRuntimeOptions {
  ctx: HubContext;
  config: McpConfigSource;
  sdk: McpSdk;
  clock?: Clock;
  supervisor?: ProcessSupervisor;
  sweepIntervalMs?: number;
  cacheWatchIntervalMs?: number;
  envFromRunner?: never;
}

export interface McpRuntimeInternal extends McpRuntime {
  /** 启动后台巡检与配置监听，并做一次启动探测。 */
  start(): Promise<void>;
  status(): Promise<RuntimeStatus>;
  refresh(serverName: string): Promise<{ toolCount: number }>;
  disconnect(serverName: string, sessionId?: string): Promise<{ closed: number }>;
  /** 手工触发一次空闲巡检（测试用）。 */
  sweepOnce(): Promise<number>;
  /** 等所有后台探测结束（测试用）。 */
  waitForBackgroundWork(): Promise<void>;
  /** 当前是否有后台工作（测试用）。 */
  backgroundCount(): number;
}

export function createMcpRuntime(options: McpRuntimeOptions): McpRuntimeInternal {
  const ctx = options.ctx;
  const logger: Logger =
    ctx.logger ?? { debug() {}, info() {}, warn() {}, error() {} };
  const clock = options.clock ?? realClock;
  const sdk = assertSdk(options.sdk);
  const supervisor = options.supervisor ?? createProcessSupervisor(clock);
  const sweepIntervalMs = options.sweepIntervalMs ?? IDLE_SWEEP_INTERVAL_MS;
  const cacheWatchIntervalMs = options.cacheWatchIntervalMs ?? IDLE_SWEEP_INTERVAL_MS;

  const cache = new MetadataCache(ctx.hubHome, clock, (message) => logger.warn(message));
  const spill = createSpillWriter(cache.spillDir);
  const pool = new ConnectionPool({
    clock,
    supervisor,
    sdk,
    onUnexpectedClose: (instance, err) => {
      if (instance.sessionId.startsWith('probe:')) return;
      recordFailure(instance.serverName, err.message);
      logger.warn('MCP 服务器 ' + instance.serverName + ' 的连接意外断开：' + err.message);
    },
  });

  const failures = new Map<string, { message: string; at: number }>();
  const probes = new Map<string, Promise<CacheEntry>>();
  const sessionMeta = new Map<string, { parentSessionId?: string; title?: string }>();
  const descriptionListeners = new Set<() => void>();
  const background = new Set<Promise<unknown>>();

  let snapshot: EffectiveMcpConfig = safeGetConfig();
  let description = composeDescription(snapshot);
  let sweepTimer: unknown;
  let cacheWatchTimer: unknown;
  let unsubscribeConfig: (() => void) | undefined;
  let disposed = false;

  function track<T>(promise: Promise<T>): Promise<T> {
    const entry: Promise<unknown> = promise.catch(() => undefined);
    background.add(entry);
    void entry.then(() => background.delete(entry), () => background.delete(entry));
    return promise;
  }

  function settings() {
    const value = snapshot.settings ?? {};
    return {
      idleTimeoutMin: typeof value.idleTimeoutMin === 'number' ? value.idleTimeoutMin : DEFAULT_IDLE_TIMEOUT_MINUTES,
      outputGuard: {
        enabled: value.outputGuard?.enabled !== false,
        maxBytes: typeof value.outputGuard?.maxBytes === 'number' ? value.outputGuard.maxBytes : DEFAULT_OUTPUT_MAX_BYTES,
        maxLines: typeof value.outputGuard?.maxLines === 'number' ? value.outputGuard.maxLines : DEFAULT_OUTPUT_MAX_LINES,
      },
      failureBackoffMs: typeof value.failureBackoffMs === 'number' ? value.failureBackoffMs : DEFAULT_FAILURE_BACKOFF_MS,
    };
  }

  function enabledServers(): EffectiveServer[] {
    return (snapshot.servers ?? []).filter((server) => !server.disabled);
  }

  function findServer(name: string): EffectiveServer | undefined {
    return (snapshot.servers ?? []).find((server) => server.serverName === name);
  }

  function composeDescription(config: EffectiveMcpConfig): string {
    const names = (config.servers ?? []).filter((server) => !server.disabled).map((server) => server.serverName);
    return DESCRIPTION_PREFIX + '\n\n' + describeEnabledServers(names);
  }

  function recordFailure(serverName: string, message: string): void {
    failures.set(serverName, { message, at: clock.now() });
  }

  function clearFailure(serverName: string): void {
    failures.delete(serverName);
  }

  function cooldownRemaining(serverName: string): number {
    const failure = failures.get(serverName);
    if (!failure) return 0;
    const elapsed = clock.now() - failure.at;
    const backoff = settings().failureBackoffMs;
    return elapsed >= backoff ? 0 : backoff - elapsed;
  }

  function seconds(ms: number): number {
    return Math.max(0, Math.round(ms / 1000));
  }

  /** 冷却期内直接返回说明与剩余时间（D-D7）。force 只对 connect 生效。 */
  function backoffMessage(serverName: string, force: boolean, hint: string): string | undefined {
    if (force) return undefined;
    const remaining = cooldownRemaining(serverName);
    if (remaining <= 0) return undefined;
    const failure = failures.get(serverName);
    const ago = seconds(clock.now() - (failure?.at ?? clock.now()));
    return (
      '服务器 "' + serverName + '" 在 ' + ago + ' 秒前失败，冷却还剩 ' + seconds(remaining) + ' 秒，这期间不会自动重试。\n' +
      '最近一次失败：' + (failure?.message ?? '（无详情）') + '\n' +
      '如果配置已经修好，用 mcp({ connect: "' + serverName + '", force: true }) 立即重试。' + hint
    );
  }

  function isCancellation(err: unknown): boolean {
    if (err === null || typeof err !== 'object') {
      return typeof err === 'string' && /cancel|abort|取消/i.test(err);
    }
    const value = err as { name?: string; message?: string; code?: string };
    if (value.name === 'AbortError' || value.code === 'ABORT_ERR') return true;
    const message = value.message ?? '';
    return /已被取消|operation was aborted|aborted|cancel/i.test(message);
  }

  // ---------------------------------------------------------------- 元数据

  /**
   * 确保缓存已加载。**并且**在文件被外部改过（另一个 DSH 进程刷新了它）时重新读盘：
   * 运行态面板与 search/describe 都是读路径，硬等 30 秒的巡检会把「刚刷新过」的缓存显示成空的。
   *
   * 判定按**内容**而不是 mtime —— 本机 NTFS 的时间戳粒度实测约 4ms，
   * 而两个 DSH 进程的写读间隔往往就在这一瞬间（详见 metadata-cache.reloadIfChanged）。
   */
  async function ensureCacheLoaded(): Promise<void> {
    if (!cache.loaded) {
      await cache.load();
      return;
    }
    await cache.reloadIfChanged();
  }

  function visibleTools(server: EffectiveServer): CachedTool[] {
    const entry = cache.get(server.serverName);
    if (!entry) return [];
    // 过滤只发生在读侧，永不写回缓存（F3-Q3）。
    return entry.tools.filter((tool) => isToolIncluded(server, tool.name));
  }

  /**
   * 运行态里给 UI 的工具名清单（FIX-9）：过滤后的名字 + 一行描述。
   *
   * **不带 inputSchema** —— 运行态面板每 5 秒轮询一次，把 schema 塞进去纯属浪费；
   * 要看完整参数用 mcp({ describe })。空描述用「不写这个键」表示，而不是空字符串。
   */
  function cacheToolView(tool: CachedTool): { name: string; description?: string } {
    const view: { name: string; description?: string } = { name: tool.name };
    const description = clipToolDescription(tool.description);
    if (description.length > 0) view.description = description;
    return view;
  }

  /** 过滤后的可见工具 → 运行态清单：按**名称码元序**（与 locale 无关，跨机器稳定）。 */
  function cacheToolsOf(server: EffectiveServer): { name: string; description?: string }[] {
    return visibleTools(server)
      .map(cacheToolView)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  interface DocEntry {
    doc: RankDocument;
    server: EffectiveServer;
    tool: CachedTool;
  }

  function documentsOf(server: EffectiveServer, includeDisabled = false): DocEntry[] {
    if (server.disabled && !includeDisabled) return [];
    const tools = visibleTools(server);
    return tools.map((tool) => ({
      doc: {
        qualifiedName: qualify(server.serverName, tool.name),
        originalName: tool.name,
        server: server.serverName,
        description: tool.description ?? '',
        keywords: keywordsFor(server, tool.name),
      },
      server,
      tool,
    }));
  }

  function allDocuments(): DocEntry[] {
    const out: DocEntry[] = [];
    for (const server of snapshot.servers ?? []) out.push(...documentsOf(server));
    return out;
  }

  function schemaSummary(schema: unknown): string {
    if (schema === null || typeof schema !== 'object') return '';
    const value = schema as Record<string, unknown>;
    const properties = value.properties;
    if (properties === null || typeof properties !== 'object') return '';
    const required = Array.isArray(value.required) ? (value.required as unknown[]).filter((item): item is string => typeof item === 'string') : [];
    const parts: string[] = [];
    for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
      const prop = (raw ?? {}) as Record<string, unknown>;
      let type = 'any';
      if (typeof prop.type === 'string') type = prop.type;
      else if (Array.isArray(prop.type)) type = prop.type.map((item) => String(item)).join('|');
      else if (Array.isArray(prop.enum)) type = 'enum(' + (prop.enum as unknown[]).map((item) => String(item)).join('|') + ')';
      parts.push(name + (required.includes(name) ? '' : '?') + ': ' + type);
    }
    return parts.join(', ');
  }

  function safeStringify(value: unknown): string {
    try {
      const text = JSON.stringify(value, null, 2);
      return text === undefined ? String(value) : text;
    } catch {
      return String(value);
    }
  }

  /**
   * 用一个**独立的探测实例**连一次、拉清单写缓存、然后关闭（D-C6）。
   * 同一服务器同一时刻只允许一个探测（probes 去重）。
   */
  function probe(server: EffectiveServer, reason: ProbeReason, actor?: SessionRef): Promise<CacheEntry> {
    const existing = probes.get(server.serverName);
    if (existing) return existing;
    const promise = runProbe(server, reason, actor).finally(() => probes.delete(server.serverName));
    probes.set(server.serverName, promise);
    track(promise.catch(() => undefined));
    return promise;
  }

  async function runProbe(server: EffectiveServer, reason: ProbeReason, actor?: SessionRef): Promise<CacheEntry> {
    // 调用路径触发的刷新（actor 存在）复用调用方的会话实例，避免多起一个进程；
    // 配置变化 / 启动 / 手动刷新走独立探测会话。
    const session: SessionRef = actor ?? { sessionId: probeSessionId(server.serverName), title: '元数据探测' };
    const instance = pool.acquire(session, server);
    try {
      await instance.ensureConnected();
      const listResult = (await instance.listTools()) as { tools?: unknown[] };
      const tools: CachedTool[] = [];
      for (const raw of Array.isArray(listResult?.tools) ? listResult.tools : []) {
        if (raw === null || typeof raw !== 'object') continue;
        const tool = raw as Record<string, unknown>;
        if (typeof tool.name !== 'string' || tool.name.length === 0) continue;
        tools.push({
          name: tool.name,
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: tool.inputSchema ?? { type: 'object' },
        });
      }
      const instructions = instance.instructions();
      const entry: CacheEntry = { configHash: computeConfigHash(server), tools, updatedAt: clock.now() };
      if (typeof instructions === 'string' && instructions.length > 0) entry.instructions = instructions;
      await cache.write({ [server.serverName]: entry });
      // 成功即清空失败记录（D-D7）：不管这次探测用的是调用方会话还是探测会话，服务器现在好好的。
      clearFailure(server.serverName);
      logger.debug('MCP 服务器 ' + server.serverName + ' 的元数据已刷新（' + reason + '，' + tools.length + ' 个工具）');
      return entry;
    } catch (err) {
      // 取消不算失败（D-D7）。
      if (!isCancellation(err)) recordFailure(server.serverName, errorText(err));
      throw err instanceof Error ? err : new Error(errorText(err));
    } finally {
      if (!actor) await pool.release(instance).catch(() => undefined);
    }
  }

  async function ensureMetadata(server: EffectiveServer, actor: SessionRef): Promise<CacheEntry> {
    await ensureCacheLoaded();
    const entry = cache.get(server.serverName);
    if (isEntryValid(entry, server, clock.now())) return entry as CacheEntry;
    const blocked = backoffMessage(server.serverName, false, '');
    if (blocked) throw new Error(blocked);
    return probe(server, 'lazy', actor);
  }

  // ---------------------------------------------------------------- 生命周期

  function windowFor(serverName: string): number {
    const server = findServer(serverName);
    if (!server) return 0;
    const configured = server.idleTimeoutMin;
    if (configured === 0) return 0; // 显式 0 = 不回收
    const persistent = server.lifecycle === 'lazy-keep-alive' || server.lifecycle === 'keep-alive';
    const globalIdle = settings().idleTimeoutMin;
    // keep-alive 类生命周期在「没有显式覆盖全局值」时按会话内常驻处理（D-D4）。
    if (persistent && configured === globalIdle) return 0;
    return configured * 60_000;
  }

  function startResident(server: EffectiveServer, info: SessionRef): void {
    const instance = pool.acquire(info, server);
    track(
      instance.ensureConnected().catch((err) => {
        recordFailure(server.serverName, errorText(err));
        logger.warn('后台启动 MCP 服务器 ' + server.serverName + ' 失败：' + errorText(err));
      }),
    );
  }

  // ---------------------------------------------------------------- 渲染

  function stateText(state: string): string {
    switch (state) {
      case 'ready':
        return '就绪';
      case 'connecting':
        return '连接中';
      case 'failed':
        return '失败';
      case 'closing':
        return '关闭中';
      default:
        return '已关闭';
    }
  }

  function describeTime(epochMs: number): string {
    if (!epochMs) return '—';
    const delta = Math.max(0, clock.now() - epochMs);
    if (delta < 60_000) return seconds(delta) + ' 秒前';
    if (delta < 3_600_000) return Math.round(delta / 60_000) + ' 分钟前';
    return Math.round(delta / 3_600_000) + ' 小时前';
  }

  function sessionSuffix(sessionId: string): string {
    const meta = sessionMeta.get(sessionId);
    if (sessionId.startsWith('probe:')) return '（元数据探测）';
    if (meta?.parentSessionId !== undefined) return '（子代理，父会话 ' + meta.parentSessionId + '）';
    if (meta) return '（主会话）';
    return '';
  }

  function renderStatus(): string {
    const servers = snapshot.servers ?? [];
    if (servers.length === 0) return 'MCP 运行状态\n' + NO_SERVERS_HINT;
    const lines: string[] = ['MCP 运行状态'];
    const enabled = enabledServers();
    lines.push('已启用服务器（' + enabled.length + '）：' + (enabled.length > 0 ? enabled.map((server) => server.serverName).join('，') : '（无）'));
    const now = clock.now();
    for (const server of servers) {
      const entry = cache.get(server.serverName);
      const flags: string[] = [];
      if (server.disabled) flags.push('已停用');
      flags.push(server.lifecycle);
      const window = windowFor(server.serverName);
      flags.push(window === 0 ? '会话内常驻' : '空闲 ' + Math.round(window / 60_000) + ' 分钟后回收');
      if (cooldownRemaining(server.serverName) > 0) flags.push('冷却中，剩余 ' + seconds(cooldownRemaining(server.serverName)) + ' 秒');
      let cacheText: string;
      if (!entry) {
        cacheText = '尚无缓存';
      } else {
        const invalid = !isEntryValid(entry, server, now);
        const stale = isEntryStale(entry, now);
        cacheText =
          entry.tools.length + ' 个工具，' + describeTime(entry.updatedAt) + '更新' +
          (stale ? '（缓存已超过 7 天）' : '') +
          (invalid && !stale ? '（配置已变化，需要重新拉取）' : '');
      }
      lines.push('- ' + server.serverName + '：' + cacheText + '［' + flags.join('，') + '］');
    }
    if (failures.size > 0) {
      lines.push('最近失败：');
      for (const [name, failure] of failures) {
        const remaining = cooldownRemaining(name);
        lines.push('  - ' + name + '：' + failure.message + (remaining > 0 ? '（冷却剩余 ' + seconds(remaining) + ' 秒）' : ''));
      }
    }
    const instances = pool.list();
    if (instances.length === 0) {
      lines.push('当前没有活跃的服务器实例。');
    } else {
      lines.push('活跃会话实例：');
      const bySession = new Map<string, McpInstance[]>();
      for (const instance of instances) {
        const list = bySession.get(instance.sessionId) ?? [];
        list.push(instance);
        bySession.set(instance.sessionId, list);
      }
      for (const [sessionId, list] of bySession) {
        lines.push('  - 会话 ' + sessionId + sessionSuffix(sessionId) + '：');
        for (const instance of list) {
          const pid = instance.pid !== undefined ? '，pid ' + instance.pid : '';
          lines.push(
            '      ' + instance.serverName + '（' + stateText(instance.state) + '，启动于 ' + describeTime(instance.startedAt) +
              '，最后使用 ' + describeTime(instance.lastUsedAt) + pid + '）',
          );
        }
      }
    }
    if (enabled.length > 0 && enabled.every((server) => !cache.get(server.serverName))) {
      lines.push('提示：还没有任何服务器被缓存过。用 mcp({ connect: "<服务器名>" }) 拉一次工具清单，之后就能 search/describe 了。');
    }
    return lines.join('\n');
  }

  function coldHint(): string {
    const enabled = enabledServers();
    if (enabled.length === 0) return '';
    if (enabled.every((server) => !cache.get(server.serverName))) {
      return '\n提示：目前还没有任何工具元数据被缓存，先 mcp({ connect: "' + enabled[0].serverName + '" }) 拉一次。';
    }
    return '';
  }

  function renderToolLine(entry: DocEntry, includeSchemas: boolean): string {
    const lines = ['- ' + entry.doc.qualifiedName + '  ［' + entry.doc.server + '］'];
    const description = (entry.doc.description ?? '').split('\n')[0].trim();
    if (description) lines.push('    ' + description);
    if (includeSchemas) {
      const summary = schemaSummary(entry.tool.inputSchema);
      if (summary) lines.push('    parameters: ' + summary);
    }
    if (entry.doc.keywords.length > 0) lines.push('    keywords: ' + entry.doc.keywords.join(', '));
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- 动作

  function handleSearch(args: Record<string, unknown>): string {
    const query = typeof args.search === 'string' ? args.search : '';
    const useRegex = args.regex === true;
    const includeSchemas = args.includeSchemas !== false;
    const limitRaw = typeof args.limit === 'number' ? Math.trunc(args.limit) : SEARCH_DEFAULT_LIMIT;
    const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : SEARCH_DEFAULT_LIMIT), SEARCH_MAX_LIMIT);
    const offsetRaw = typeof args.offset === 'number' ? Math.trunc(args.offset) : 0;
    const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

    const entries = allDocuments();
    if (entries.length === 0) {
      const enabled = enabledServers();
      if (enabled.length === 0) return '没有可搜索的工具：' + NO_SERVERS_HINT;
      const coldServers = enabled.filter((server) => !cache.get(server.serverName)).map((server) => server.serverName);
      return (
        '还没有任何 MCP 工具元数据被缓存，暂时没得搜。\n' +
        (coldServers.length > 0
          ? '请先连接一个服务器（只拉清单、不调用工具），例如：mcp({ connect: "' + coldServers[0] + '" })\n'
          : '') +
        '连接成功后就可以用 mcp({ search: "关键词" }) 检索了。'
      );
    }

    if (useRegex) {
      const result = searchByRegex(entries.map((entry) => entry.doc), query, 1000);
      if (!result.ok) return '无法执行这个正则搜索：' + result.error;
      if (result.matches.length === 0) return '没有匹配 "' + query + '" 的工具（正则模式，共检索 ' + entries.length + ' 个工具）。';
      const index = new Map(entries.map((entry) => [entry.doc.qualifiedName, entry]));
      const page = result.matches.slice(offset, offset + limit);
      const lines = ['正则搜索 "' + query + '" 命中 ' + result.matches.length + ' 个工具，显示第 ' + (offset + 1) + '–' + (offset + page.length) + ' 个：'];
      for (const doc of page) {
        const entry = index.get(doc.qualifiedName);
        if (entry) lines.push(renderToolLine(entry, includeSchemas));
      }
      lines.push('调用方式：mcp({ tool: "<名字>", args: { … } })');
      return lines.join('\n');
    }

    const ranked = rankDocuments(entries.map((entry) => entry.doc), query);
    const index = new Map(entries.map((entry) => [entry.doc.qualifiedName, entry]));
    if (ranked.length === 0) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const near = escaped.length > 0 ? searchByRegex(entries.map((entry) => entry.doc), escaped, 5) : { ok: true, matches: [] as RankDocument[] };
      const hint = near.ok && near.matches.length > 0 ? '\n你是不是想找：' + near.matches.map((doc) => doc.qualifiedName).join('、') : '';
      return '没有匹配 "' + query + '" 的工具（当前缓存里有 ' + entries.length + ' 个工具）。' + hint + coldHint();
    }
    const page = ranked.slice(offset, offset + limit);
    const lines = ['找到 ' + ranked.length + ' 个工具，显示第 ' + (offset + 1) + '–' + (offset + page.length) + ' 个：'];
    for (const match of page) {
      const entry = index.get(match.doc.qualifiedName);
      if (entry) lines.push(renderToolLine(entry, includeSchemas));
    }
    if (offset + page.length < ranked.length) {
      lines.push('还有更多，用 mcp({ search: ' + JSON.stringify(query) + ', offset: ' + (offset + page.length) + ' }) 继续。');
    }
    lines.push('调用方式：mcp({ tool: "<名字>", args: { … } })；先用 mcp({ describe: "<名字>" }) 看参数。');
    return lines.join('\n');
  }

  function handleDescribe(args: Record<string, unknown>): string {
    const query = typeof args.describe === 'string' ? args.describe : '';
    const serverFilter = typeof args.server === 'string' ? args.server : undefined;
    const pool2 = allDocuments().filter((entry) => serverFilter === undefined || entry.server.serverName === serverFilter);

    const matches = pool2.filter((entry) =>
      toolCandidates(entry.server.serverName, entry.tool.name).some((candidate) => matchesPattern(query, candidate)),
    );
    if (matches.length === 0) {
      const disabledMatches = (snapshot.servers ?? [])
        .filter((server) => server.disabled)
        .flatMap((server) => documentsOf(server, true))
        .filter((entry) => toolCandidates(entry.server.serverName, entry.tool.name).some((candidate) => matchesPattern(query, candidate)));
      if (disabledMatches.length > 0) {
        return '工具 "' + query + '" 属于已停用的服务器 "' + disabledMatches[0].server.serverName + '"。到「能力中心 → MCP 服务器」启用它之后再试。';
      }
      const knownServer = findServer(query);
      if (knownServer) {
        return '那是服务器名，不是工具名：mcp({ search: "' + query + '" }) 可以看到它有哪些工具。' + (knownServer.disabled ? '\n注意：该服务器当前已被停用。' : '');
      }
      const prefix = query.toLowerCase().slice(0, Math.max(2, Math.min(4, query.length)));
      const suggestions = allDocuments()
        .filter((entry) => entry.doc.qualifiedName.toLowerCase().includes(prefix))
        .slice(0, 5)
        .map((entry) => entry.doc.qualifiedName);
      return (
        '没有名为 "' + query + '" 的工具。' +
        (suggestions.length > 0 ? '你是不是想找：' + suggestions.join('、') + '？' : '可以先用 mcp({ search: "关键词" }) 检索。') +
        coldHint()
      );
    }
    if (matches.length > 1) {
      const servers = [...new Set(matches.map((entry) => entry.server.serverName))];
      if (servers.length > 1) {
        return '"' + query + '" 同时存在于多个服务器上：' + servers.join('、') + '。请用 mcp({ describe: "' + query + '", server: "<服务器名>" }) 指定一个。';
      }
    }
    const entry = matches[0];
    const lines = [
      '工具：' + entry.doc.qualifiedName,
      '服务器：' + entry.server.serverName,
      '描述：' + ((entry.tool.description ?? '').trim() || '（该工具没有提供描述）'),
    ];
    const summary = schemaSummary(entry.tool.inputSchema);
    // 标签与 search 的 renderToolLine、以及 F3-Q1 参考实现的 renderDescribe（Parameters:）保持一致，
    // 不写成中文「参数：」—— 同一个 schema 摘要在两个动作里必须是同一个字符串。
    if (summary) lines.push('parameters: ' + summary);
    lines.push('完整 inputSchema：');
    lines.push(safeStringify(entry.tool.inputSchema));
    lines.push('调用方式：mcp({ tool: "' + entry.tool.name + '", args: { … } })');
    return lines.join('\n');
  }

  function handleInstructions(args: Record<string, unknown>): string {
    const name = typeof args.instructions === 'string' ? args.instructions : '';
    const server = findServer(name);
    if (!server) {
      return '没有名为 "' + name + '" 的 MCP 服务器。已启用：' + (enabledServers().map((item) => item.serverName).join('，') || '（无）');
    }
    if (server.disabled) return '服务器 "' + name + '" 已在配置里停用。';
    const entry = cache.get(name);
    if (!entry) return '服务器 "' + name + '" 还没有缓存。用 mcp({ connect: "' + name + '" }) 拉一次，然后再看它的用法说明。';
    if (!entry.instructions) return '服务器 "' + name + '" 没有发布用法说明。';
    return '服务器 "' + name + '" 的用法说明：\n\n' + entry.instructions;
  }

  async function handleConnect(args: Record<string, unknown>, session: SessionRef, signal: AbortSignal): Promise<string> {
    const name = typeof args.connect === 'string' ? args.connect : '';
    const force = args.force === true;
    const server = findServer(name);
    if (!server) return '没有名为 "' + name + '" 的 MCP 服务器。已启用：' + (enabledServers().map((item) => item.serverName).join('，') || '（无）');
    if (server.disabled) return '服务器 "' + name + '" 已在配置里停用，无法连接。';
    const blocked = backoffMessage(name, force, '');
    if (blocked) return blocked;
    if (signal.aborted) return '连接服务器 "' + name + '" 的操作已被取消。';
    try {
      // 用调用方自己的会话实例探测：会话隔离下不该为「连接」再起一个进程给别的会话用。
      // 注意：如果此刻恰好有一个「探测会话」的同服务器探测在跑（例如启动探测），probe 会
      // 去重并复用那一个 —— 于是调用方的会话仍然是空的。所以这里再确保一次调用方会话连通，
      // 使 connect 的语义「这个会话现在有了一个连着的实例」在任何情况下都成立。
      const entry = await probe(server, force ? 'manual' : 'lazy', session);
      const instance = pool.get(session.sessionId, server.serverName);
      if (!instance || !instance.isAlive) {
        const callerInstance = pool.acquire(session, server);
        await callerInstance.ensureConnected();
      }
      return (
        '已连接服务器 "' + name + '" 并刷新了它的工具清单：' + entry.tools.length + ' 个工具' +
        (entry.instructions ? '，另有用法说明（mcp({ instructions: "' + name + '" }) 可看）' : '') + '。\n' +
        '现在可以 mcp({ search: "关键词" }) 检索它的工具了。'
      );
    } catch (err) {
      if (isCancellation(err)) return '连接服务器 "' + name + '" 的操作已被取消。';
      const remaining = cooldownRemaining(name);
      return (
        '连接服务器 "' + name + '" 失败：' + errorText(err) + '\n' +
        (remaining > 0 ? '已进入 ' + seconds(remaining) + ' 秒冷却，期间不会自动重试。' : '') +
        '检查配置（command / args / env / cwd）后可以再用 mcp({ connect: "' + name + '", force: true }) 强制重试。'
      );
    }
  }

  function resolveTool(name: string, serverName: string | undefined): { matches: DocEntry[]; disabled: DocEntry[] } {
    const enabledMatches = allDocuments().filter((entry) => {
      if (serverName !== undefined && entry.server.serverName !== serverName) return false;
      return toolCandidates(entry.server.serverName, entry.tool.name).some((candidate) => matchesPattern(name, candidate));
    });
    const disabledMatches = (snapshot.servers ?? [])
      .filter((server) => server.disabled)
      .flatMap((server) => documentsOf(server, true))
      .filter((entry) => {
        if (serverName !== undefined && entry.server.serverName !== serverName) return false;
        return toolCandidates(entry.server.serverName, entry.tool.name).some((candidate) => matchesPattern(name, candidate));
      });
    return { matches: enabledMatches, disabled: disabledMatches };
  }

  async function handleCall(args: Record<string, unknown>, session: SessionRef, signal: AbortSignal): Promise<string> {
    const name = typeof args.tool === 'string' ? args.tool : '';
    const serverName = typeof args.server === 'string' ? args.server : undefined;
    const toolArgs = (args.args ?? {}) as Record<string, unknown>;
    if (name.length === 0) return 'mcp({ tool }) 需要一个工具名。可以先用 mcp({ search: "关键词" }) 找。';

    let resolution = resolveTool(name, serverName);
    const attempts: string[] = [];
    if (resolution.matches.length === 0) {
      // 可能缓存还没建，或工具所在的服务器刚被配置进来 ⇒ 按需要连一次再解析。
      const targets =
        serverName !== undefined
          ? enabledServers().filter((server) => server.serverName === serverName)
          : enabledServers().filter((server) => !resolution.disabled.some((entry) => entry.server.serverName === server.serverName));
      for (const server of targets) {
        try {
          const entry = await ensureMetadata(server, session);
          attempts.push(server.serverName + '：已缓存 ' + entry.tools.length + ' 个工具');
        } catch (err) {
          attempts.push(server.serverName + '：' + errorText(err));
        }
      }
      resolution = resolveTool(name, serverName);
    }

    if (resolution.matches.length === 0) {
      if (resolution.disabled.length > 0) {
        return (
          '工具 "' + name + '" 属于已停用的服务器 "' + resolution.disabled[0].server.serverName + '"。' +
          '到「能力中心 → MCP 服务器」启用它之后再试。'
        );
      }
      return (
        '找不到名为 "' + name + '" 的 MCP 工具（当前缓存里共 ' + allDocuments().length + ' 个工具）。\n' +
        (attempts.length > 0 ? '尝试启动服务器：\n  - ' + attempts.join('\n  - ') + '\n' : '') +
        '可以先用 mcp({ search: "关键词" }) 找工具名，或 mcp({ connect: "<服务器名>" }) 刷新缓存。'
      );
    }

    if (resolution.matches.length > 1) {
      const servers = [...new Set(resolution.matches.map((entry) => entry.server.serverName))];
      if (servers.length > 1) {
        return '"' + name + '" 同时存在于多个服务器上：' + servers.join('、') + '。请用 mcp({ tool: "' + name + '", server: "<服务器名>" }) 指定一个。';
      }
    }

    const target = resolution.matches[0];
    const server = target.server;
    const toolName = target.tool.name;

    const blocked = backoffMessage(server.serverName, false, '');
    if (blocked) return blocked;

    try {
      const instance = pool.acquire(session, server);
      if (!instance.isAlive) {
        try {
          await ensureMetadata(server, session);
        } catch (err) {
          // 拉不到元数据不必然代表不能调用（也可能是刚写缓存失败）；交给 ensureConnected 决定。
          logger.debug('MCP 服务器 ' + server.serverName + ' 元数据刷新失败：' + errorText(err));
        }
      }
      const blockedAfterProbe = backoffMessage(server.serverName, false, '');
      if (blockedAfterProbe) return blockedAfterProbe;
      await instance.ensureConnected(signal);
      const raw = await instance.callTool(toolName, toolArgs, {
        ...(signal ? { signal } : {}),
        timeoutMs: server.toolCallTimeoutMs,
      });
      const rendered = renderCallToolResult(raw);
      clearFailure(server.serverName);
      const header = rendered.isError
        ? '[服务器返回错误] ' + qualify(server.serverName, toolName) + ' —— 以下是服务器自己返回的内容，本机网关没有改动它：\n'
        : '';
      const guarded = await applyOutputGuard(rendered.text, settings().outputGuard, spill);
      scheduleRefreshAfterCall(server, session);
      return header + guarded.text;
    } catch (err) {
      if (isCancellation(err)) return '调用 "' + qualify(server.serverName, toolName) + '" 的操作已被取消。';
      recordFailure(server.serverName, errorText(err));
      const remaining = cooldownRemaining(server.serverName);
      return (
        '调用 "' + qualify(server.serverName, toolName) + '" 失败：' + errorText(err) + '\n' +
        (remaining > 0
          ? '已进入 ' + seconds(remaining) + ' 秒冷却，这期间不会再自动尝试这台服务器。用 mcp({ connect: "' + server.serverName + '", force: true }) 可强制重试。'
          : '')
      );
    }
  }

  function scheduleRefreshAfterCall(server: EffectiveServer, session: SessionRef): void {
    const entry = cache.get(server.serverName);
    if (entry && clock.now() - entry.updatedAt <= REFRESH_AFTER_MS) return;
    if (cooldownRemaining(server.serverName) > 0) return;
    track(
      probe(server, 'refresh-after-call', session).catch((err) => {
        logger.debug('MCP 服务器 ' + server.serverName + ' 的调用后刷新失败：' + errorText(err));
      }),
    );
  }

  // ---------------------------------------------------------------- 配置变化

  function applyConfigChange(next: EffectiveMcpConfig, prev: EffectiveMcpConfig): void {
    snapshot = next;
    const nextDescription = composeDescription(next);
    // 只有文本真正变化时才通知（描述字节稳定是 D-D1 的核心要求）。
    if (nextDescription !== description) {
      description = nextDescription;
      for (const listener of [...descriptionListeners]) {
        try {
          listener();
        } catch (err) {
          logger.warn('mcp-runtime 描述变化监听器抛错：' + errorText(err));
        }
      }
    }
    const before = new Map((prev.servers ?? []).map((server) => [server.serverName, server]));
    for (const server of next.servers ?? []) {
      const previous = before.get(server.serverName);
      const hashChanged = !previous || computeConfigHash(previous) !== computeConfigHash(server);
      if (server.disabled) {
        if (previous && !previous.disabled) void pool.closeServer(server.serverName).catch(() => undefined);
        continue;
      }
      if (previous?.disabled && !server.disabled) {
        // 从停用改为启用：等价于新服务器，后台探测一次。
        track(probe(server, 'initial').catch((err) => logger.debug('MCP 服务器 ' + server.serverName + ' 探测失败：' + errorText(err))));
        continue;
      }
      if (hashChanged) {
        // 「怎么到达」变了 ⇒ 现有实例已经对不上，直接关掉；缓存按 configHash 自然失效。后台重探一次。
        void pool.closeServer(server.serverName).catch(() => undefined);
        track(
          probe(server, previous ? 'config-change' : 'initial').catch((err) =>
            logger.debug('MCP 服务器 ' + server.serverName + ' 的自动探测失败：' + errorText(err)),
          ),
        );
      }
    }
  }

  // ---------------------------------------------------------------- 定时任务

  function scheduleSweep(): void {
    sweepTimer = clock.setTimer(() => {
      if (disposed) return;
      // 巡检登记进 background：waitForBackgroundWork()（平台层与测试都用它）才真的等到这轮巡检结束。
      // 不登记的话，「推进时钟 ⇒ 空闲实例已被回收」这类断言会与还没跑完的巡检赛跑。
      track(sweepOnce().catch((err) => logger.warn('MCP 空闲巡检失败：' + errorText(err))));
      scheduleSweep();
    }, sweepIntervalMs);
  }

  async function sweepOnce(): Promise<number> {
    await ensureCacheLoaded();
    return pool.sweep(clock.now(), (serverName) => windowFor(serverName));
  }

  function scheduleCacheWatch(): void {
    cacheWatchTimer = clock.setTimer(() => {
      if (disposed) return;
      void watchCache().catch(() => undefined);
      scheduleCacheWatch();
    }, cacheWatchIntervalMs);
  }

  /** 缓存文件可能被另一个 DSH 进程改过，重新加载（后台探测会再写回去）。 */
  async function watchCache(): Promise<void> {
    await cache.reloadIfChanged();
  }

  function safeGetConfig(): EffectiveMcpConfig {
    try {
      const value = options.config?.get();
      if (value && typeof value === 'object' && Array.isArray((value as EffectiveMcpConfig).servers)) return value as EffectiveMcpConfig;
    } catch (err) {
      logger.warn('读取 MCP 配置失败：' + errorText(err));
    }
    return {
      settings: {
        idleTimeoutMin: DEFAULT_IDLE_TIMEOUT_MINUTES,
        outputGuard: { enabled: true, maxBytes: DEFAULT_OUTPUT_MAX_BYTES, maxLines: DEFAULT_OUTPUT_MAX_LINES },
        failureBackoffMs: DEFAULT_FAILURE_BACKOFF_MS,
      },
      servers: [],
    };
  }

  // ---------------------------------------------------------------- 对外接口

  const runtime: McpRuntimeInternal = {
    toolName: TOOL_NAME,

    toolParameters(): unknown {
      // 返回深拷贝：调用方（平台层）可能往 schema 里加东西，不能污染模块常量。
      return JSON.parse(JSON.stringify(PROXY_TOOL_PARAMETERS)) as unknown;
    },

    toolDescription(): string {
      return description;
    },

    onDescriptionChange(cb: () => void): () => void {
      descriptionListeners.add(cb);
      return () => {
        descriptionListeners.delete(cb);
      };
    },

    async execute(args: unknown, call): Promise<string> {
      const session: SessionRef = {
        sessionId: call?.sessionId ?? 'default',
        ...(call?.parentSessionId !== undefined ? { parentSessionId: call.parentSessionId } : {}),
      };
      const signal = call?.signal ?? new AbortController().signal;
      try {
        sessionMeta.set(session.sessionId, {
          ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
          ...(sessionMeta.get(session.sessionId)?.title !== undefined ? { title: sessionMeta.get(session.sessionId)?.title as string } : {}),
        });
        await ensureCacheLoaded();
        const params = (unwrapGatewayEnvelope(args) ?? {}) as Record<string, unknown>;
        if (params.search !== undefined) return handleSearch(params);
        if (params.describe !== undefined) return handleDescribe(params);
        if (params.instructions !== undefined) return handleInstructions(params);
        if (params.connect !== undefined) return await handleConnect(params, session, signal);
        if (params.tool !== undefined) return await handleCall(params, session, signal);
        return renderStatus();
      } catch (err) {
        logger.error('mcp 工具执行失败：' + errorText(err));
        return 'mcp 工具执行失败：' + errorText(err);
      }
    },

    sessionStarted(info): void {
      try {
        sessionMeta.set(info.sessionId, {
          ...(info.parentSessionId !== undefined ? { parentSessionId: info.parentSessionId } : {}),
          ...(info.title !== undefined ? { title: info.title } : {}),
        });
        for (const server of enabledServers()) {
          if (server.lifecycle === 'eager' || server.lifecycle === 'keep-alive') {
            // fire-and-forget，绝不 await：agent/created 是串行派发的，慢活会阻塞会话创建（F1-Q5）。
            startResident(server, info);
          }
        }
      } catch (err) {
        logger.warn('MCP 会话启动处理失败：' + errorText(err));
      }
    },

    async sessionEnded(sessionId: string): Promise<void> {
      sessionMeta.delete(sessionId);
      const closed = await pool.closeSession(sessionId);
      if (closed > 0) logger.debug('会话 ' + sessionId + ' 结束，已回收 ' + closed + ' 个 MCP 服务器实例');
    },

    async dispose(): Promise<void> {
      disposed = true;
      if (sweepTimer !== undefined) clock.clearTimer(sweepTimer);
      if (cacheWatchTimer !== undefined) clock.clearTimer(cacheWatchTimer);
      unsubscribeConfig?.();
      unsubscribeConfig = undefined;
      descriptionListeners.clear();
      await pool.closeAll();
      await Promise.allSettled([...background]);
      await spill.cleanup();
    },

    async start(): Promise<void> {
      await ensureCacheLoaded();
      snapshot = safeGetConfig();
      description = composeDescription(snapshot);
      scheduleSweep();
      scheduleCacheWatch();
      for (const server of enabledServers()) {
        const entry = cache.get(server.serverName);
        if (isEntryValid(entry, server, clock.now())) continue;
        track(
          probe(server, 'startup').catch((err) => {
            logger.debug('MCP 服务器 ' + server.serverName + ' 的启动探测失败：' + errorText(err));
          }),
        );
      }
    },

    async status(): Promise<RuntimeStatus> {
      await ensureCacheLoaded();
      const now = clock.now();
      const servers = (snapshot.servers ?? []).map((server) => {
        const entry = cache.get(server.serverName);
        const view: RuntimeStatus['servers'][number] = { name: server.serverName, disabled: server.disabled };
        if (entry) {
          // FIX-9：toolCount 与 tools.length 同源 —— 口径从「探测到的总数」改成「过滤后可见数」，
          // 否则抽屉里列 2 个工具、标题写 4 个。
          const tools = cacheToolsOf(server);
          view.cache = {
            toolCount: tools.length,
            updatedAt: entry.updatedAt,
            stale: isEntryStale(entry, now) || !isEntryValid(entry, server, now),
            tools,
          };
        }
        const failure = failures.get(server.serverName);
        if (failure) {
          const remaining = cooldownRemaining(server.serverName);
          view.lastFailure = {
            message: failure.message,
            at: failure.at,
            ...(remaining > 0 ? { cooldownUntil: failure.at + settings().failureBackoffMs } : {}),
          };
        }
        return view;
      });
      const instances = pool.list();
      const bySession = new Map<string, McpInstance[]>();
      for (const instance of instances) {
        const list = bySession.get(instance.sessionId) ?? [];
        list.push(instance);
        bySession.set(instance.sessionId, list);
      }
      const sessions = [...bySession.entries()].map(([sessionId, list]) => {
        const meta = sessionMeta.get(sessionId);
        const view: RuntimeStatus['sessions'][number] = {
          sessionId,
          instances: list.map((instance) => {
            const item: { server: string; state: string; startedAt: number; lastUsedAt: number; pid?: number } = {
              server: instance.serverName,
              state: instance.state,
              startedAt: instance.startedAt,
              lastUsedAt: instance.lastUsedAt,
            };
            if (instance.pid !== undefined) item.pid = instance.pid;
            return item;
          }),
        };
        if (meta?.parentSessionId !== undefined) view.parentSessionId = meta.parentSessionId;
        if (meta?.title !== undefined) view.title = meta.title;
        return view;
      });
      return { servers, sessions };
    },

    async refresh(serverName: string): Promise<{ toolCount: number }> {
      const server = findServer(serverName);
      if (!server) throw new Error('没有名为 "' + serverName + '" 的 MCP 服务器');
      if (server.disabled) throw new Error('服务器 "' + serverName + '" 已停用，无法刷新缓存');
      const entry = await probe(server, 'manual');
      return { toolCount: entry.tools.length };
    },

    async disconnect(serverName: string, sessionId?: string): Promise<{ closed: number }> {
      if (!findServer(serverName)) throw new Error('没有名为 "' + serverName + '" 的 MCP 服务器');
      return { closed: await pool.closeServer(serverName, sessionId) };
    },

    async sweepOnce(): Promise<number> {
      return sweepOnce();
    },

    async waitForBackgroundWork(): Promise<void> {
      for (;;) {
        const pending = [...background, ...probes.values()];
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
        if (background.size === 0 && probes.size === 0) return;
      }
    },

    backgroundCount(): number {
      return background.size + probes.size;
    },
  };

  // 配置监听在**构造时**就挂上（而不是在 start() 里）：描述与设置解析不能依赖
  // 「平台层是否调过 start()」。start() 只负责后台工作（空闲巡检、启动探测）。
  unsubscribeConfig = options.config.onChange((next, prev) => {
    try {
      applyConfigChange(next, prev);
    } catch (err) {
      logger.warn('MCP 配置变化处理失败：' + errorText(err));
    }
  });

  return runtime;
}

/**
 * 网关名信封解包（F3-Q1「必须复刻的坑」）。
 *
 * DSH 可能把工具名为 mcp 的调用参数包成 { tool: "mcp", args: <真实参数> }。
 * 若不解包，{ search: "x" } 会被读成「调用一个叫 mcp 的 MCP 工具」，插件看起来装好了、实际完全不可用。
 * 判据（照抄参考实现）：candidate.tool === 'mcp' 且 args 是对象且参数只有 tool/args 两个键。
 * 该机制在 DSH 0.2.0-rc.2 宿主侧**未被证实**（F3 附 B 第 1 条），但防御成本极低、收益极高。
 */
export function unwrapGatewayEnvelope(args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args;
  const candidate = args as Record<string, unknown>;
  if (Object.keys(candidate).length !== 2) return args;
  if (candidate.tool !== TOOL_NAME) return args;
  const inner = candidate.args;
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return args;
  return inner;
}
