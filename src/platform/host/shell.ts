/**
 * 永不失败外壳（D-F1）。
 *
 * 职责：
 *   1. 解析 HubContext；
 *   2. 加载 DSH 官方 MCP 插件与 yaml（失败只降级）；
 *   3. 按依赖顺序装载各功能模块（4 个真实模块 + health + 可选「故意失败」演示），
 *      每个模块独立 try/catch，失败只记账（见 modules.ts 的 createFeatureModuleEntries）；
 *   4. 接 agent 事件（按会话的 MCP 服务器挂到 agent.ctx 上），再让 MCP 运行时挂载全局服务器（ADR-0010）；
 *   5. 挂 HTTP 路由（前缀 /api/dsh-capability-hub/，继承 DSH browser-auth）；
 *   6. 写启动报告。
 *
 * 所有失败都只记账并暴露在 GET health；apply() 本身永不 throw。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PlatformContext } from "./types.ts";
import type { RouteTable } from "../contract/host.ts";
import { resolveHubContext, type PlatformConfig } from "./hub-context.ts";
import { makeLogger, safeGet } from "./host-ctx.ts";
import { skillSourceDiagnostics } from "./diagnostics.ts";
import { scanSkillRoots } from "./skill-roots.ts";
import { ROUTE_PREFIX, registerRoutes, type ConnectionFace } from "./router.ts";
import {
  ModuleRegistry,
  createFeatureModuleEntries,
  makeFeatureState,
  type FeatureState,
  type ModuleEntry,
  type ModuleStatus,
} from "./modules.ts";
import { loadMcpClient, type McpClientLoadState } from "./mcp-client-loader.ts";
import { loadYaml, type YamlLoadState } from "./yaml-loader.ts";
import { attachAgentHook } from "./agent-hook.ts";
import { createHealthModule, type McpServerHealth } from "./health.ts";
import { HUB_VERSION } from "../../version.ts";
import { createRejectingModule, createThrowingModule } from "./failure-demo.ts";
import type { PluginScope, RegisteredTool } from "../../mcp/contract/runtime.ts";
import type { McpRuntimeModule } from "../../mcp/runtime/module.ts";
import { errorText } from "../../shared/error-text.ts";

/** 接线摘要（health 里的 wiring 字段）。 */
export interface WiringSnapshot {
  /** skills-local ← skills-remote.lockStash 是否绑定成功。 */
  lockStashBound: boolean;
  /** 接线过程中的中文说明。 */
  notes: string[];
}

/** 外壳的运行时快照（health 与启动报告用）。 */
export interface ShellSnapshot {
  routes: string[];
  mcpClient: McpClientLoadState extends infer S ? (S extends { plugin: unknown } ? Omit<S, "plugin"> : S) : never;
  modules: ModuleStatus[];
  mcpServers: McpServerHealth[];
  /** 已注册的已鉴权路由路径。 */
  registeredPaths: string[];
  /** 路由注册失败原因（成功时 undefined）。 */
  registrationError?: string;
  wiring: WiringSnapshot;
}

/** 外壳句柄（测试用）。 */
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

const startedAt = new Date().toISOString();

/** 平台层关心的服务名（启动报告里逐项探测，便于定位「服务不可见」类问题）。 */
const SERVICE_PROBE = [
  "connection",
  "webServer",
  "tools",
  "loader",
  "profileContext",
  "credentials",
  "sessions",
  "attachments",
  "commands",
  "skills",
];

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
    logger.debug("ctx.connection 属性访问抛错：" + errorText(error));
  }
  return undefined;
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

