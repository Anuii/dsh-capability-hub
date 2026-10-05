/**
 * 模块注册表：永不失败外壳（F5 §3.3「永不失败的 shell 模块」模式）。
 *
 * 模式要点（照抄 @linxin666/dsh-web-all 的 shell）：
 *   1. 每个功能模块独立加载、独立 try/catch；同步失败与异步失败都要记降级。
 *   2. 「加载失败」只记账，绝不 rethrow —— 否则会变成 loader 的 error 日志甚至
 *      启动诊断（本插件条目 id 不在 required 名单里，最坏也只是 warning，
 *      但我们的目标是连 warning 都不产生非预期条目）。
 *   3. 降级状态要能被 GET health 读到，用户必须看得见。
 *
 * 阶段 A：只有 demo（demo.ts）与「故意失败」演示（demo-failing.ts）。
 * 阶段 B：4 个真实模块（skills-local / skills-remote / mcp-config / mcp-runtime）
 *         由本文件的 createFeatureModuleEntries() 按依赖顺序接入（见该函数顶部说明）。
 */
import type { HubContext, HubModule, RouteTable } from "./types.ts";
import type { SdkLoadState } from "./sdk-loader.ts";
import { createMcpConfigModule } from "../../mcp/config/module.ts";
import { createSkillsLocalModule } from "../../skills/local/module.ts";
import { createSkillsRemoteModule } from "../../skills/remote/module.ts";
import { createMcpRuntimeModule } from "../../mcp/runtime/module.ts";

/** 一个模块条目的定义。 */
export interface ModuleEntry {
  /** 模块名（只用于诊断与 health）。 */
  name: string;
  /** 加载函数：返回 HubModule（routes + 可选 dispose）。允许同步抛或返回 rejected Promise。 */
  load(ctx: HubContext): HubModule | Promise<HubModule>;
}

/** 单个模块的即时状态。 */
export interface ModuleStatus {
  name: string;
  /** ok = 已挂载；degraded = 加载失败被降级；disposed = 已卸载 */
  status: "ok" | "degraded" | "disposed";
  /** 已注册的路由键。 */
  routes: string[];
  /** 降级原因（中文）。 */
  message?: string;
  /** 降级发生的时刻。 */
  at?: string;
  /** 加载耗时（毫秒）。 */
  loadMs?: number;
}

/** 安全读错误消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 模块注册表。 */
export class ModuleRegistry {
  readonly #ctx: HubContext;
  readonly #statuses = new Map<string, ModuleStatus>();
  readonly #live = new Map<string, HubModule>();
  readonly #routeTable: RouteTable;
  readonly #order: string[] = [];

  constructor(ctx: HubContext, routeTable: RouteTable) {
    this.#ctx = ctx;
    this.#routeTable = routeTable;
  }

  /** 已注册的模块状态（按加载顺序）。 */
  statuses(): ModuleStatus[] {
    return this.#order.map((name) => this.#statuses.get(name) ?? { name, status: "disposed", routes: [] });
  }

  /** 是否有任何模块降级。 */
  degraded(): ModuleStatus[] {
    return this.statuses().filter((entry) => entry.status === "degraded");
  }

  /** 汇总路由表（外壳把路由交给路由器时用）。 */
  routes(): RouteTable {
    return this.#routeTable;
  }

  /** 取某个模块实例（阶段 B 的子模块接线用）。 */
  get<T = HubModule>(name: string): T | undefined {
    return this.#live.get(name) as T | undefined;
  }

  /** 加载全部模块（永不 reject）。 */
  async loadAll(entries: ModuleEntry[]): Promise<void> {
    for (const entry of entries) {
      this.#order.push(entry.name);
      await this.loadOne(entry);
    }
  }

