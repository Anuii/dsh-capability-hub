/**
 * mcp-runtime 的共享内核：配置快照、工具元数据缓存、连接池、失败记录与后台探测。
 *
 * 各个动作（actions/*.ts）与运行态视图（status-view.ts）都只通过它读写状态；
 * 对外的 mcp 工具与 HTTP 视图由 runtime.ts 组装。
 *
 * 并发模型（很重要，别改回去）：会话 id 是**参数**，不是实例上的可变字段。
 * 曾经把「当前会话」放在模块级变量里，两个会话交替发起异步调用时会互相串台 ——
 * 那正好是 D-D3 要防的东西。现在每个动作都把 session 一路显式传下去。
 */

import {
  DEFAULT_FAILURE_BACKOFF_MS,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_OUTPUT_MAX_BYTES,
  DEFAULT_OUTPUT_MAX_LINES,
} from "./constants.ts";
import { assertSdk } from "./atoms/sdk-transport.ts";
import { createProcessSupervisor } from "./atoms/supervisor.ts";
import { realClock } from "./atoms/clock.ts";
import { MetadataCache, computeConfigHash, isEntryValid } from "./atoms/metadata-cache.ts";
import { ConnectionPool } from "./atoms/connection.ts";
import { createSpillWriter, type SpillWriter } from "./atoms/output-guard.ts";
import { isToolIncluded, keywordsFor, qualify } from "./atoms/tool-name.ts";

import { FailureBook, isCancellation } from "./failures.ts";
import type { EffectiveMcpConfig, EffectiveServer, McpConfigSource } from "../contract/config.ts";
import type { McpSdk } from "../contract/runtime.ts";
import type { HubContext, HubLogger } from "../../platform/contract/host.ts";
import type { CacheEntry, CachedTool } from "./atoms/metadata-cache.ts";
import type { Clock } from "./atoms/clock.ts";
import type { ProcessSupervisor } from "./atoms/supervisor.ts";
import type { RankDocument } from "./atoms/search-ranking.ts";
import { errorText } from "../../shared/error-text.ts";

export type ProbeReason = "initial" | "config-change" | "lazy" | "manual" | "refresh-after-call" | "startup";

export interface SessionRef {
  sessionId: string;
  parentSessionId?: string;
  title?: string;
}

/** 探测实例用的伪会话 id：它会出现在运行态面板里（标为「元数据探测」），但不属于任何真实会话。 */
export function probeSessionId(serverName: string): string {
  return "probe:" + serverName;
}

/** 运行态里一个工具的描述（FIX-9）：规则见 constants.ts。 */
export { clipToolDescription } from "./constants.ts";

/** 检索用的一个工具：排序文档 + 所在服务器 + 缓存里的工具。 */
export interface DocEntry {
  doc: RankDocument;
  server: EffectiveServer;
  tool: CachedTool;
}

export interface RuntimeSettings {
  idleTimeoutMin: number;
  outputGuard: { enabled: boolean; maxBytes: number; maxLines: number };
  failureBackoffMs: number;
}

export interface CoreOptions {
  ctx: HubContext;
  config: McpConfigSource;
  sdk: McpSdk;
  clock?: Clock;
  supervisor?: ProcessSupervisor;
}

const SILENT: HubLogger = { debug() {}, info() {}, warn() {}, error() {} };

export class RuntimeCore {
  readonly logger: HubLogger;
  readonly clock: Clock;
  readonly cache: MetadataCache;
  readonly spill: SpillWriter;
  readonly failures: FailureBook;
  readonly pool: ConnectionPool;
  /** 进行中的探测（同一服务器同一时刻只有一个） */
  readonly probes = new Map<string, Promise<CacheEntry>>();
  /** 会话的父子关系与标题（运行态面板与状态文字用） */
  readonly sessionMeta = new Map<string, { parentSessionId?: string; title?: string }>();
  /** 后台工作（探测、巡检）：dispose 与测试会等它们结束 */
  readonly background = new Set<Promise<unknown>>();
  /** 当前生效的配置 */
  config: EffectiveMcpConfig;
  readonly #source: McpConfigSource;

  constructor(options: CoreOptions) {
    this.logger = options.ctx.logger ?? SILENT;
    this.clock = options.clock ?? realClock;
    this.#source = options.config;
    const sdk = assertSdk(options.sdk);
    const supervisor = options.supervisor ?? createProcessSupervisor(this.clock);
    this.cache = new MetadataCache(options.ctx.hubHome, this.clock, (message) => this.logger.warn(message));
    this.spill = createSpillWriter(this.cache.spillDir);
    this.failures = new FailureBook(this.clock, () => this.settings().failureBackoffMs);
    this.pool = new ConnectionPool({
      clock: this.clock,
      supervisor,
      sdk,
      onUnexpectedClose: (instance, err) => {
        if (instance.sessionId.startsWith("probe:")) return;
        this.failures.record(instance.serverName, err.message);
        this.logger.warn("MCP 服务器 " + instance.serverName + " 的连接意外断开：" + err.message);
      },
    });
    this.config = this.readConfig();
  }

