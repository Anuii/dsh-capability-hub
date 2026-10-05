/**
 * 宿主外壳与四个宿主功能模块之间的契约（ADR-0002）：只有类型。
 *
 * 外壳（src/platform/host）解析出 HubContext、按 HubModule 收集路由；功能模块只认这里的形状，
 * 互相之间不 import（ADR-0001 规则 1）。
 */

/** 与 DSH ctx.logger 同形状的最小日志接口。 */
export interface HubLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 功能模块拿到的环境上下文。 */
export interface HubContext {
  /** 用户主目录；dev profile 下由插件配置 devOverrides.homeDir 指到夹具。 */
  homeDir: string;
  /** DSH 数据根，默认 <homeDir>/.dsh。 */
  dshHome: string;
  /** 本插件的数据根：<dshHome>/storages/dsh-capability-hub。 */
  hubHome: string;
  /** profile 名，如 desktop、capability-hub-dev。 */
  profileName: string;
  logger: HubLogger;
  /**
   * 只读的额外技能根（DSH 的 customSkillDirs），拿不到时空数组。
   * 是活值（getter）：agent 预设里的 skill-filesystem 条目按会话挂载，每次扫描时读一次，不要缓存成快照。
   */
  customSkillDirs: string[];
  /** 只读的内置技能目录，拿不到时 undefined。 */
  bundledSkillDir?: string;
}

/** 一次路由调用的输入。 */
export interface RouteRequest {
  /** URL 查询参数（同名取第一个）。 */
  query: Record<string, string>;
  /** 已解析的 JSON 请求体；无体时为 undefined。 */
  body: unknown;
  /** 客户端断开时 abort。 */
  signal: AbortSignal;
}

/** 路由处理器：返回的数据会被包进 { ok: true, data }；抛出 HubError 则映射成 { ok: false, error }。 */
export type RouteHandler = (req: RouteRequest) => Promise<unknown>;

/** 路由表：键 = "<METHOD> <相对路径>"，例如 "GET skills/list"（不含 /api/dsh-capability-hub/ 前缀）。 */
export type RouteTable = Record<string, RouteHandler>;

/** 一个功能模块对外暴露的东西。 */
export interface HubModule {
  routes: RouteTable;
  /** 卸载钩子。 */
  dispose?(): void | Promise<void>;
}

/** 路由处理器抛出的错误：外壳据 status 映射 HTTP 状态，code 与 message（中文）进错误信封。 */
export interface HubError extends Error {
  status: number;
  code: string;
  details?: unknown;
}