/** 读插件根作用域里已注册的工具（DSH 的 ctx.tools.schemas()）；拿不到就是空数组。 */
function toolLister(hostCtx: unknown): () => RegisteredTool[] {
  return () => {
    const service = safeGet(hostCtx, "tools") as { schemas?: () => unknown } | undefined;
    if (service === undefined || typeof service.schemas !== "function") return [];
    const list = service.schemas();
    if (!Array.isArray(list)) return [];
    return list
      .filter((item): item is { name: string; description?: unknown } => typeof item?.name === "string")
      .map((item) =>
        typeof item.description === "string" ? { name: item.name, description: item.description } : { name: item.name },
      );
  };
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

  // ---- 1. DSH 官方 MCP 插件与 yaml 库（永不抛） ----
  const mcpClientState: McpClientLoadState = await loadMcpClient();
  if (mcpClientState.status === "loaded") logger.info(`DSH 官方 MCP 插件已加载：v${mcpClientState.version ?? "?"}`);
  else logger.warn(`${mcpClientState.message}（MCP 服务器不会挂载）`);
  const yamlState: YamlLoadState = await loadYaml();
  if (yamlState.status === "loaded") logger.info(`yaml 库已加载：v${yamlState.version ?? "?"}`);
  else logger.warn(`${yamlState.message}（技能模块将降级）`);
  const mcpClientView = (): ShellSnapshot["mcpClient"] =>
    mcpClientState.status === "loaded"
      ? { status: "loaded", ...(mcpClientState.version === undefined ? {} : { version: mcpClientState.version }) }
      : mcpClientState;

  // ---- 2. 模块表（4 个真实模块按依赖顺序；health 放最前，失败演示放最后） ----
  const state: FeatureState = makeFeatureState();
  const listTools = toolLister(hostCtx);
  const mcpServers = (): McpServerHealth[] =>
    (state.mcpRuntime?.runtime.status().servers ?? []).map((server) => ({
      name: server.name,
      scope: server.scope,
      state: server.state,
      toolCount: server.tools.length,
      sessions: server.sessions,
      ...(server.error === undefined ? {} : { error: server.error }),
    }));
  const wiringSnapshot = (): WiringSnapshot => ({ lockStashBound: state.lockStashBound, notes: [...state.notes] });

  const entries: ModuleEntry[] = [
    {
      name: "health",
      // health 要报 profileDir / packageRoot，用外壳自己的完整上下文。
      load: () =>
        createHealthModule({
          ctx,
          mcpClient: mcpClientState,
          yaml: yamlState,
          modules: () => registry.statuses(),
          mcpServers,
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
          wiring: wiringSnapshot,
        }),
    },
    ...createFeatureModuleEntries({
      ctx,
      mcpClient: mcpClientState,
      root: hostCtx as PluginScope,
      listTools,
      yaml: yamlState,
      state,
      ...(config.devOverrides?.failModules === undefined ? {} : { failModules: config.devOverrides.failModules }),
    }),
  ];
  if (config.devOverrides?.failureDemo === true) {
    entries.push({ name: "demo-failing-sync", load: () => createThrowingModule() });
    entries.push({ name: "demo-failing-async", load: () => createRejectingModule() });
  }
  await registry.loadAll(entries);

  // ---- 3. MCP：先接 agent 事件（按会话的服务器），再挂全局服务器（ADR-0010） ----
  const runtimeModule = registry.get<McpRuntimeModule>("mcp-runtime");
  let detachAgentHook: (() => void) | undefined;
  if (runtimeModule !== undefined) {
    const runtime = runtimeModule.runtime;
    detachAgentHook = attachAgentHook(hostCtx, runtime, logger);
    try {
      runtime.start();
    } catch (error) {
      state.notes.push("MCP 运行时启动失败：" + errorText(error));
      logger.warn("MCP 运行时启动失败（MCP 服务器不会挂载，其余功能不受影响）：" + errorText(error));
    }
    // 首轮挂载结束后重写一次启动报告，记下每台服务器连上没有
    void runtime.settle().then(() => writeBootReport());
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
      registrationError = errorText(error);
      logger.error(`注册 HTTP 路由失败（已降级，等待 connection 服务）：${registrationError}`);
    }
    void writeBootReport();
  };

  // ---- 6. 启动报告（落盘到 <hubHome>/boot.json，覆盖写）----
  // 为什么需要它：外壳的降级状态本来只暴露在 GET health 上，但「路由都没注册成功」时
  // health 根本不可达。落一份小 JSON 是唯一能自查启动结果的通道（DEV.md 有说明）。
  // 只记关键信息；技能目录推导的详细诊断只在开发开关（devOverrides.enabled）下写。
  const snapshotOf = (): ShellSnapshot => ({
    routes: Object.keys(routes).sort(),
    mcpClient: mcpClientView(),
    modules: registry.statuses(),
    mcpServers: mcpServers(),
    registeredPaths: registration?.paths ?? [],
    ...(registrationError === undefined ? {} : { registrationError }),
    wiring: wiringSnapshot(),
  });
  /** 启动报告的写入排队进行：路由注册与首轮挂载可能同时触发，不能让两次覆盖写交错。 */
  let bootWrite: Promise<void> = Promise.resolve();
  const writeBootReport = (): Promise<void> => {
    bootWrite = bootWrite.then(writeBootReportNow, writeBootReportNow);
    return bootWrite;
  };
  const writeBootReportNow = async (): Promise<void> => {
    try {
      const bootPath = join(ctx.hubHome, "boot.json");
      await mkdir(dirname(bootPath), { recursive: true });
      const detail =
        config.devOverrides?.enabled === true
          ? {
              services: probeServices(hostCtx),
              skillSources: skillSourceDiagnostics(hostCtx, scanSkillRoots(hostCtx)),
            }
          : {};
      await writeFile(
        bootPath,
        JSON.stringify(
          {
            plugin: "dsh-capability-hub",
            version: HUB_VERSION,
            profileName: ctx.profileName,
            pid: process.pid,
            startedAt,
            writtenAt: new Date().toISOString(),
            ...snapshotOf(),
            ...detail,
          },
          null,
          2,
        ),
        "utf8",
      );
      logger.debug(`启动报告已写入 ${bootPath}`);
    } catch (error) {
      logger.warn(`启动报告写入失败（不影响运行）：${errorText(error)}`);
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
        logger.error(`ctx.inject(["connection"]) 失败：${errorText(error)}`);
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
      // 顺序与装载相反：先摘路由（不再接受新请求），再摘 agent 事件，
      // 然后按模块装载的逆序 dispose（mcp-runtime 最先 → 卸下全部官方插件实例）。
      registration?.dispose();
      detachAgentHook?.();
      await registry.disposeAll();
    },
  };
}

/** 路由常量与注册函数再导出，方便 index.ts 与测试。 */
export { ROUTE_PREFIX, registerRoutes };
