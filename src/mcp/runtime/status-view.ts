/** GET mcp/runtime 的视图：每个服务器的缓存与最近失败、每个会话的实例（给能力中心界面用）。 */

import { isEntryStale, isEntryValid } from "./atoms/metadata-cache.ts";
import { clipToolDescription, type RuntimeCore } from "./core.ts";
import type { EffectiveServer } from "../contract/config.ts";
import type { RuntimeInstanceView, RuntimeServerView, RuntimeSessionView, RuntimeStatus } from "../contract/runtime.ts";
import type { CachedTool } from "./atoms/metadata-cache.ts";
import type { McpInstance } from "./atoms/connection.ts";

/**
 * 给 UI 的工具清单（FIX-9）：过滤后的名字 + 一行描述，按**名称码元序**（与 locale 无关，跨机器稳定）。
 * **不带 inputSchema** —— 面板每 5 秒轮询一次，把 schema 塞进去纯属浪费；要看完整参数用 mcp({ describe })。
 * 空描述用「不写这个键」表示，而不是空字符串。
 */
export function cacheToolsOf(core: RuntimeCore, server: EffectiveServer): { name: string; description?: string }[] {
  const view = (tool: CachedTool): { name: string; description?: string } => {
    const description = clipToolDescription(tool.description);
    return description.length > 0 ? { name: tool.name, description } : { name: tool.name };
  };
  return core
    .visibleTools(server)
    .map(view)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function serverView(core: RuntimeCore, server: EffectiveServer, now: number): RuntimeServerView {
  const entry = core.cache.get(server.serverName);
  const view: RuntimeServerView = { name: server.serverName, disabled: server.disabled };
  if (entry) {
    // FIX-9：toolCount 与 tools.length 同源 —— 口径是「过滤后可见数」，否则抽屉里列 2 个工具、标题写 4 个。
    const tools = cacheToolsOf(core, server);
    view.cache = {
      toolCount: tools.length,
      updatedAt: entry.updatedAt,
      stale: isEntryStale(entry, now) || !isEntryValid(entry, server, now),
      tools,
    };
  }
  const failure = core.failures.get(server.serverName);
  if (failure) {
    const cooldownUntil = core.failures.cooldownUntil(server.serverName);
    view.lastFailure = {
      message: failure.message,
      at: failure.at,
      ...(cooldownUntil === undefined ? {} : { cooldownUntil }),
    };
  }
  return view;
}

function instanceView(instance: McpInstance): RuntimeInstanceView {
  const item: RuntimeInstanceView = {
    server: instance.serverName,
    state: instance.state,
    startedAt: instance.startedAt,
    lastUsedAt: instance.lastUsedAt,
  };
  if (instance.pid !== undefined) item.pid = instance.pid;
  return item;
}

export async function runtimeStatusView(core: RuntimeCore): Promise<RuntimeStatus> {
  await core.ensureCacheLoaded();
  const now = core.clock.now();
  const servers = core.servers().map((server) => serverView(core, server, now));
  const bySession = new Map<string, McpInstance[]>();
  for (const instance of core.pool.list()) {
    const list = bySession.get(instance.sessionId) ?? [];
    list.push(instance);
    bySession.set(instance.sessionId, list);
  }
  const sessions = [...bySession.entries()].map(([sessionId, list]) => {
    const meta = core.sessionMeta.get(sessionId);
    const view: RuntimeSessionView = { sessionId, instances: list.map(instanceView) };
    if (meta?.parentSessionId !== undefined) view.parentSessionId = meta.parentSessionId;
    if (meta?.title !== undefined) view.title = meta.title;
    return view;
  });
  return { servers, sessions };
}
