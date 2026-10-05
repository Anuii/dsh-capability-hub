/**
 * 会话事件桥（F1-Q5 / FIX-8）。
 *
 * 事实要点（只读核实 DSH 源码所得）：
 *   - agent/created 在 AgentRegistry 上用 ctx.serial 派发 —— **串行**，且串行监听器
 *     抛错会让「创建失败」。所以这里绝不做慢活，只做同步记账 + 排队异步工作。
 *     payload 形状是 { agent, source, signal? }（dsh-agent/lib/index.js:579-583）。
 *   - agent/disposed 用 ctx.emit，监听器抛错只 warn、被 contain（dsh-agent:547-561）。
 *   - subagent/start 与 subagent/end **只给监听器传一个参数 info**
 *     （dsh-subagent/lib/index.js:235-251，第 243 行的 `callback(info)`），
 *     info = { runId, provider, id, local }，**里面没有任何父会话字段**。
 *     父会话只是 scoped dispatch 的 carrier（同文件 238 行 `carrier(parent)`、
 *     2836 行 `scopeTarget(this, parent)`），由 cordis 绑成监听器的 `this`
 *     （cordis/lib/index.js:259、263 的 `callback.bind(thisArg)`）。
 *     官方恢复姿势：`carrierKeyOf(this)` → 父 agent（dsh-sdk-jsonrpc-server:34-37、90-96）。
 *   - 会话 header 在 session.header 上（dsh-session:1699-1710 组装、1048-1052 校验），
 *     parentSession / origin === "subagent" / delegationDepth 都在里面；
 *     session/created 直接把 Session 交给监听器（dsh-session:1782-1799），
 *     官方就是读 `session.header.parentSession`（dsh-sdk-jsonrpc-server:81-89）。
 *   - **session.requestHeader() 不是会话 header**：它是 request/header 事件的折叠
 *     （dsh-session:1494-1500 → foldRequestHeader:634-638），是下一次 LLM 请求的
 *     epoch header，既没有 parentSession 也没有 origin（首次请求前还是 undefined）。
 *     FIX-8 之前这里优先读它，父会话因此永远取不到 —— 这是 D-E1 的真正根因。
 *   - 归档（GUI「归档会话」）**不派发 agent/disposed 也不派发 session/disposed**：
 *     它只是 workspaceRegistry 的归档集合写入（dsh-workspace:524-540），
 *     并让 archived-session-gate 拒绝后续 pre-step（dsh-api-session-controller:2430/2442-2452）。
 *     因此会话结束靠三条路：agent/disposed、session/disposed、以及本文件的不在册/
 *     已归档巡检（FIX-8 §3）。
 *
 * 事件对象只在监听器回调里可用：created 的 payload 会被 DSH 清空，所以必须在
 * created 时就地固化身份，disposed 才能拿到该会话的 id 与父会话。
 */
import type { HubLogger } from "./types.ts";
import type { McpSessionInfo } from "./mcp-runtime-contract.ts";

/** 一条被记录下来的会话生命周期事件（V5 的证据来源）。 */
export interface SessionEventRecord {
  kind: "created" | "disposed" | "subagent-start" | "subagent-end" | "reclaimed";
  sessionId: string;
  parentSessionId?: string;
  title?: string;
  at: string;
  /** 仅 `reclaimed`（巡检回收）：archived = 已归档；not-live = 不在存活注册表里。 */
  reason?: string;
}

/** 会话桥依赖的 runtime 面（与 McpRuntime 的子集一致，便于测试替身）。 */
export interface SessionSink {
  sessionStarted(info: McpSessionInfo): void;
  sessionEnded(sessionId: string): Promise<void>;
}