  /** 读配置来源；读不到时用默认设置 + 空服务器列表。 */
  readConfig(): EffectiveMcpConfig {
    try {
      const value = this.#source?.get();
      if (value && typeof value === "object" && Array.isArray((value as EffectiveMcpConfig).servers))
        return value as EffectiveMcpConfig;
    } catch (err) {
      this.logger.warn("读取 MCP 配置失败：" + errorText(err));
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

  /** 登记一项后台工作（不改变它的结果）。 */
  track<T>(promise: Promise<T>): Promise<T> {
    const entry: Promise<unknown> = promise.catch(() => undefined);
    this.background.add(entry);
    void entry.then(
      () => this.background.delete(entry),
      () => this.background.delete(entry),
    );
    return promise;
  }

  settings(): RuntimeSettings {
    const value = this.config.settings ?? {};
    return {
      idleTimeoutMin: typeof value.idleTimeoutMin === "number" ? value.idleTimeoutMin : DEFAULT_IDLE_TIMEOUT_MINUTES,
      outputGuard: {
        enabled: value.outputGuard?.enabled !== false,
        maxBytes:
          typeof value.outputGuard?.maxBytes === "number" ? value.outputGuard.maxBytes : DEFAULT_OUTPUT_MAX_BYTES,
        maxLines:
          typeof value.outputGuard?.maxLines === "number" ? value.outputGuard.maxLines : DEFAULT_OUTPUT_MAX_LINES,
      },
      failureBackoffMs:
        typeof value.failureBackoffMs === "number" ? value.failureBackoffMs : DEFAULT_FAILURE_BACKOFF_MS,
    };
  }

  servers(): EffectiveServer[] {
    return this.config.servers ?? [];
  }

  enabledServers(): EffectiveServer[] {
    return this.servers().filter((server) => !server.disabled);
  }

  findServer(name: string): EffectiveServer | undefined {
    return this.servers().find((server) => server.serverName === name);
  }

  // ---------------------------------------------------------------- 元数据

  /**
   * 确保缓存已加载。**并且**在文件被外部改过（另一个 DSH 进程刷新了它）时重新读盘：
   * 运行态面板与 search/describe 都是读路径，硬等 30 秒的巡检会把「刚刷新过」的缓存显示成空的。
   *
   * 判定按**内容**而不是 mtime —— 本机 NTFS 的时间戳粒度实测约 4ms，
   * 而两个 DSH 进程的写读间隔往往就在这一瞬间（详见 metadata-cache.reloadIfChanged）。
   */
  async ensureCacheLoaded(): Promise<void> {
    if (!this.cache.loaded) {
      await this.cache.load();
      return;
    }
    await this.cache.reloadIfChanged();
  }

  /** 缓存里该服务器的工具，按 includeTools / excludeTools 过滤（只在读侧过滤，永不写回缓存，F3-Q3）。 */
  visibleTools(server: EffectiveServer): CachedTool[] {
    const entry = this.cache.get(server.serverName);
    if (!entry) return [];
    return entry.tools.filter((tool) => isToolIncluded(server, tool.name));
  }

  documentsOf(server: EffectiveServer, includeDisabled = false): DocEntry[] {
    if (server.disabled && !includeDisabled) return [];
    return this.visibleTools(server).map((tool) => ({
      doc: {
        qualifiedName: qualify(server.serverName, tool.name),
        originalName: tool.name,
        server: server.serverName,
        description: tool.description ?? "",
        keywords: keywordsFor(server, tool.name),
      },
      server,
      tool,
    }));
  }

  /** 所有已启用服务器的可见工具。 */
  allDocuments(): DocEntry[] {
    const out: DocEntry[] = [];
    for (const server of this.servers()) out.push(...this.documentsOf(server));
    return out;
  }

  /** 已停用服务器的工具（用来提示「这个工具属于已停用的服务器」）。 */
  disabledDocuments(): DocEntry[] {
    return this.servers()
      .filter((server) => server.disabled)
      .flatMap((server) => this.documentsOf(server, true));
  }

  /**
   * 用一个**独立的探测实例**连一次、拉清单写缓存、然后关闭（D-C6）。
   * 同一服务器同一时刻只允许一个探测（probes 去重）。
   */
  probe(server: EffectiveServer, reason: ProbeReason, actor?: SessionRef): Promise<CacheEntry> {
    const existing = this.probes.get(server.serverName);
    if (existing) return existing;
    const promise = this.#runProbe(server, reason, actor).finally(() => this.probes.delete(server.serverName));
    this.probes.set(server.serverName, promise);
    this.track(promise.catch(() => undefined));
    return promise;
  }

  /** 后台探测一次，失败只记 debug 日志。 */
  probeInBackground(server: EffectiveServer, reason: ProbeReason, failureLabel: string, actor?: SessionRef): void {
    this.track(
      this.probe(server, reason, actor).catch((err) => {
        this.logger.debug("MCP 服务器 " + server.serverName + " " + failureLabel + "：" + errorText(err));
      }),
    );
  }

  async #runProbe(server: EffectiveServer, reason: ProbeReason, actor?: SessionRef): Promise<CacheEntry> {
    // 调用路径触发的刷新（actor 存在）复用调用方的会话实例，避免多起一个进程；
    // 配置变化 / 启动 / 手动刷新走独立探测会话。
    const session: SessionRef = actor ?? { sessionId: probeSessionId(server.serverName), title: "元数据探测" };
    const instance = this.pool.acquire(session, server);
    try {
      await instance.ensureConnected();
      const listResult = (await instance.listTools()) as { tools?: unknown[] };
      const tools: CachedTool[] = [];
      for (const raw of Array.isArray(listResult?.tools) ? listResult.tools : []) {
        if (raw === null || typeof raw !== "object") continue;
        const tool = raw as Record<string, unknown>;
        if (typeof tool.name !== "string" || tool.name.length === 0) continue;
        tools.push({
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: tool.inputSchema ?? { type: "object" },
        });
      }
      const instructions = instance.instructions();
      const entry: CacheEntry = { configHash: computeConfigHash(server), tools, updatedAt: this.clock.now() };
      if (typeof instructions === "string" && instructions.length > 0) entry.instructions = instructions;
      await this.cache.write({ [server.serverName]: entry });
      // 成功即清空失败记录（D-D7）：不管这次探测用的是调用方会话还是探测会话，服务器现在好好的。
      this.failures.clear(server.serverName);
      this.logger.debug(
        "MCP 服务器 " + server.serverName + " 的元数据已刷新（" + reason + "，" + tools.length + " 个工具）",
      );
      return entry;
    } catch (err) {
      // 取消不算失败（D-D7）。
      if (!isCancellation(err)) this.failures.record(server.serverName, errorText(err));
      throw err instanceof Error ? err : new Error(errorText(err));
    } finally {
      if (!actor) await this.pool.release(instance).catch(() => undefined);
    }
  }

  /** 缓存有效就直接用；否则（不在冷却中时）用调用方的会话探测一次。 */
  async ensureMetadata(server: EffectiveServer, actor: SessionRef): Promise<CacheEntry> {
    await this.ensureCacheLoaded();
    const entry = this.cache.get(server.serverName);
    if (isEntryValid(entry, server, this.clock.now())) return entry as CacheEntry;
    const blocked = this.failures.blockedMessage(server.serverName, false);
    if (blocked) throw new Error(blocked);
    return this.probe(server, "lazy", actor);
  }

  // ---------------------------------------------------------------- 生命周期

  /** 空闲多久回收（毫秒）；0 = 会话内常驻（D-D4 / D-D5）。 */
  windowFor(serverName: string): number {
    const server = this.findServer(serverName);
    if (!server) return 0;
    const configured = server.idleTimeoutMin;
    if (configured === 0) return 0; // 显式 0 = 不回收
    const persistent = server.lifecycle === "lazy-keep-alive" || server.lifecycle === "keep-alive";
    const globalIdle = this.settings().idleTimeoutMin;
    // keep-alive 类生命周期在「没有显式覆盖全局值」时按会话内常驻处理（D-D4）。
    if (persistent && configured === globalIdle) return 0;
    return configured * 60_000;
  }

  /** eager / keep-alive：会话开始时后台起一个实例，绝不阻塞会话创建。 */
  startResident(server: EffectiveServer, info: SessionRef): void {
    const instance = this.pool.acquire(info, server);
    this.track(
      instance.ensureConnected().catch((err) => {
        this.failures.record(server.serverName, errorText(err));
        this.logger.warn("后台启动 MCP 服务器 " + server.serverName + " 失败：" + errorText(err));
      }),
    );
  }
}
