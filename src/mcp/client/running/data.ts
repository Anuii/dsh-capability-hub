/**
 * 运行态标签的接口封装（三条路由，PLAN §3.7「MCP·运行态」）。
 *
 * 只做三件事：调 api.get / api.post、给缺省值、把缺字段补成安全形状。
 * 错误一律原样抛出（都是 shell/api.ts 的 ApiError，message 是服务端给的中文），
 * 由调用方转成界面状态。
 */

import { api } from "../../../platform/client/api.ts";
import type { RuntimeDisconnectResult, RuntimeRefreshResult, RuntimeStatus } from "./types.ts";

/** GET mcp/runtime → { servers, sessions }。 */
export async function fetchRuntimeStatus(): Promise<RuntimeStatus> {
  const data = await api.get<Partial<RuntimeStatus>>("mcp/runtime");
  return {
    servers: Array.isArray(data?.servers) ? data.servers : [],
    sessions: Array.isArray(data?.sessions)
      ? data.sessions.map((session) => ({
          ...session,
          instances: Array.isArray(session?.instances) ? session.instances : [],
        }))
      : [],
  };
}

/** POST mcp/runtime/refresh { name } → { toolCount }。 */
export async function refreshServer(name: string): Promise<RuntimeRefreshResult> {
  const data = await api.post<Partial<RuntimeRefreshResult>>("mcp/runtime/refresh", { name });
  return { toolCount: typeof data?.toolCount === "number" ? data.toolCount : 0 };
}

/** POST mcp/runtime/disconnect { name, sessionId? } → { closed }（省略 sessionId = 全部会话）。 */
export async function disconnectServer(name: string, sessionId?: string): Promise<RuntimeDisconnectResult> {
  const body: Record<string, unknown> = { name };
  if (typeof sessionId === "string" && sessionId !== "") body.sessionId = sessionId;
  const data = await api.post<Partial<RuntimeDisconnectResult>>("mcp/runtime/disconnect", body);
  return { closed: typeof data?.closed === "number" ? data.closed : 0 };
}
