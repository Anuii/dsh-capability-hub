/**
 * 永不失败外壳（F5 §3.3 / D-F1）。
 *
 * 职责：
 *   1. 解析 HubContext；
 *   2. 加载 MCP SDK（失败只降级）；
 *   3. 按依赖顺序装载各功能模块（4 个真实模块 + demo + 可选「故意失败」演示），
 *      每个模块独立 try/catch，失败只记账（见 modules.ts 的 createFeatureModuleEntries）；
 *   4. 注册全局工具 mcp（**真实的 mcp-runtime**；它不可用时退回桩并写明原因）；
 *   5. 接会话事件桥（含不在册/已归档巡检）；
 *   6. 挂 HTTP 路由（前缀 /api/dsh-capability-hub/，继承 DSH browser-auth）；
 *   7. 写启动报告。
 *
 * 顺序为什么是「模块 → 工具 → 路由」：工具必须拿到**已经装载好的** mcp-runtime 实例
 * （schema/描述/execute 都来自它），所以模块装载必须在工具注册之前；而路由表是模块填的，
 * 注册路由又必须在模块装载之后。三项都不能提前。
 *
 * 所有失败都只记账并暴露在 GET health；apply() 本身永不 throw。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PlatformContext } from "./types.ts";
import type { RouteTable } from "../contract/host.ts";
import { makeLogger, probeSkillSources, resolveHubContext, safeGet, type PlatformConfig } from "./hub-context.ts";
import { ROUTE_PREFIX, registerRoutes, type ConnectionFace } from "./router.ts";
import {
  ModuleRegistry,
  createFeatureModuleEntries,
  makeFeatureState,
  type FeatureState,
  type ModuleEntry,
  type ModuleStatus,
} from "./modules.ts";
import { loadMcpSdk, type SdkLoadState } from "./sdk-loader.ts";
import { createStubRuntime } from "./stub-runtime.ts";
import { registerMcpTool, type ToolRegistration } from "./tool-registrar.ts";
import { attachSessionBridge, type SessionBridge } from "./session-bridge.ts";
import { createDemoModule } from "./demo.ts";
import { HUB_VERSION } from "../../version.ts";
import { createRejectingModule, createThrowingModule } from "./demo-failing.ts";
import type { McpRuntime } from "../../mcp/contract/runtime.ts";

/** 接线摘要（health 里的 wiring 字段）。 */
export interface WiringSnapshot {
  /** real = 真实的 mcp-runtime；stub = 退回桩实现。 */
  runtimeSource: "real" | "stub";
  /** 退回桩时的中文原因。 */
  runtimeReason?: string;
  /** skills-local ← skills-remote.lockStash 是否绑定成功。 */
  lockStashBound: boolean;
  /** mcp-runtime.start()（后台工作）是否已无异常跑起来。 */
  runtimeStarted: boolean;
  runtimeStartError?: string;
  /** 接线过程中的中文说明。 */
  notes: string[];
}

/** 外壳的运行时快照（health 用）。 */
export interface ShellSnapshot {
  routes: string[];
  sdk: SdkLoadState;
  modules: ModuleStatus[];
  toolRegistered: boolean;
  toolDescription: string;
  sessionEventCount: number;
  /** 已注册的已鉴权路由路径（V3）。 */
  registeredPaths: string[];
  /** 路由注册失败原因（成功时 undefined）。 */
  registrationError?: string;
  /** 阶段 B 的接线摘要。 */
  wiring: WiringSnapshot;
}

/** 外壳句柄（测试与 V7 用）。 */
export interface Shell {
  ctx: PlatformContext;
  /** 已注册的路由表（路由器用的就是它）。 */
  routes: RouteTable;
  registry: ModuleRegistry;
  snapshot(): ShellSnapshot;
  /** 已注册的已鉴权路由路径。 */
  registeredPaths(): string[];
  /** 路由注册失败原因。 */
  registrationError(): string | undefined;
  dispose(): Promise<void>;
}

/** 安全读错误消息。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const startedAt = new Date().toISOString();

/** 平台层关心的服务名（启动报告里逐项探测，便于定位「服务不可见」类问题）。 */
const SERVICE_PROBE = ["connection", "webServer", "tools", "loader", "profileContext", "credentials", "sessions", "attachments", "commands", "skills"];

/** 逐项探测服务可见性（拿不到就是 false，绝不抛）。 */
function probeServices(hostCtx: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const name of SERVICE_PROBE) out[name] = safeGet(hostCtx, name) !== undefined;
  return out;
}

/**
 * 取 connection 服务。
 *
 * cordis 的 Context.get 走 isolate 映射（cordis/lib/index.js:763-772），属性访问（ctx.connection）
 * 又要求它已在本 fiber 的可见集合里，所以两条路都要试，且都要能失败。
 */
