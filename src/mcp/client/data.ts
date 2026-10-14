/**
 * MCP 标签页的接口封装：配置的各条路由 + 运行状态的 HTTP adapter（runtimeApi）。
 *
 * 只做三件事：调 api.get/api.post、把 data 里的字段取出来、给缺省值。
 * 错误一律原样抛出（都是 platform/client/api.ts 的 ApiError，message 是服务端给的中文），
 * 由调用方转成界面状态。
 */

import { api } from "../../platform/client/api.ts";
import type { ConfigPayload, ParseResult, RevealResult, ServerView, UpsertResult } from "../contract/config.ts";
import type { ReconnectResult, RuntimeStatus } from "../contract/runtime.ts";
import { normalizeRuntimeStatus, type RuntimeAdapter } from "./runtime-store.ts";
import type { ServersAdapter } from "./servers-store.ts";

/** GET mcp/config → { servers, warnings }。 */
export async function fetchConfig(): Promise<ConfigPayload> {
  const data = await api.get<Partial<ConfigPayload>>("mcp/config");
  return {
    servers: Array.isArray(data?.servers) ? data.servers : [],
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  };
}

/** 服务器列表的 HTTP adapter（给 servers-store.ts 用）。 */
export const serversApi: ServersAdapter = {
  load: fetchConfig,
  toggle: (name, disabled) => toggleServer(name, disabled),
  reorder: (names) => reorderServers(names),
  remove: (name) => deleteServer(name),
};

/** 运行状态的 HTTP adapter（给 runtime-store.ts 用）：GET mcp/runtime、POST mcp/runtime/reconnect。 */
export const runtimeApi: RuntimeAdapter = {
  async status() {
    return normalizeRuntimeStatus(await api.get<Partial<RuntimeStatus>>("mcp/runtime"));
  },
  async reconnect(name) {
    const data = await api.post<ReconnectResult>("mcp/runtime/reconnect", { name });
    return normalizeRuntimeStatus({ servers: [data.server] }).servers[0] ?? data.server;
  },
};

/** POST mcp/servers/upsert { originalName?, server } → { server, warnings }。 */
export async function upsertServer(
  originalName: string | undefined,
  server: Record<string, unknown>,
): Promise<UpsertResult> {
  const body: Record<string, unknown> = { server };
  if (originalName !== undefined) body.originalName = originalName;
  const data = await api.post<UpsertResult>("mcp/servers/upsert", body);
  return { server: data.server, warnings: Array.isArray(data.warnings) ? data.warnings : [] };
}

/** POST mcp/servers/delete { name }。 */
export async function deleteServer(name: string): Promise<void> {
  await api.post("mcp/servers/delete", { name });
}

/** POST mcp/servers/toggle { name, disabled } → { server }。 */
export async function toggleServer(name: string, disabled: boolean): Promise<ServerView> {
  const data = await api.post<{ server: ServerView }>("mcp/servers/toggle", { name, disabled });
  return data.server;
}

/** POST mcp/servers/reorder { names } → { servers }。 */
export async function reorderServers(names: readonly string[]): Promise<ServerView[]> {
  const data = await api.post<{ servers?: ServerView[] }>("mcp/servers/reorder", { names: [...names] });
  return Array.isArray(data?.servers) ? data.servers : [];
}

/** POST mcp/servers/reveal { name } → { server }（env / headers 是明文）。 */
export async function revealServer(name: string): Promise<ServerView> {
  const data = await api.post<RevealResult>("mcp/servers/reveal", { name });
  return data.server;
}

/** POST mcp/parse-json { text } → { servers, warnings }。 */
export async function parseJsonText(text: string): Promise<ParseResult> {
  const data = await api.post<Partial<ParseResult>>("mcp/parse-json", { text });
  return {
    servers: Array.isArray(data?.servers) ? data.servers : [],
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  };
}