/** 可注入的时钟与定时器（默认用真实实现；测试注入假时钟）。 */
export interface SessionBridgeClock {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** 桥的选配项（全部可选；不传即默认行为）。 */
export interface SessionBridgeOptions {
  /** 时钟与定时器；默认真实实现。 */
  clock?: SessionBridgeClock;
  /** 不在册/已归档巡检周期（毫秒），默认 60_000；<= 0 表示关闭巡检。 */
  sweepIntervalMs?: number;
  /** 存活会话 id 读取器；返回 undefined = 取不到注册表（巡检什么都不做）。 */
  liveSessionIds?: () => string[] | undefined;
  /** 已归档会话 id 读取器；返回 undefined = 取不到归档集合（该信号不可用）。 */
  archivedSessionIds?: () => string[] | undefined;
  /**
   * 官方 @deepseek-ai/dsh-scope 的 carrierKeyOf（可选）。
   * 拿不到时「carrier 来源」自动不可用，其余来源照常。
   */
  carrierKeyOf?: (carrier: unknown) => unknown;
}

/** 拿 header 上的父会话 / 标题。 */
function foldHeader(record: unknown): { parentSessionId?: string; title?: string } {
  const header = record as { parentSession?: unknown; origin?: unknown; title?: unknown } | undefined;
  if (header === undefined || header === null || typeof header !== "object") return {};
  // origin 只允许 undefined 或 "subagent"（dsh-session:1050）；缺失时也接受 parentSession。
  const parent = header.origin === undefined || header.origin === "subagent" ? header.parentSession : undefined;
  const parentSessionId = typeof parent === "string" && parent !== "" ? parent : undefined;
  const title = typeof header.title === "string" && header.title !== "" ? header.title : undefined;
  return {
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(title === undefined ? {} : { title }),
  };
}

/**
 * 读一个 Session 对象（session/created 的载荷）的会话 header。
 * @param session 会话对象
 */
function readSessionHeader(session: unknown): { parentSessionId?: string; title?: string } {
  const face = session as { header?: unknown; requestHeader?(): unknown } | undefined;
  let header = face?.header;
  if (header === undefined) {
    // 兜底：真正的会话 header 缺失时才退回 requestHeader()。
    // 注意它不是会话 header（见文件头），正常情况下没有 parentSession。
    try {
      if (typeof face?.requestHeader === "function") header = face.requestHeader();
    } catch {
      /* 读不到就当没有 */
    }
  }
  return foldHeader(header);
}

/** 从 agent 对象读 header（agent.session.header，永不把 requestHeader() 放在前面）。 */
function readHeader(agent: unknown): { parentSessionId?: string; title?: string } {
  const session = (agent as { session?: unknown } | undefined)?.session;
  if (session !== undefined && session !== null) return readSessionHeader(session);
  // agent 已经退化成裸 session 时的兜底。
  return readSessionHeader(agent);
}

/** 从 agent 对象读会话 id（多处兜底）。 */
function readSessionId(agent: unknown): string | undefined {
  if (agent === undefined || agent === null) return undefined;
  const direct = (agent as { session?: { id?: unknown } } | undefined)?.session?.id;
  if (typeof direct === "string" && direct !== "") return direct;
  const id = (agent as { id?: unknown } | undefined)?.id;
  if (typeof id === "string" && id !== "") return id;
  return undefined;
}

/** 会话桥句柄。 */
export interface SessionBridge {
  /** 已记录的事件（最近 N 条，V5 与 health 都用它）。 */
  events(): SessionEventRecord[];
  /** 立刻跑一次不在册/已归档巡检；返回本次回收的会话数（测试与运维用）。 */
  sweepNow(): number;
  /** subscribe 返回值：解绑全部监听并停掉巡检定时器。 */
  dispose(): void;
}

const MAX_EVENTS = 200;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/** 「不在册」需要连续命中的次数：一次读空可能是注册表还没就绪，连续两次才认。 */
const MISSES_BEFORE_RECLAIM = 2;
/** ended 集合的上界（防止长进程里无限增长）。 */
const MAX_ENDED = 500;

const realClock: SessionBridgeClock = {
  now: () => Date.now(),
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    // 巡检绝不能拖住进程退出。
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** 读一个服务：先 ctx.get(name)，再属性访问（cordis 的 isolate 映射两条路都要试）。 */
function readService(ctx: unknown, name: string): unknown {
  const face = ctx as { get?: (key: string) => unknown } | undefined;
  try {
    if (typeof face?.get === "function") {
      const viaGet = face.get(name);
      if (viaGet !== undefined) return viaGet;
    }
  } catch {
    /* 继续试属性 */
  }
  try {
    return (ctx as Record<string, unknown> | undefined)?.[name];
  } catch {
    return undefined;
  }
}

/** 默认的存活会话读取器：AgentRegistry.list()（dsh-agent:612-614）。 */
function makeLiveReader(ctx: unknown): () => string[] | undefined {
  return () => {
    try {
      const agents = readService(ctx, "agents") as { list?: () => unknown } | undefined;
      if (typeof agents?.list !== "function") return undefined;
      const list = agents.list();
      if (!Array.isArray(list)) return undefined;
      const ids: string[] = [];
      for (const agent of list) {
        const id = readSessionId(agent);
        if (id !== undefined) ids.push(id);
      }
      return ids;
    } catch {
      return undefined;
    }
  };
}

/** 默认的归档集合读取器：workspaceRegistry.archivedSessionIds（dsh-workspace:504-506）。 */
function makeArchivedReader(ctx: unknown): () => string[] | undefined {
  return () => {
    try {
      const registry = readService(ctx, "workspaceRegistry") as { archivedSessionIds?: unknown } | undefined;
      const archived = registry?.archivedSessionIds;
      if (!Array.isArray(archived)) return undefined;
      return archived.filter((value): value is string => typeof value === "string");
    } catch {
      // requireState() 在注册表状态未就绪时会抛 —— 取不到就什么都不做。
      return undefined;
    }
  };
}

/**
 * 订阅会话事件并转发给 runtime。
 * @param ctx DSH 插件上下文（根 ctx）
 * @param sink mcp-runtime（或测试替身）
 * @param logger 日志面
 * @param options 时钟 / 巡检 / 注册表读取器（测试注入用）
 */
export function attachSessionBridge(
  ctx: unknown,
  sink: SessionSink,
  logger: HubLogger,
  options: SessionBridgeOptions = {},
): SessionBridge {
  const clock = options.clock ?? realClock;
  const records: SessionEventRecord[] = [];
  /** 已开始（并已固化父会话）的会话：id → 身份。巡检只遍历这里。 */
  const identities = new Map<string, { parentSessionId?: string; title?: string }>();
  /** session/created 提前给出的 header 线索（还没开始过的会话，不参与巡检）。 */
  const headerHints = new Map<string, { parentSessionId?: string; title?: string }>();
  /** 已经结束过的会话（sessionEnded 幂等）。 */
  const ended = new Set<string>();
  /** 「不在册」连续命中计数。 */
  const misses = new Map<string, number>();
  const disposers: Array<() => void> = [];
  let sweepTimer: unknown;
  let disposed = false;

  const liveReader = options.liveSessionIds ?? makeLiveReader(ctx);
  const archivedReader = options.archivedSessionIds ?? makeArchivedReader(ctx);
  const carrierKeyOf = options.carrierKeyOf;

  const now = (): string => new Date(clock.now()).toISOString();

  const record = (entry: SessionEventRecord): void => {
    records.push(entry);
    if (records.length > MAX_EVENTS) records.splice(0, records.length - MAX_EVENTS);
  };

  /** 合并身份：已有父会话/标题不被空值覆盖（先来的信息更可靠）。 */
  const remember = (sessionId: string, info: { parentSessionId?: string; title?: string }): void => {
    // 同一个 id 又活过来了（例如 resume 复用旧 id）⇒ 解除「已结束」封印，
    // 否则这一轮结束时 sessionEnded 会被幂等守卫吞掉、实例泄漏。
    ended.delete(sessionId);
    misses.delete(sessionId);
    const previous = identities.get(sessionId);
    identities.set(sessionId, {
      parentSessionId: info.parentSessionId ?? previous?.parentSessionId,
      title: info.title ?? previous?.title,
    });
    // 变成已知会话后就不再需要线索了。
    headerHints.delete(sessionId);
  };

  /** 已知身份（含 session/created 的线索）。 */
  const knownInfo = (sessionId: string): { parentSessionId?: string; title?: string } => {
    const own = identities.get(sessionId);
    const hint = headerHints.get(sessionId);
    return {
      parentSessionId: own?.parentSessionId ?? hint?.parentSessionId,
      title: own?.title ?? hint?.title,
    };
  };

  /** info → McpSessionInfo（只带非空字段）。 */
  const toSinkInfo = (sessionId: string, info: { parentSessionId?: string; title?: string }): McpSessionInfo => ({
    sessionId,
    ...(info.parentSessionId === undefined ? {} : { parentSessionId: info.parentSessionId }),
    ...(info.title === undefined ? {} : { title: info.title }),
  });

  /** 异步通知 sessionStarted，永不阻塞、永不抛。 */
  const notifyStarted = (sessionId: string, info: { parentSessionId?: string; title?: string }): void => {
    // sessionStarted 契约要求不得阻塞：同步记账后退给微任务。
    queueMicrotask(() => {
      try {
        sink.sessionStarted(toSinkInfo(sessionId, info));
      } catch (error) {
        logger.warn(`sessionStarted 处理失败（${sessionId}）：${error instanceof Error ? error.message : error}`);
      }
    });
  };

  /**
   * 结束一个会话：**幂等** —— 同一个 id 只调用一次 sessionEnded。
   * @param sessionId 会话 id
   * @param kind 记账用的事件种类
   * @param reason 回收原因（仅 reclaimed 有）
   */
  const endSession = (
    sessionId: string,
    kind: "disposed" | "subagent-end" | "reclaimed",
    reason?: string,
  ): boolean => {
    if (ended.has(sessionId)) {
      identities.delete(sessionId);
      headerHints.delete(sessionId);
      misses.delete(sessionId);
      return false;
    }
    ended.add(sessionId);
    if (ended.size > MAX_ENDED) {
      const oldest = ended.values().next().value;
      if (typeof oldest === "string") ended.delete(oldest);
    }
    const info = knownInfo(sessionId);
    identities.delete(sessionId);
    headerHints.delete(sessionId);
    misses.delete(sessionId);
    record({
      kind,
      sessionId,
      ...info,
      at: now(),
      ...(reason === undefined ? {} : { reason }),
    });
    void Promise.resolve()
      .then(() => sink.sessionEnded(sessionId))
      .catch((error: unknown) => {
        logger.warn(`sessionEnded 处理失败（${sessionId}）：${error instanceof Error ? error.message : error}`);
      });
    return true;
  };

  const on = (name: string, listener: (...args: unknown[]) => void): void => {
    const face = ctx as { on?: (event: string, fn: (...a: unknown[]) => void) => unknown } | undefined;
    if (typeof face?.on !== "function") {
      logger.warn(`会话桥：ctx.on 不可用，事件 ${name} 未能订阅`);
      return;
    }
    try {
      const dispose = face.on(name, listener);
      if (typeof dispose === "function") disposers.push(dispose as () => void);
    } catch (error) {
      logger.warn(`会话桥：订阅 ${name} 失败：${error instanceof Error ? error.message : error}`);
    }
  };

  // ---- session/created：只记线索，不启动（官方读法：session.header.parentSession） ----
  on("session/created", (...args: unknown[]) => {
    try {
      const session = args[0];
      const sessionId = readSessionId(session);
      if (sessionId === undefined) return;
      const header = readSessionHeader(session);
      if (header.parentSessionId === undefined) return; // 只有子会话才需要线索
      headerHints.set(sessionId, header);
    } catch (error) {
      logger.debug(`session/created 线索记录失败：${error instanceof Error ? error.message : error}`);
    }
  });

  // ---- agent/created：串行事件，必须立刻返回 ----
  on("agent/created", (...args: unknown[]) => {
    try {
      const payload = args[0] as { agent?: unknown } | undefined;
      const agent = payload?.agent ?? payload;
      const sessionId = readSessionId(agent);
      if (sessionId === undefined) {
        logger.debug("agent/created 未取到会话 id，跳过");
        return;
      }
      const header = readHeader(agent);
      const info = {
        parentSessionId: header.parentSessionId ?? headerHints.get(sessionId)?.parentSessionId,
        title: header.title ?? headerHints.get(sessionId)?.title,
      };
      remember(sessionId, info);
      record({ kind: "created", sessionId, ...info, at: now() });
      notifyStarted(sessionId, info);
    } catch (error) {
      logger.warn(`agent/created 处理失败：${error instanceof Error ? error.message : error}`);
    }
  });

  // ---- agent/disposed：emit 语义，抛错被 contain ----
  on("agent/disposed", (...args: unknown[]) => {
    try {
      const payload = args[0] as { agent?: unknown; sessionId?: unknown } | undefined;
      const agent = payload?.agent ?? payload;
      const sessionId = readSessionId(agent) ?? (typeof payload?.sessionId === "string" ? payload.sessionId : undefined);
      if (sessionId === undefined) return;
      endSession(sessionId, "disposed");
    } catch (error) {
      logger.warn(`agent/disposed 处理失败：${error instanceof Error ? error.message : error}`);
    }
  });

  // ---- session/disposed：会话从 store 摘除（dsh-session:1806-1818），归档不走这条路 ----
  on("session/disposed", (...args: unknown[]) => {
    try {
      const sessionId = readSessionId(args[0]);
      if (sessionId === undefined) return;
      endSession(sessionId, "disposed");
    } catch (error) {
      logger.warn(`session/disposed 处理失败：${error instanceof Error ? error.message : error}`);
    }
  });

  // ---- workspace/session-stop：「停止并归档」时 workspace 派发的释放钩子（dsh-workspace:619-627）----
  on("workspace/session-stop", (...args: unknown[]) => {
    try {
      const request = args[0] as { sessionId?: unknown } | undefined;
      const sessionId = typeof request?.sessionId === "string" ? request.sessionId : undefined;
      if (sessionId === undefined) return;
      endSession(sessionId, "reclaimed", "session-stop");
    } catch (error) {
      logger.warn(`workspace/session-stop 处理失败：${error instanceof Error ? error.message : error}`);
    }
  });

  /**
   * subagent/start 的父会话来源，按可靠程度依次取：
   *   1. 已固化的身份（agent/created 或 session/created 给过 header）；
   *   2. 注册表里的子 agent：`ctx.agents.get(info.id)` → agent.session.header.parentSession
   *      （官方注释：in-process provider 在本通知期间就能解析到）；
   *   3. 官方 carrier 恢复：`carrierKeyOf(this)` 拿到父 agent（info 里没有父字段）；
   *   4. 老式两参数兼容分支：args[1] 上的 agent/session。
   * 注意：**必须用普通 function**，箭头函数拿不到 cordis 绑定的 this。
   */
  on("subagent/start", function subagentStart(this: unknown, ...args: unknown[]) {
    try {
      const info = args[0] as { id?: unknown; sessionId?: unknown; agent?: unknown } | undefined;
      const sessionId = typeof info?.id === "string" && info.id !== ""
        ? info.id
        : typeof info?.sessionId === "string" && info.sessionId !== ""
          ? info.sessionId
          : readSessionId(info?.agent);
      if (sessionId === undefined) {
        logger.debug("subagent/start 未取到会话 id");
        return;
      }
      let parentSessionId = knownInfo(sessionId).parentSessionId;
      if (parentSessionId === undefined) {
        try {
          const agents = readService(ctx, "agents") as { get?: (id: string) => unknown } | undefined;
          if (typeof agents?.get === "function") parentSessionId = readHeader(agents.get(sessionId)).parentSessionId;
        } catch {
          /* 注册表读不到就试下一个来源 */
        }
      }
      if (parentSessionId === undefined && typeof carrierKeyOf === "function") {
        try {
          const carrierKey = carrierKeyOf(this);
          parentSessionId = readSessionId(carrierKey);
          if (parentSessionId === sessionId) parentSessionId = undefined; // 自环保护
        } catch {
          /* carrier 不是 scope carrier 就跳过 */
        }
      }
      if (parentSessionId === undefined) {
        const legacy = args[1];
        if (legacy !== undefined) parentSessionId = readSessionId(legacy);
      }
      const merged = {
        ...knownInfo(sessionId),
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
      };
      remember(sessionId, merged);
      record({ kind: "subagent-start", sessionId, ...merged, at: now() });
      notifyStarted(sessionId, merged);
    } catch (error) {
      logger.warn(`subagent/start 处理失败：${error instanceof Error ? error.message : error}`);
    }
  });

  on("subagent/end", (...args: unknown[]) => {
    try {
      const info = args[0] as { id?: unknown; sessionId?: unknown; agent?: unknown } | undefined;
      const sessionId = typeof info?.id === "string" && info.id !== ""
        ? info.id
        : typeof info?.sessionId === "string" && info.sessionId !== ""
          ? info.sessionId
          : readSessionId(info?.agent);
      if (sessionId === undefined) return;
      endSession(sessionId, "subagent-end");
    } catch (error) {
      logger.warn(`subagent/end 处理失败：${error instanceof Error ? error.message : error}`);
    }
  });

  /**
   * 不在册 / 已归档巡检（FIX-8 §3）：
   *   - 两个读取器都取不到 → 什么都不做（绝不误杀）；
   *   - 会话在归档集合里 → 立即回收（archived-session-gate 之后它再也跑不了 pre-step）；
   *   - 会话连续 MISSES_BEFORE_RECLAIM 次不在存活注册表里 → 回收。
   */
  const sweep = (): number => {
    if (disposed || identities.size === 0) return 0;
    const live = liveReader();
    const archived = archivedReader();
    if (live === undefined && archived === undefined) return 0;
    const liveSet = live === undefined ? undefined : new Set(live);
    const archivedSet = archived === undefined ? undefined : new Set(archived);
    let reclaimed = 0;
    for (const sessionId of [...identities.keys()]) {
      if (ended.has(sessionId)) continue;
      if (archivedSet?.has(sessionId) === true) {
        if (endSession(sessionId, "reclaimed", "archived")) reclaimed += 1;
        continue;
      }
      if (liveSet === undefined) continue;
      if (liveSet.has(sessionId)) {
        misses.delete(sessionId);
        continue;
      }
      const miss = (misses.get(sessionId) ?? 0) + 1;
      misses.set(sessionId, miss);
      if (miss < MISSES_BEFORE_RECLAIM) continue;
      if (endSession(sessionId, "reclaimed", "not-live")) reclaimed += 1;
    }
    return reclaimed;
  };

  const intervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  if (intervalMs > 0) {
    try {
      sweepTimer = clock.setInterval(() => {
        try {
          sweep();
        } catch (error) {
          logger.warn(`会话巡检失败：${error instanceof Error ? error.message : error}`);
        }
      }, intervalMs);
    } catch (error) {
      logger.warn(`会话巡检定时器创建失败（已降级为不巡检）：${error instanceof Error ? error.message : error}`);
    }
  }

  return {
    events: () => [...records],
    sweepNow: () => {
      try {
        return sweep();
      } catch (error) {
        logger.warn(`会话巡检失败：${error instanceof Error ? error.message : error}`);
        return 0;
      }
    },
    dispose(): void {
      disposed = true;
      if (sweepTimer !== undefined) {
        try {
          clock.clearInterval(sweepTimer);
        } catch {
          /* 清定时器失败不影响卸载 */
        }
        sweepTimer = undefined;
      }
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* 解绑失败不影响卸载 */
        }
      }
    },
  };
}