function readConnection(hostCtx: unknown, logger: PlatformContext["logger"]): ConnectionFace | undefined {
  const viaGet = safeGet(hostCtx, "connection") as ConnectionFace | undefined;
  if (viaGet !== undefined) return viaGet;
  try {
    const viaProp = (hostCtx as { connection?: ConnectionFace }).connection;
    if (viaProp !== undefined) return viaProp;
  } catch (error) {
    logger.debug("ctx.connection 属性访问抛错：" + messageOf(error));
  }
  return undefined;
}

/**
 * 尽力加载 @deepseek-ai/dsh-scope 的 carrierKeyOf（只读，绝不抛）。
 *
 * 为什么需要它：subagent/start 的监听器只收到一个 info 参数，父会话只存在于 scoped
 * dispatch 的 carrier（即监听器的 `this`）里；官方就是用 `carrierKeyOf(this)` 取父
 * agent 的（dsh-sdk-jsonrpc-server/lib/index.js:34-37、90-96）。该包是可选依赖：
 * 加载失败就返回 undefined，桥的其余父会话来源照常工作。
 *
 * 为什么用拼接的模块名：本插件不静态依赖 @deepseek-ai/*（理由见 tool-registrar.ts
 * 顶部），而且宿主构建把 @deepseek-ai/* 标成 external —— 拼接可以让打包器把它当
 * 纯运行时 import，不参与解析。
 */
async function loadCarrierKeyOf(): Promise<((carrier: unknown) => unknown) | undefined> {
  try {
    const specifier = "@deepseek-ai/" + "dsh-scope";
    const loaded = (await import(specifier)) as { carrierKeyOf?: unknown } | undefined;
    const fn = loaded?.carrierKeyOf;
    return typeof fn === "function" ? (fn as (carrier: unknown) => unknown) : undefined;
  } catch {
    return undefined;
  }
}

