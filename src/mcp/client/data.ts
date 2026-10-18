/**
 * MCP 标签页的接口封装：配置的各条路由。
 *
 * 只做三件事：调 api.get/api.post、把 data 里的字段取出来、给缺省值。
 * 错误一律原样抛出（都是 platform/client/api.ts 的 ApiError，message 是服务端给的中文），
 * 由调用方转成界面状态。
 *
 * 0.9.0 起没有运行状态的接口（页面不显示连接状态、也不提供「重新连接」）：
 * 连接失败只记在宿主 GET health 的 mcpServers 与 boot.json 里。
 */

import { api } from "../../platform/client/api.ts";
import type { ConfigPayload, ParseResult, RevealResult, ServerView, UpsertResult } from "../contract/config.ts";
import type { RegistryDetail, RegistrySearchResult } from "../contract/registry.ts";
import type { ServersAdapter } from "./servers-store.ts";
import { t } from "./strings.ts";

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
  upsert: async (name, values) => (await upsertServer(name, values)).server,
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

/* ---------------- Official MCP Registry（0.9.0，只读） ---------------- */

/**
 * GET mcp/registry/search?q=&cursor= → { items, nextCursor }。
 *
 * registry 的 search 实测很慢（jira 约 14 秒、filesystem 超过 60 秒），宿主的请求超时是 45 秒，
 * 超时由宿主返回中文错误 —— 这里只把 data 取出来，界面负责「加载中」与重试。
 */
export async function searchRegistry(query: string, cursor?: string): Promise<RegistrySearchResult> {
  const data = await api.get<Partial<RegistrySearchResult>>("mcp/registry/search", { q: query, cursor });
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    ...(typeof data?.nextCursor === "string" && data.nextCursor !== "" ? { nextCursor: data.nextCursor } : {}),
  };
}

/** GET mcp/registry/detail?name= → { item, raw?, unsupported?, notes }。 */
export async function fetchRegistryDetail(name: string): Promise<RegistryDetail> {
  const data = await api.get<Partial<RegistryDetail>>("mcp/registry/detail", { name });
  const item = data?.item;
  if (item === undefined || item === null) throw new Error(t("mcp.registry.detailBroken"));
  return {
    item,
    ...(data.raw === undefined ? {} : { raw: data.raw }),
    ...(data.unsupported === undefined ? {} : { unsupported: data.unsupported }),
    notes: Array.isArray(data.notes) ? data.notes : [],
  };
}

/** POST mcp/parse-json { text } → { servers, warnings }。 */
export async function parseJsonText(text: string): Promise<ParseResult> {
  const data = await api.post<Partial<ParseResult>>("mcp/parse-json", { text });
  return {
    servers: Array.isArray(data?.servers) ? data.servers : [],
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  };
}
