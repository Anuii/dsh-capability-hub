/**
 * 一条 MCP 连接的实例（= 一个服务器 × 一个会话 = 一个子进程）与连接池。
 *
 * 设计要点（逐条对应决策）：
 * - **实例键 = sessionId + serverName**（D-D3）。子代理有自己的 sessionId ⇒ 自然各持一套实例。
 * - **并发调用共享同一个「连接中」的 promise**：不做这件事，两个并发调用会各起一个子进程，
 *   其中一个立刻变成没人认领的孤儿。
 * - **inFlight > 0 绝不回收**（F3-Q2）。
 * - **关闭顺序**：先 client.close()（让 SDK 正常收尾），再对记录的 pid 执行进程树终止
 *   （Windows: taskkill /PID <pid> /T /F）。只做后者会让 SDK 的状态机处于半关闭；
 *   只做前者会留下 npx 的孙进程（F1-Q2 风险 2、F3-Q8）。
 * - **debug=false** 时 stdio stderr 用 'pipe' 并捕获尾部（否则任何诊断都不可能，F3-Q6）；
 *   **debug=true** 时用 'inherit' 把子进程日志实时透传给宿主终端。
 */
import { getDefaultEnvironment } from "./sdk-transport.ts";
import { buildChildEnv } from "./sandbox-env.ts";
import { resolveEnvFrom } from "./env-from.ts";
import { StderrTail } from "./stderr-tail.ts";
import { errorText } from "./errors.ts";
import { CLOSE_TIMEOUT_MS, CONNECT_TIMEOUT_MS } from "../constants.ts";
import type { EffectiveServer } from "../../contract/config.ts";
import type { McpSdk } from "../../contract/runtime.ts";
import type { Clock } from "./clock.ts";
import type { ProcessSupervisor } from "./supervisor.ts";

export type InstanceState = "connecting" | "ready" | "failed" | "closing" | "closed";

/**
 * 建实例时需要的**会话**信息。
 *
 * 注意这里**没有** serverName —— 服务器名一律以传入的 EffectiveServer 为准。
 * 早先这个接口要求调用方自己填 serverName，结果 runtime 那边传的是会话对象，
 * 于是每个实例的键都变成 "<会话>\u0000undefined"，同一会话里所有服务器共用一个实例。
 * 现在把它做成不可能写错：serverName 只能来自 server。
 */
export interface InstanceOptions {
  sessionId: string;
  parentSessionId?: string;
  title?: string;
}

export interface CallOutcome {
  result: unknown;
  /** 本次调用尝试连接的毫秒数（用于「距上次刷新」判断）。 */
  connectMs: number;
}

export class McpInstance {
  readonly key: string;
  readonly sessionId: string;
  readonly serverName: string;
  parentSessionId?: string;
  title?: string;

  state: InstanceState = "closed";
  startedAt = 0;
  lastUsedAt = 0;
  pid?: number;

  #server: EffectiveServer;
  #clock: Clock;
  #supervisor: ProcessSupervisor;
  #sdk: McpSdk;
  #client?: any;
  #transport?: any;
  #connectPromise?: Promise<void>;
  #closePromise?: Promise<void>;
  /** 是否真正建立过连接。用来区分「还没用过的占位实例」与「已经关掉的实例」。 */
  #everConnected = false;
  #stderrTail: StderrTail;
  #inFlight = 0;
  #onUnexpectedClose: (instance: McpInstance, err: Error) => void;

  constructor(
    options: InstanceOptions,
    server: EffectiveServer,
    deps: {
      clock: Clock;
      supervisor: ProcessSupervisor;
      sdk: McpSdk;
      onUnexpectedClose: (instance: McpInstance, err: Error) => void;
    },
  ) {
    if (!server || typeof server.serverName !== "string" || server.serverName.length === 0) {
      throw new Error("mcp-runtime 内部错误：建立连接实例时缺少 serverName");
    }
    this.sessionId = options.sessionId;
    this.serverName = server.serverName;
    this.key = this.sessionId + "\u0000" + this.serverName;
    if (options.parentSessionId !== undefined) this.parentSessionId = options.parentSessionId;
    if (options.title !== undefined) this.title = options.title;
    this.#server = server;
    this.#clock = deps.clock;
    this.#supervisor = deps.supervisor;
    this.#sdk = deps.sdk;
    this.#stderrTail = new StderrTail();
    this.#onUnexpectedClose = deps.onUnexpectedClose;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get server(): EffectiveServer {
    return this.#server;
  }

  get isAlive(): boolean {
    return this.state === "ready" && this.#client !== undefined;
  }