/** 读 DSH 版本（尽力而为）。 */
function readDshVersion(): string | undefined {
  try {
    const env = process.env.DSH_DESKTOP_VERSION;
    return typeof env === "string" && env !== "" ? env : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 组装外壳（不依赖 DSH 的任何具体服务；由 src/platform/host/index.ts 负责接 ctx）。
 * @param hostCtx DSH 根 ctx
 * @param config 插件配置
 * @param packageRoot 本包宿主半目录
 */
export async function createShell(hostCtx: unknown, config: PlatformConfig, packageRoot: string): Promise<Shell> {
  const logger = makeLogger(hostCtx);
  const ctx = resolveHubContext(hostCtx, config, packageRoot, logger);
  const routes: RouteTable = {};
  const registry = new ModuleRegistry(ctx, routes);
  logger.info(`启动：profile=${ctx.profileName} homeDir=${ctx.homeDir} hubHome=${ctx.hubHome}`);

  // ---- 1. MCP SDK（永不抛） ----
  const sdkState: SdkLoadState = await loadMcpSdk();
  if (sdkState.status === "loaded") {
    logger.info(`MCP SDK 已加载：${sdkState.info.mainResolved ?? "?"} v${sdkState.info.version ?? "?"}`);
  } else {
    logger.warn(`${sdkState.message}（mcp 工具将退回桩实现，只返回「不可用」）`);
  }

  // ---- 2. 模块表（4 个真实模块按依赖顺序；demo 放最前，失败演示放最后） ----
  const state: FeatureState = makeFeatureState();
  /** 工具与运行时的当前状态（demo 的 health 通过闭包实时读取）。 */
  const toolState: { current?: ToolRegistration; error?: string } = {};
  const runtimeState: { runtime?: McpRuntime; source: "real" | "stub"; reason?: string } = { source: "stub" };

  const entries: ModuleEntry[] = [
    {
      name: "demo",
      // demo 的 health 要报 profileDir / packageRoot，用外壳自己的完整上下文。
      load: () => createDemoModule({
        ctx,
        sdk: sdkState,
        modules: () => registry.statuses(),
        sessionEvents: () => bridge?.events() ?? [],
        tool: () => ({
          registered: toolState.current?.registered ?? false,
          name: runtimeState.runtime?.toolName ?? "mcp",
          description: toolState.current?.description() ?? runtimeState.runtime?.toolDescription() ?? "",
          ...(toolState.error === undefined ? {} : { error: toolState.error }),
        }),
        host: () => ({
          ...(readDshVersion() === undefined ? {} : { dshVersion: readDshVersion() }),
          pluginVersion: HUB_VERSION,
          pid: process.pid,
          nodeVersion: process.version,
          startedAt,
        }),
        registration: () => ({
          registered: registration?.paths ?? [],
          ...(registrationError === undefined ? {} : { error: registrationError }),
        }),
        wiring: () => ({
          runtimeSource: runtimeState.source,
          ...(runtimeState.reason === undefined ? {} : { runtimeReason: runtimeState.reason }),
          lockStashBound: state.lockStashBound,
          runtimeStarted: state.runtimeStarted,
          ...(state.runtimeStartError === undefined ? {} : { runtimeStartError: state.runtimeStartError }),
          notes: [...state.notes],
        }),
      }),
    },
    ...createFeatureModuleEntries({
      ctx,
      sdk: sdkState,
      state,
      ...(config.devOverrides?.failModules === undefined ? {} : { failModules: config.devOverrides.failModules }),
    }),
  ];
  if (config.devOverrides?.failureDemo === true) {
    entries.push({ name: "demo-failing-sync", load: () => createThrowingModule() });
    entries.push({ name: "demo-failing-async", load: () => createRejectingModule() });
  }
  await registry.loadAll(entries);

  // ---- 3. 工具注册：优先用真实的 mcp-runtime，不可用才退回桩 ----
  const runtimeModule = registry.get<{ runtime: McpRuntime }>("mcp-runtime");
  if (runtimeModule !== undefined) {
    runtimeState.runtime = runtimeModule.runtime;
    runtimeState.source = "real";
  } else {
    const degraded = registry.statuses().find((entry) => entry.name === "mcp-runtime");
    runtimeState.reason = degraded?.message ?? "mcp-runtime 未加载（原因未知）";
    runtimeState.runtime = createStubRuntime({ reason: runtimeState.reason });
    runtimeState.source = "stub";
    logger.warn(`mcp 工具退回桩实现：${runtimeState.reason}`);
  }
  const runtime = runtimeState.runtime;

  let toolError: string | undefined;
  const toolsFacade = safeGet(hostCtx, "tools") as { register?: (definition: unknown) => () => void } | undefined;
  if (toolsFacade !== undefined && typeof toolsFacade.register === "function") {
    // 手写 definition，不 import @deepseek-ai/dsh-tools（原因见 tool-registrar.ts 顶部）。
    toolState.current = registerMcpTool({
      tools: { register: (definition) => toolsFacade.register!(definition) },
      runtime,
      logger,
    });
  } else {
    logger.error("ctx.tools 不可用，mcp 工具未注册（已降级，不影响 DSH）");
  }
  toolError = toolState.current?.registered === true ? undefined : (toolState.current?.error ?? "ctx.tools 不可用");
  toolState.error = toolError;

  // ---- 4. 会话桥（agent/created、agent/disposed、session/disposed、subagent/start|end、
  //          workspace/session-stop + 不在册/已归档巡检） ----
  // carrierKeyOf 是「加载完就用」的活引用：外壳启动是同步的，动态 import 只能异步补上；
  // 还没加载好时返回 undefined，桥会退回其余来源（不会误判）。
  let carrierKeyOfImpl: ((carrier: unknown) => unknown) | undefined;
  void loadCarrierKeyOf().then(
    (fn) => {
      if (fn !== undefined) carrierKeyOfImpl = fn;
    },
    () => {
      /* 永不抛：拿不到就少一个父会话来源 */
    },
  );
  let bridge: SessionBridge | undefined;
  try {
    bridge = attachSessionBridge(hostCtx, {
      sessionStarted: (info) => runtime.sessionStarted(info),
      sessionEnded: (sessionId) => runtime.sessionEnded(sessionId),
    }, logger, {
      carrierKeyOf: (carrier) => carrierKeyOfImpl?.(carrier),
    });
  } catch (error) {
    logger.warn(`会话桥挂载失败（已降级）：${error instanceof Error ? error.message : error}`);
  }

  // ---- 5. 路由注册（必须在模块加载之后：路由表是模块填的） ----
  // 注册到 ctx.connection.fetch 的 exact Fetch 路由表，从而继承 DSH 的信任闸与
  // browser-auth（详见 router.ts 顶部）。拿不到 connection 就只降级：宁可接口不可用，
  // 也不能退回「更长 prefix 盖掉 /api 鉴权」的写法。
  //
  // 时序（实测）：connection 服务由 client-connection 插件提供，它在本插件之后挂载，
  // 所以外壳启动那一刻 ctx.get("connection") 是 undefined（启动报告里的 services 探测
  // 记录了这一点）。因此这里先试一次，失败就挂 ctx.inject(["connection"], cb) 等它出现
  // —— 与 DSH 自己在 connection 插件里用 ctx.inject(["webServer"], ...) 的做法一致。
  let registration: { paths: string[]; dispose(): void } | undefined;
  let registrationError: string | undefined;

  const attemptRegister = (source: unknown): void => {
    if (registration !== undefined && registration.paths.length > 0) return;
    const connection = readConnection(source, logger) ?? readConnection(hostCtx, logger);
    try {
      registration = registerRoutes(connection as ConnectionFace, routes, logger);
      registrationError = undefined;
      logger.info(`已注册 ${registration.paths.length} 条已鉴权路由：${registration.paths.join(", ")}`);
    } catch (error) {
      registrationError = messageOf(error);
      logger.error(`注册 HTTP 路由失败（已降级，等待 connection 服务）：${registrationError}`);
    }
    void writeBootReport();
  };

  // ---- 6. 启动报告（落盘到 <hubHome>/boot.json，覆盖写）----
  // 为什么需要它：外壳的降级状态本来只暴露在 GET health 上，但「路由都没注册成功」时
  // health 根本不可达。落一份小 JSON 是唯一能自查启动结果的通道（DEV.md 有说明）。
  const wiringSnapshot = (): WiringSnapshot => ({
    runtimeSource: runtimeState.source,
    ...(runtimeState.reason === undefined ? {} : { runtimeReason: runtimeState.reason }),
    lockStashBound: state.lockStashBound,
    runtimeStarted: state.runtimeStarted,
    ...(state.runtimeStartError === undefined ? {} : { runtimeStartError: state.runtimeStartError }),
    notes: [...state.notes],
  });
  const snapshotOf = (): ShellSnapshot => ({
    routes: Object.keys(routes).sort(),
    sdk: sdkState,
    modules: registry.statuses(),
    toolRegistered: toolState.current?.registered ?? false,
    toolDescription: toolState.current?.description() ?? runtime.toolDescription(),
    sessionEventCount: bridge?.events().length ?? 0,
    registeredPaths: registration?.paths ?? [],
    ...(registrationError === undefined ? {} : { registrationError }),
    wiring: wiringSnapshot(),
  });
  const writeBootReport = async (): Promise<void> => {
   try {
    const bootPath = join(ctx.hubHome, "boot.json");
    await mkdir(dirname(bootPath), { recursive: true });
    await writeFile(bootPath, JSON.stringify({
      plugin: "dsh-capability-hub",
      packageRoot,
      profileName: ctx.profileName,
      homeDir: ctx.homeDir,
      dshHome: ctx.dshHome,
      hubHome: ctx.hubHome,
      pid: process.pid,
      nodeVersion: process.version,
      startedAt,
      writtenAt: new Date().toISOString(),
      services: probeServices(hostCtx),
      skillSources: probeSkillSources(hostCtx),
      toolError: toolError ?? null,
      hasInjectApi: typeof (hostCtx as { inject?: unknown })?.inject === "function",
      ...snapshotOf(),
    }, null, 2), "utf8");
    logger.debug(`启动报告已写入 ${bootPath}`);
   } catch (error) {
    logger.warn(`启动报告写入失败（不影响运行）：${messageOf(error)}`);
   }
  };

  // 先试一次（connection 可能已经就绪），再挂 inject 等它。
  attemptRegister(hostCtx);
  if (registration === undefined) {
    const inject = (hostCtx as { inject?: (names: string[], callback: (scoped: unknown) => void) => unknown }).inject;
    if (typeof inject === "function") {
      try {
        inject.call(hostCtx, ["connection"], (connectionCtx: unknown) => {
          attemptRegister(connectionCtx);
        });
      } catch (error) {
        logger.error(`ctx.inject(["connection"]) 失败：${messageOf(error)}`);
      }
    } else {
      logger.error("ctx.inject 不可用，无法等待 connection 服务");
    }
  }
  await writeBootReport();

  return {
    ctx,
    routes,
    registry,
    registeredPaths(): string[] {
      return registration?.paths ?? [];
    },
    registrationError(): string | undefined {
      return registrationError;
    },
    snapshot: snapshotOf,
    async dispose(): Promise<void> {
      // 顺序刻意与装载相反：先摘路由（不再接受新请求），再拆工具与会话桥，
      // 然后按模块装载的**逆序** dispose（mcp-runtime 最先 → runtime.dispose() 结束全部子进程），
      // 最后才收桩 runtime。
      registration?.dispose();
      bridge?.dispose();
      toolState.current?.dispose();
      await registry.disposeAll();
      if (runtimeState.source === "stub") await runtime.dispose();
    },
  };
}

/** 路由常量与注册函数再导出，方便 index.ts 与测试。 */
export { ROUTE_PREFIX, registerRoutes };
