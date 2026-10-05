/**
 * MCP 标签页的接口封装（PLAN §3.7 的「MCP·配置」与「MCP·运行态」）。
 *
 * 只做三件事：调 api.get/api.post、把 data 里的字段取出来、给缺省值。
 * 错误一律原样抛出（都是 shell/api.ts 的 ApiError，message 是服务端给的中文），
 * 由调用方转成界面状态。
 */

import { api } from "../../platform/client/api.ts";
import type { CommandCheckResult, ConfigPayload, ImportApplyResponse, ImportSourceView, ImportSourcesPayload, PresetView, McpSettings, ParseResult, PresetsPayload, RevealResult, ServerView, UpsertResult, ValidateResult } from "../contract/config.ts";
import type { RuntimeStatus } from "../contract/runtime.ts";

/** GET mcp/config → { settings, settingsSet, servers, warnings }。 */
export async function fetchConfig(): Promise<ConfigPayload> {
  const data = await api.get<Partial<ConfigPayload>>("mcp/config");
  return {
    settings: data?.settings as McpSettings,
    settingsSet: Array.isArray(data?.settingsSet) ? data.settingsSet : [],
    servers: Array.isArray(data?.servers) ? data.servers : [],
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  };
}

/** GET mcp/runtime → { servers, sessions }（本标签读 servers 与实例计数）。 */
export async function fetchRuntime(): Promise<RuntimeStatus> {
  const data = await api.get<Partial<RuntimeStatus>>("mcp/runtime");
  return {
    servers: Array.isArray(data?.servers) ? data.servers : [],
    sessions: Array.isArray(data?.sessions)
      ? data.sessions.map((session) => ({
          ...session,
          sessionId: typeof session?.sessionId === "string" ? session.sessionId : "",
          instances: Array.isArray(session?.instances)
            ? session.instances.filter((instance) => instance !== null && typeof instance === "object" && typeof instance.server === "string")
            : [],
        }))
      : [],
  };
}

/** POST mcp/runtime/refresh { name } → { toolCount }（抽屉「工具」小节的刷新）。 */
export async function refreshServerCache(name: string): Promise<{ toolCount: number }> {
  const data = await api.post<{ toolCount?: number }>("mcp/runtime/refresh", { name });
  return { toolCount: typeof data?.toolCount === "number" ? data.toolCount : 0 };
}

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

/** POST mcp/validate { server, originalName? } → { errors }。 */
export async function validateServer(
  server: Record<string, unknown>,
  originalName?: string,
): Promise<ValidateResult> {
  const body: Record<string, unknown> = { server };
  if (originalName !== undefined) body.originalName = originalName;
  const data = await api.post<ValidateResult>("mcp/validate", body);
  return { errors: Array.isArray(data?.errors) ? data.errors : [], server: data?.server };
}

/** POST mcp/settings/update { settings } → { settings, settingsSet }。 */
export async function updateSettings(
  settings: Record<string, unknown>,
): Promise<{ settings: McpSettings; settingsSet: string[] }> {
  const data = await api.post<{ settings: McpSettings; settingsSet?: string[] }>("mcp/settings/update", { settings });
  return { settings: data.settings, settingsSet: Array.isArray(data.settingsSet) ? data.settingsSet : [] };
}

/** POST mcp/check-command { command, cwd? } → { found, resolvedPath? }。 */
export async function checkCommand(command: string, cwd?: string): Promise<CommandCheckResult> {
  const body: Record<string, unknown> = { command };
  if (typeof cwd === "string" && cwd.trim() !== "") body.cwd = cwd;
  const data = await api.post<CommandCheckResult>("mcp/check-command", body);
  return { found: data?.found === true, resolvedPath: data?.resolvedPath };
}

/* ------------------------------------------------------------------ *
 * T4b-2：三种添加方式（D-C2）
 * ------------------------------------------------------------------ */

/** POST mcp/parse-json { text } → { servers, warnings }。 */
export async function parseJsonText(text: string): Promise<ParseResult> {
  const data = await api.post<Partial<ParseResult>>("mcp/parse-json", { text });
  return {
    servers: Array.isArray(data?.servers) ? data.servers : [],
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  };
}

/** GET mcp/presets → { presets }。 */
export async function fetchPresets(): Promise<PresetView[]> {
  const data = await api.get<Partial<PresetsPayload>>("mcp/presets");
  return Array.isArray(data?.presets) ? data.presets : [];
}

/** GET mcp/import/sources → { sources }（两个来源都会返回，found=false 表示没找到文件）。 */
export async function fetchImportSources(): Promise<ImportSourceView[]> {
  const data = await api.get<Partial<ImportSourcesPayload>>("mcp/import/sources");
  return Array.isArray(data?.sources) ? data.sources : [];
}

/** POST mcp/import/apply { sourceId, names } → { imported, skipped, servers, warnings }。 */
export async function applyImport(sourceId: string, names: readonly string[]): Promise<ImportApplyResponse> {
  const data = await api.post<Partial<ImportApplyResponse>>("mcp/import/apply", { sourceId, names: [...names] });
  return {
    imported: Array.isArray(data?.imported) ? data.imported : [],
    skipped: Array.isArray(data?.skipped) ? data.skipped : [],
    servers: Array.isArray(data?.servers) ? data.servers : [],
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  };
}
