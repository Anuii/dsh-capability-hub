/**
 * 平台层公共类型（PLAN §3.1 契约）。
 *
 * 这些类型是 T1–T3b 各功能模块与平台层之间的唯一接口面；功能模块之间不得互相
 * import，只按本文件的结构类型对接。
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
  /** profile 目录绝对路径（拿不到时空串）。 */
  profileDir: string;
  /** 本插件宿主半的安装目录（用于定位随包资源）。 */
  packageRoot: string;
  logger: HubLogger;
  /**
   * 只读的额外技能根（DSH 的 customSkillDirs），拿不到时空数组。
   *
   * **阶段 B 起是活值**：实现为一个 getter，每次读都重新遍历组合树 ——
   * agent 预设里的 skill-filesystem 条目是按会话挂载的，启动时的快照看不到它们。
   * 调用方（skills-local 等）每次扫描时读一次即可，不要把它缓存成快照。
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

/** 路由处理器：返回的数据会被包进 { ok: true, data }。 */
export type RouteHandler = (req: RouteRequest) => Promise<unknown>;

/** 路由表：键 = "GET skills/list"。 */
export type RouteTable = Record<string, RouteHandler>;

/** 一个功能模块对外暴露的东西。 */
export interface HubModule {
  /** 路由键 "<METHOD> <相对路径>"（相对路径不含前缀）。 */
  routes: Record<string, RouteHandler>;
  /** 卸载钩子。 */
  dispose?(): void | Promise<void>;
}

/** 带 status/code/details 的错误；路由器据此映射 HTTP 状态与统一错误码。 */
export interface HubError extends Error {
  status?: number;
  code?: string;
  details?: unknown;
}
