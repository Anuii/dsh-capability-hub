/**
 * 宿主 mcp-runtime 契约的**客户端镜像**（PLAN §3.7「MCP·运行态」）。
 *
 * 为什么不 import 宿主类型：宿主半与浏览器半是两份产物，客户端不该把 Node 侧模块拉进 bundle。
 * 这里按响应逐字段复制，源头是 src/host/mcp-runtime/contract.ts 与 runtime.ts 的
 * status() / refresh() / disconnect()（2026-10-04 核对）；改契约时两处一起改。
 */

/** 工具缓存（GET mcp/runtime 的 servers[].cache）。 */
export interface RuntimeCacheView {
  toolCount: number;
  updatedAt: number;
  /** 缓存过期或与当前配置不匹配。 */
  stale: boolean;
}

/**
 * 最近一次失败。cooldownUntil **只在冷却未结束时出现**
 * （runtime.ts:982 `remaining > 0 ? {...} : {}`），字段缺失即可判定「冷却已结束」。
 */
export interface RuntimeFailureView {
  message: string;
  at: number;
  cooldownUntil?: number;
}

export interface RuntimeServerView {
  name: string;
  disabled: boolean;
  cache?: RuntimeCacheView;
  lastFailure?: RuntimeFailureView;
}

/** 连接池里的一个实例（状态取值见 atoms/connection.ts：ready / connecting / failed / closing / closed）。 */
export interface RuntimeInstanceView {
  server: string;
  state: string;
  startedAt: number;
  lastUsedAt: number;
  pid?: number;
}

export interface RuntimeSessionView {
  sessionId: string;
  parentSessionId?: string;
  title?: string;
  instances: RuntimeInstanceView[];
}

export interface RuntimeStatus {
  servers: RuntimeServerView[];
  sessions: RuntimeSessionView[];
}

/** POST mcp/runtime/refresh 的 data。 */
export interface RuntimeRefreshResult {
  toolCount: number;
}

/** POST mcp/runtime/disconnect 的 data。 */
export interface RuntimeDisconnectResult {
  closed: number;
}