  /** 加载单个模块，失败只记账。 */
  async loadOne(entry: ModuleEntry): Promise<void> {
    const started = Date.now();
    let module: HubModule;
    try {
      module = await entry.load(this.#ctx);
    } catch (error) {
      this.recordDegraded(entry.name, error, Date.now() - started);
      return;
    }
    const routes: string[] = [];
    try {
      for (const [key, handler] of Object.entries(module.routes ?? {})) {
        if (this.#routeTable[key] !== undefined) {
          throw new Error(`路由 ${key} 已被其他模块占用`);
        }
        this.#routeTable[key] = handler;
        routes.push(key);
      }
    } catch (error) {
      // 注册中途失败：回滚本模块已注册的路由（该模块零路由）。
      for (const key of routes) delete this.#routeTable[key];
      try {
        await module.dispose?.();
      } catch {
        /* 回滚时的 dispose 失败忽略 */
      }
      this.recordDegraded(entry.name, error, Date.now() - started);
      return;
    }
    this.#live.set(entry.name, module);
    this.#statuses.set(entry.name, {
      name: entry.name,
      status: "ok",
      routes,
      loadMs: Date.now() - started,
    });
  }

  /** 记录一次降级（同步与异步失败共用）。 */
  recordDegraded(name: string, error: unknown, loadMs?: number): ModuleStatus {
    const status: ModuleStatus = {
      name,
      status: "degraded",
      routes: [],
      message: messageOf(error),
      at: new Date().toISOString(),
      ...(loadMs === undefined ? {} : { loadMs }),
    };
    this.#statuses.set(name, status);
    this.#ctx.logger.warn(`模块 ${name} 加载失败，已降级（不影响 DSH）：${status.message}`);
    return status;
  }

  /** 卸载全部模块。 */
  async disposeAll(): Promise<void> {
    for (const [name, module] of [...this.#live].reverse()) {
      try {
        await module.dispose?.();
      } catch (error) {
        this.#ctx.logger.warn(`模块 ${name} 卸载失败：${messageOf(error)}`);
      }
      const previous = this.#statuses.get(name);
      if (previous !== undefined) this.#statuses.set(name, { ...previous, status: "disposed" });
    }
    this.#live.clear();
  }
}
// =====================================================================================
// 阶段 B：4 个真实模块的接线表
// =====================================================================================

/** 已挂载的模块句柄（load 阶段填入，供下游模块与外壳取用）。 */
export interface FeatureState {
  mcpConfig?: ReturnType<typeof createMcpConfigModule>;
  skillsLocal?: ReturnType<typeof createSkillsLocalModule>;
  skillsRemote?: ReturnType<typeof createSkillsRemoteModule>;
  mcpRuntime?: ReturnType<typeof createMcpRuntimeModule>;
  /** skills-local ← skills-remote.lockStash 是否绑定成功。 */
  lockStashBound: boolean;
  /** 后台工作（runtime.start()）是否已经无异常地跑起来。 */
  runtimeStarted: boolean;
  /** start() 的失败原因（成功时 undefined）。 */
  runtimeStartError?: string;
  /** 接线过程中的中文说明（health 里可见）。 */
  notes: string[];
}

export function makeFeatureState(): FeatureState {
  return { lockStashBound: false, runtimeStarted: false, notes: [] };
}

/** 安全读错误消息。 */
function errorTextOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 4 个真实模块的加载表（依赖顺序）：**mcp-config → skills-local → skills-remote
 * → lockStash 绑定 → mcp-runtime → runtime.start()**。
 *
 * 降级语义（D-F1「永不失败外壳」）：
 *   - 每个模块的 load 由 ModuleRegistry 独立 try/catch（同步抛与 rejected Promise 都算）；
 *   - 上游缺失时下游**主动抛错**，因此下游在 health 里显示 degraded 并带中文原因，
 *     而不是静默地半残废（例如 mcp-config 挂了，mcp-runtime 必然不可用）；
 *   - runtime.start() 只做后台工作（配置监听、空闲巡检、启动探测）。它失败**不摘模块**
 *     （三条路由与懒加载路径仍然可用），只在 FeatureState 里记原因并进 health。
 *   - LockStash 绑定失败同样只记原因：skills-local 的删除路径会退化成「lock 条目留在
 *     原处」，其余功能不受影响。
 */
