/**
 * 阶段 A 的演示模块：把平台层的实测结果暴露在 GET health 上。
 *
 * 这一条路由就是 A2 里 V1/V8/V9 的证据来源，也是后续所有标签页拿环境信息的入口。
 */
import type { PlatformContext } from "./types.ts";
import type { HubModule, RouteHandler } from "../contract/host.ts";
import type { SdkLoadState } from "./sdk-loader.ts";
import type { YamlLoadState } from "./yaml-loader.ts";
import type { ModuleStatus } from "./modules.ts";

/** demo 模块需要的环境（由外壳注入，避免模块之间 import）。 */
export interface DemoDeps {
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

/** 组装 demo 模块。 */
export function createDemoModule(deps: DemoDeps): HubModule {
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
        ? { status: "loaded", ...(deps.yaml.version === undefined ? {} : { version: deps.yaml.version }) }
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
