/**
 * 健康检查模块：GET health 把外壳的实测状态（各模块是否降级、官方 MCP 插件与 yaml 是否加载、
 * 各 MCP 服务器挂载情况、路由注册）一次给出来。界面的降级横幅、版本不一致提示、ⓘ 诊断都读它。
 */
import type { PlatformContext } from "./types.ts";
import type { HubModule, RouteHandler } from "../contract/host.ts";
import type { McpClientLoadState } from "./mcp-client-loader.ts";
import type { YamlLoadState } from "./yaml-loader.ts";
import type { ModuleStatus } from "./modules.ts";

/** health 里每台 MCP 服务器的摘要。 */
export interface McpServerHealth {
  name: string;
  scope: string;
  state: string;
  toolCount: number;
  sessions: number;
  error?: string;
}

/** 健康检查需要的环境（由外壳注入，避免模块之间 import）。 */
export interface HealthDeps {
  ctx: PlatformContext;
  /** DSH 官方 MCP 插件（ADR-0010）。 */
  mcpClient: McpClientLoadState;
  /** DSH 自带的 yaml 库（技能模块解析 frontmatter 用）。 */
  yaml: YamlLoadState;
  /** 模块状态快照（含降级）。 */
  modules(): ModuleStatus[];
  /** MCP 服务器的挂载摘要（mcp-runtime 不可用时为空数组）。 */
  mcpServers(): McpServerHealth[];
  /** 宿主标题（DSH 版本等）。 */
  host(): { dshVersion?: string; pid: number; nodeVersion: string; startedAt: string };
  /** 已鉴权路由的注册结果。 */
  registration(): { registered: string[]; error?: string };
  /** 接线摘要。 */
  wiring(): { lockStashBound: boolean; notes: string[] };
}

export function createHealthModule(deps: HealthDeps): HubModule {
  const health: RouteHandler = async () => ({
    ok: true,
    plugin: "dsh-capability-hub",
    profileName: deps.ctx.profileName,
    homeDir: deps.ctx.homeDir,
    dshHome: deps.ctx.dshHome,
    hubHome: deps.ctx.hubHome,
    profileDir: deps.ctx.profileDir,
    packageRoot: deps.ctx.packageRoot,
    customSkillDirs: deps.ctx.customSkillDirs,
    bundledSkillDir: deps.ctx.bundledSkillDir ?? null,
    mcpClient:
      deps.mcpClient.status === "loaded"
        ? { status: "loaded", ...(deps.mcpClient.version === undefined ? {} : { version: deps.mcpClient.version }) }
        : { status: "failed", message: deps.mcpClient.message },
    yaml:
      deps.yaml.status === "loaded"
        ? {
            status: "loaded",
            source: deps.yaml.source,
            ...(deps.yaml.version === undefined ? {} : { version: deps.yaml.version }),
          }
        : { status: "failed", message: deps.yaml.message },
    modules: deps.modules().map((entry) => ({
      name: entry.name,
      status: entry.status,
      routes: entry.routes,
      ...(entry.message === undefined ? {} : { message: entry.message }),
      ...(entry.loadMs === undefined ? {} : { loadMs: entry.loadMs }),
    })),
    mcpServers: deps.mcpServers(),
    registration: deps.registration(),
    wiring: deps.wiring(),
    host: deps.host(),
    serverTime: new Date().toISOString(),
  });
  return { routes: { "GET health": health } };
}