  /** 这个占位实例还能不能继续用（失败过或已经关掉的都不行）。 */
  get reusable(): boolean {
    if (this.state === "failed") return false;
    if (this.state === "closed" && this.#everConnected) return false;
    if (this.state === "closing") return false;
    return true;
  }

  /** 与本实例的服务器配置是否等价（configHash 不同 ⇒ 需要重建连接）。 */
  matchesServer(next: EffectiveServer, hashOf: (server: EffectiveServer) => string): boolean {
    return hashOf(this.#server) === hashOf(next);
  }

  /**
   * 确保连接可用。并发调用会合流到同一个 promise —— 这是「并发首次调用只建一个连接」的实现。
   * 每次调用都会刷新 lastUsedAt（空闲窗口是关于「空闲」而不是「年龄」）。
   */
  async ensureConnected(signal?: AbortSignal): Promise<void> {
    this.lastUsedAt = this.#clock.now();
    if (this.state === "ready" && this.#client) return;
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#doConnect(signal).finally(() => {
      this.#connectPromise = undefined;
    });
    return this.#connectPromise;
  }

  async #doConnect(signal?: AbortSignal): Promise<void> {
    this.state = "connecting";
    this.startedAt = this.#clock.now();
    const childEnv = await this.#buildEnv();
    const transport = await this.#createTransport(childEnv);
    const client = new this.#sdk.Client(
      { name: "dsh-capability-hub", version: "1.0.0" },
      { capabilities: {}, versionNegotiation: { mode: "auto" } },
    );
    this.#transport = transport;
    this.#client = client;

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    let timer: unknown;
    try {
      if (signal) {
        if (signal.aborted) throw new Error("调用已被取消");
        signal.addEventListener("abort", onAbort, { once: true });
      }
      timer = this.#clock.setTimer(() => abortController.abort(new Error("连接超时")), CONNECT_TIMEOUT_MS);
      await client.connect(transport);
      const pid = transport.pid;
      if (typeof pid === "number" && Number.isInteger(pid)) this.pid = pid;
      client.onclose = () => {
        if (this.state === "ready" || this.state === "connecting") {
          this.state = "closed";
          this.#onUnexpectedClose(this, new Error("与服务器的连接已断开"));
        }
      };
      this.#everConnected = true;
      this.state = "ready";
      this.lastUsedAt = this.#clock.now();
    } catch (err) {
      this.state = "failed";
      await this.#teardown();
      throw new Error(this.#stderrTail.withStderrTail('无法连接服务器 "' + this.serverName + '"：' + errorText(err)));
    } finally {
      if (timer !== undefined) this.#clock.clearTimer(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  async #buildEnv(): Promise<Record<string, string>> {
    const server = this.#server;
    if (server.transport !== "stdio") return {};
    const resolved = await resolveEnvFrom({
      envFrom: server.envFrom ?? {},
      allowEmpty: server.allowEmpty ?? [],
      timeoutMs: server.envFromTimeoutMs,
    });
    if (resolved.failures.length > 0) {
      // 拒绝启动，绝不注入空值（D-D8）。诊断里只有变量名 / 退出码 / stderr 尾部。
      throw new Error(
        '服务器 "' +
          this.serverName +
          '" 的 envFrom 解析失败，已拒绝启动：' +
          resolved.failures.map((failure) => failure.message).join("；"),
      );
    }
    const base =
      typeof this.#sdk.getDefaultEnvironment === "function"
        ? this.#sdk.getDefaultEnvironment()
        : getDefaultEnvironment();
    return buildChildEnv({ base, extra: server.env ?? {}, fromCommands: resolved.values });
  }

  async #createTransport(env: Record<string, string>): Promise<any> {
    const server = this.#server;
    if (server.transport === "stdio") {
      if (!server.command) throw new Error('服务器 "' + server.serverName + '" 是 stdio 但没有配置 command');
      const transport = new this.#sdk.StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        env,
        // 空串不是合法的 cwd；省略才是「不指定」。
        ...(server.cwd ? { cwd: server.cwd } : {}),
        stderr: server.debug ? "inherit" : "pipe",
      });
      if (!server.debug) {
        const stream = transport.stderr;
        // FIX-4：传原始 chunk（Buffer）而不是 String(chunk) —— 解码在 StderrTail 内部按字节做
        stream?.on?.("data", (chunk: unknown) => this.#stderrTail.push(chunk));
      }
      return transport;
    }
    if (!server.url) throw new Error('服务器 "' + server.serverName + '" 是 streamable-http 但没有配置 url');
    return new this.#sdk.StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers ?? {} },
    });
  }

  /** 列工具；cacheMode: 'refresh' 强制绕过 SDK 的响应缓存。 */
  async listTools(): Promise<any> {
    if (!this.#client) throw new Error('服务器 "' + this.serverName + '" 尚未连接');
    return this.#client.listTools(undefined, { cacheMode: "refresh" });
  }

  instructions(): string | undefined {
    try {
      const value = this.#client?.getInstructions?.();
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 调用一个工具。inFlight 计数包住整个调用 —— 空闲巡检据此跳过，
   * 「正在调用的连接绝不被回收」。
   */
  async callTool(
    name: string,
    args: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (!this.#client) throw new Error('服务器 "' + this.serverName + '" 尚未连接');
    this.#inFlight += 1;
    this.lastUsedAt = this.#clock.now();
    try {
      const callOptions: Record<string, unknown> = {};
      if (options.signal) callOptions.signal = options.signal;
      if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) callOptions.timeout = options.timeoutMs;
      return await this.#client.callTool({ name, arguments: args ?? {} }, callOptions);
    } finally {
      this.#inFlight -= 1;
      this.lastUsedAt = this.#clock.now();
    }
  }

  /** 关闭：先 SDK close，再进程树终止。可重复调用（幂等）。 */
  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#doClose();
    return this.#closePromise;
  }

  async #doClose(): Promise<void> {
    const previous = this.state;
    this.state = "closing";
    if (previous === "connecting" && this.#connectPromise) {
      await this.#connectPromise.catch(() => undefined);
    }
    await this.#teardown();
    this.state = "closed";
  }

  async #teardown(): Promise<void> {
    const client = this.#client;
    const pid = this.pid ?? this.#transport?.pid;
    this.#client = undefined;
    this.#transport = undefined;
    if (client) {
      const closePromise = (async () => {
        try {
          client.onclose = undefined;
          await client.close();
        } catch {
          /* 收尾失败不影响后面的进程树终止 */
        }
      })();
      await Promise.race([
        closePromise,
        new Promise<void>((resolve) => {
          const handle = this.#clock.setTimer(resolve, CLOSE_TIMEOUT_MS);
          void handle;
        }),
      ]);
    }
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
      // SDK 的 close() 只杀直接子进程；npx 的孙进程必须由我们自己收。
      await this.#supervisor.killTree(pid).catch(() => undefined);
    }
    this.pid = undefined;
  }

  /** 最近一次 stderr 摘要（诊断用）。 */
  stderrSummary(): string {
    return this.#stderrTail.summary();
  }

  isIdle(now: number, windowMs: number): boolean {
    if (windowMs <= 0) return false;
    if (this.#inFlight > 0) return false;
    return now - this.lastUsedAt > windowMs;
  }
}