export function createFeatureModuleEntries(options: {
  ctx: HubContext;
  sdk: SdkLoadState;
  state: FeatureState;
  /** 调试开关：强制这些模块装载失败（降级验证用，见 devOverrides.failModules）。 */
  failModules?: string[];
}): ModuleEntry[] {
  const { ctx, sdk, state } = options;
  const log = ctx.logger;
  const forced = new Set(options.failModules ?? []);

  return [
    {
      name: "mcp-config",
      load: (moduleCtx) => {
        if (forced.has("mcp-config")) {
          throw new Error("调试开关 devOverrides.failModules 要求 mcp-config 失败（降级验证用）");
        }
        const mod = createMcpConfigModule(moduleCtx);
        state.mcpConfig = mod;
        return mod as unknown as HubModule;
      },
    },
    {
      name: "skills-local",
      load: (moduleCtx) => {
        if (forced.has("skills-local")) {
          throw new Error("调试开关 devOverrides.failModules 要求 skills-local 失败（降级验证用）");
        }
        const mod = createSkillsLocalModule(moduleCtx);
        state.skillsLocal = mod;
        return mod as unknown as HubModule;
      },
    },
    {
      name: "skills-remote",
      load: (moduleCtx) => {
        if (forced.has("skills-remote")) {
          throw new Error("调试开关 devOverrides.failModules 要求 skills-remote 失败（降级验证用）");
        }
        const local = state.skillsLocal;
        if (local === undefined) {
          throw new Error("依赖 skills-local 未加载：远程技能与来源记录不可用");
        }
        const mod = createSkillsRemoteModule(moduleCtx, { skills: local.api });
        // 双向绑定：skills-local 删除 user-agents 技能时，lock 条目要跟着进回收站并在恢复时放回。
        try {
          local.bindLockStash(mod.lockStash);
          state.lockStashBound = true;
        } catch (error) {
          state.lockStashBound = false;
          const message = "LockStash 绑定失败：" + errorTextOf(error);
          state.notes.push(message);
          log.warn(message + "（技能删除时 lock 条目将留在原处，其余功能不受影响）");
        }
        state.skillsRemote = mod;
        return mod as unknown as HubModule;
      },
    },
    {
      name: "mcp-runtime",
      load: (moduleCtx) => {
        if (forced.has("mcp-runtime")) {
          throw new Error("调试开关 devOverrides.failModules 要求 mcp-runtime 失败（降级验证用）");
        }
        const config = state.mcpConfig;
        if (config === undefined) {
          throw new Error("依赖 mcp-config 未加载：缺少配置来源，运行态不可用");
        }
        if (sdk.status !== "loaded") {
          throw new Error("MCP SDK 未加载：" + sdk.message);
        }
        const mod = createMcpRuntimeModule(moduleCtx, { config: config.source, sdk: sdk.sdk });
        state.mcpRuntime = mod;
        // start() 是 T3b 记录的「加法」：不调用它就只有懒加载路径，没有自动探测与空闲回收。
        // 它是纯后台工作，fire-and-forget（绝不阻塞模块装载，也就不会拖住路由注册）。
        void mod.start().then(
          () => {
            state.runtimeStarted = true;
          },
          (error: unknown) => {
            state.runtimeStarted = false;
            state.runtimeStartError = errorTextOf(error);
            state.notes.push("mcp-runtime.start() 失败：" + state.runtimeStartError);
            log.warn("mcp-runtime.start() 失败（自动探测与空闲回收不可用，其余功能不受影响）：" + state.runtimeStartError);
          },
        );
        return mod as unknown as HubModule;
      },
    },
  ];
}