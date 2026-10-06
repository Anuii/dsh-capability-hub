/**
 * 健康检查模块：GET health 把外壳的实测状态（各模块是否降级、SDK 与 yaml 是否加载、mcp 工具是否注册、
 * 路由与会话桥）一次给出来。界面的降级横幅、版本不一致提示、ⓘ 诊断都读它。
 */
import type { PlatformContext } from "./types.ts";
import type { HubModule, RouteHandler } from "../contract/host.ts";
import type { SdkLoadState } from "./sdk-loader.ts";
import type { YamlLoadState } from "./yaml-loader.ts";
import type { ModuleStatus } from "./modules.ts";

/** 健康检查需要的环境（由外壳注入，避免模块之间 import）。 */
export interface HealthDeps {
  ctx: PlatformContext;
  sdk: SdkLoadState;
  /** DSH 自带的 yaml 库（技能模块解析 frontmatter 用）。 */
  yaml: YamlLoadState;
  /** 模块状态快照（含降级）。 */
  modules(): ModuleStatus[];
  /** 会话桥事件快照（V5）。 */
  sessionEvents(): unknown[];
  /** mcp 工具注册状态（V4）。 */
  tool(): { registered: boolean; name: string; description: string; error?: string };
  /** 宿主标题（DSH 版本等）。 */
  host(): { dshVersion?: string; pid: number; nodeVersion: string; startedAt: string };
  /** 已鉴权路由的注册结果（V3）。 */
  registration(): { registered: string[]; error?: string };
  /** 阶段 B 的接线摘要（4 个真实模块的装载与降级情况）。 */
  wiring(): {
    runtimeSource: "real" | "stub";
    runtimeReason?: string;
    lockStashBound: boolean;
    runtimeStarted: boolean;
    runtimeStartError?: string;
    notes: string[];
  };
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
    sdk:
      deps.sdk.status === "loaded"
        ? { status: "loaded", ...deps.sdk.info }
        : { status: "failed", message: deps.sdk.message },
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
    tool: deps.tool(),
    registration: deps.registration(),
    wiring: deps.wiring(),
    host: deps.host(),
    sessionEvents: deps.sessionEvents().slice(-20),
    serverTime: new Date().toISOString(),
  });
  return { routes: { "GET health": health } };
}