export interface PoolDeps {
  clock: Clock;
  supervisor: ProcessSupervisor;
  sdk: McpSdk;
  onUnexpectedClose?: (instance: McpInstance, err: Error) => void;
}

export class ConnectionPool {
  #instances = new Map<string, McpInstance>();
  #deps: PoolDeps;

  constructor(deps: PoolDeps) {
    this.#deps = deps;
  }

  static key(sessionId: string, serverName: string): string {
    return sessionId + "\u0000" + serverName;
  }

  get(sessionId: string, serverName: string): McpInstance | undefined {
    return this.#instances.get(ConnectionPool.key(sessionId, serverName));
  }

  /** 取实例，没有就建一个（此时**还没有连接**，只是占位）。 */
  acquire(options: InstanceOptions, server: EffectiveServer): McpInstance {
    const key = ConnectionPool.key(options.sessionId, server.serverName);
    const existing = this.#instances.get(key);
    if (existing && existing.reusable) return existing;
    const instance = new McpInstance(options, server, {
      clock: this.#deps.clock,
      supervisor: this.#deps.supervisor,
      sdk: this.#deps.sdk,
      onUnexpectedClose: (target, err) => {
        this.#instances.delete(target.key);
        this.#deps.onUnexpectedClose?.(target, err);
      },
    });
    this.#instances.set(key, instance);
    return instance;
  }

  /** 丢弃某个实例（关闭并移出池）。 */
  async release(instance: McpInstance): Promise<void> {
    this.#instances.delete(instance.key);
    await instance.close();
  }

  list(filter?: { sessionId?: string; serverName?: string }): McpInstance[] {
    const all = [...this.#instances.values()];
    return all.filter(
      (instance) =>
        (filter?.sessionId === undefined || instance.sessionId === filter.sessionId) &&
        (filter?.serverName === undefined || instance.serverName === filter.serverName),
    );
  }

  listSessions(): string[] {
    const ids = new Set<string>();
    for (const instance of this.#instances.values()) ids.add(instance.sessionId);
    return [...ids];
  }

  async closeSession(sessionId: string): Promise<number> {
    const instances = this.list({ sessionId });
    await Promise.all(instances.map((instance) => this.release(instance)));
    return instances.length;
  }

  async closeAll(): Promise<number> {
    const instances = [...this.#instances.values()];
    this.#instances.clear();
    await Promise.all(instances.map((instance) => instance.close()));
    return instances.length;
  }

  /** 关掉某个服务器在**所有会话**里的实例。 */
  async closeServer(serverName: string, sessionId?: string): Promise<number> {
    const instances = this.list({ serverName, ...(sessionId !== undefined ? { sessionId } : {}) });
    await Promise.all(instances.map((instance) => this.release(instance)));
    return instances.length;
  }

  /** 空闲回收一次；返回被回收的实例数。 */
  async sweep(now: number, windowFor: (serverName: string) => number): Promise<number> {
    const reaped: McpInstance[] = [];
    for (const instance of [...this.#instances.values()]) {
      const window = windowFor(instance.serverName);
      if (!instance.isIdle(now, window)) continue;
      reaped.push(instance);
    }
    await Promise.all(reaped.map((instance) => this.release(instance)));
    return reaped.length;
  }
}
