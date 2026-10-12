/**
 * 要注册给模型的 MCP 工具（D-D1）与系统提示词里的「MCP 服务器」一段。
 *
 * 工具来自工具缓存（探测时写入，D-C6）：只取已启用的服务器、按 includeTools / excludeTools 过滤；
 * 顺序固定（服务器按配置顺序、工具按名字），内容不变时逐字节相同——注册集合稳定，提示词前缀缓存才不失效。
 */

import { toDshInputSchema } from "./atoms/schema-subset.ts";
import { publicToolName } from "./atoms/tool-name.ts";
import { clipToolDescription } from "./constants.ts";
import type { CachedTool } from "./atoms/metadata-cache.ts";
import type { EffectiveServer } from "../contract/config.ts";
import type { McpToolSpec } from "../contract/runtime.ts";
import type { RuntimeCore } from "./core.ts";

const byName = (a: CachedTool, b: CachedTool): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** 服务器说明的一行摘要（meta.description 的第一行，最多 160 字）。 */
function serverSummary(server: EffectiveServer): string {
  const raw = server.meta?.description;
  return typeof raw === "string" ? clipToolDescription(raw) : "";
}

/** 工具描述：服务器给的原文；没写时说明它属于哪个服务器（模型至少知道去哪类场景用它）。 */
function describeTool(server: EffectiveServer, tool: CachedTool): string {
  const own = (tool.description ?? "").trim();
  if (own !== "") return own;
  const summary = serverSummary(server);
  return (
    "MCP 服务器「" + server.serverName + "」的工具 " + tool.name + (summary === "" ? "。" : "（" + summary + "）。")
  );
}

export function buildToolSpecs(core: RuntimeCore): McpToolSpec[] {
  const out: McpToolSpec[] = [];
  const seen = new Set<string>();
  for (const server of core.enabledServers()) {
    for (const tool of [...core.visibleTools(server)].sort(byName)) {
      const name = publicToolName(server.serverName, tool.name);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        server: server.serverName,
        tool: tool.name,
        description: describeTool(server, tool),
        parameters: toDshInputSchema(tool.inputSchema),
      });
    }
  }
  return out;
}

/**
 * 系统提示词里的一段：哪些服务器的工具可用、各自做什么，再附上服务器自带的用法说明（MCP instructions，原文）。
 * 只列至少有一个工具的服务器；一个都没有时返回空串（DSH 会丢掉空段落）。
 */
export function buildPromptText(core: RuntimeCore, specs: readonly McpToolSpec[]): string {
  const withTools = new Set(specs.map((spec) => spec.server));
  const servers = core.enabledServers().filter((server) => withTools.has(server.serverName));
  if (servers.length === 0) return "";
  const lines = [
    "## MCP 服务器（能力中心）",
    "下面这些 MCP 服务器的工具已经直接注册，名字形如 mcp__<服务器>__<工具>。服务器进程按需启动，第一次调用可能要等几秒。",
  ];
  for (const server of servers) {
    const summary = serverSummary(server);
    lines.push("- " + server.serverName + (summary === "" ? "" : "：" + summary));
  }
  for (const server of servers) {
    const instructions = core.cache.get(server.serverName)?.instructions?.trim();
    if (instructions === undefined || instructions === "") continue;
    lines.push("", "### " + server.serverName + " 的用法说明（服务器自带）", instructions);
  }
  return lines.join("\n");
}
