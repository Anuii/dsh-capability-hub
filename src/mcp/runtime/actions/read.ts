/**
 * 只读的四个动作：status / search / describe / instructions（D-D2）。
 * 它们只读配置与工具元数据缓存，**绝不起进程**。
 */

import { SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from "../constants.ts";
import { isEntryStale, isEntryValid } from "../atoms/metadata-cache.ts";
import { matchesPattern, toolCandidates } from "../atoms/tool-name.ts";
import { rankDocuments, searchByRegex } from "../atoms/search-ranking.ts";
import { seconds } from "../failures.ts";
import {
  NO_SERVERS_HINT,
  coldHint,
  describeTime,
  renderToolLine,
  safeStringify,
  schemaSummary,
  sessionSuffix,
  stateText,
  unknownServerText,
} from "../text.ts";
import type { McpInstance } from "../atoms/connection.ts";
import type { RankDocument } from "../atoms/search-ranking.ts";
import type { DocEntry, RuntimeCore } from "../core.ts";

/** 不带动作参数时：给模型看的运行状态。 */
export function renderStatus(core: RuntimeCore): string {
  const servers = core.servers();
  if (servers.length === 0) return "MCP 运行状态\n" + NO_SERVERS_HINT;
  const lines: string[] = ["MCP 运行状态"];
  const enabled = core.enabledServers();
  lines.push(
    "已启用服务器（" +
      enabled.length +
      "）：" +
      (enabled.length > 0 ? enabled.map((server) => server.serverName).join("，") : "（无）"),
  );
  const now = core.clock.now();
  for (const server of servers) {
    const entry = core.cache.get(server.serverName);
    const flags: string[] = [];
    if (server.disabled) flags.push("已停用");
    flags.push(server.lifecycle);
    const window = core.windowFor(server.serverName);
    flags.push(window === 0 ? "会话内常驻" : "空闲 " + Math.round(window / 60_000) + " 分钟后回收");
    const cooling = core.failures.remaining(server.serverName);
    if (cooling > 0) flags.push("冷却中，剩余 " + seconds(cooling) + " 秒");
    let cacheText: string;
    if (!entry) {
      cacheText = "尚无缓存";
    } else {
      const invalid = !isEntryValid(entry, server, now);
      const stale = isEntryStale(entry, now);
      cacheText =
        entry.tools.length +
        " 个工具，" +
        describeTime(now, entry.updatedAt) +
        "更新" +
        (stale ? "（缓存已超过 7 天）" : "") +
        (invalid && !stale ? "（配置已变化，需要重新拉取）" : "");
    }
    lines.push("- " + server.serverName + "：" + cacheText + "［" + flags.join("，") + "］");
  }
  if (core.failures.size > 0) {
    lines.push("最近失败：");
    for (const [name, failure] of core.failures.entries()) {
      const remaining = core.failures.remaining(name);
      lines.push(
        "  - " + name + "：" + failure.message + (remaining > 0 ? "（冷却剩余 " + seconds(remaining) + " 秒）" : ""),
      );
    }
  }
  const instances = core.pool.list();
  if (instances.length === 0) {
    lines.push("当前没有活跃的服务器实例。");
  } else {
    lines.push("活跃会话实例：");
    const bySession = new Map<string, McpInstance[]>();
    for (const instance of instances) {
      const list = bySession.get(instance.sessionId) ?? [];
      list.push(instance);
      bySession.set(instance.sessionId, list);
    }
    for (const [sessionId, list] of bySession) {
      lines.push("  - 会话 " + sessionId + sessionSuffix(core, sessionId) + "：");
      for (const instance of list) {
        const pid = instance.pid !== undefined ? "，pid " + instance.pid : "";
        lines.push(
          "      " +
            instance.serverName +
            "（" +
            stateText(instance.state) +
            "，启动于 " +
            describeTime(now, instance.startedAt) +
            "，最后使用 " +
            describeTime(now, instance.lastUsedAt) +
            pid +
            "）",
        );
      }
    }
  }
  if (enabled.length > 0 && enabled.every((server) => !core.cache.get(server.serverName))) {
    lines.push(
      '提示：还没有任何服务器被缓存过。用 mcp({ connect: "<服务器名>" }) 拉一次工具清单，之后就能 search/describe 了。',
    );
  }
  return lines.join("\n");
}

/** mcp({ search })：按名称 / 描述 / 关键词排序检索，或 regex: true 时用正则。 */
export function handleSearch(core: RuntimeCore, args: Record<string, unknown>): string {
  const query = typeof args.search === "string" ? args.search : "";
  const useRegex = args.regex === true;
  const includeSchemas = args.includeSchemas !== false;
  const limitRaw = typeof args.limit === "number" ? Math.trunc(args.limit) : SEARCH_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : SEARCH_DEFAULT_LIMIT), SEARCH_MAX_LIMIT);
  const offsetRaw = typeof args.offset === "number" ? Math.trunc(args.offset) : 0;
  const offset = Math.max(0, Number.isFinite(offsetRaw) ? offsetRaw : 0);

  const entries = core.allDocuments();
  if (entries.length === 0) {
    const enabled = core.enabledServers();
    if (enabled.length === 0) return "没有可搜索的工具：" + NO_SERVERS_HINT;
    const coldServers = enabled
      .filter((server) => !core.cache.get(server.serverName))
      .map((server) => server.serverName);
    return (
      "还没有任何 MCP 工具元数据被缓存，暂时没得搜。\n" +
      (coldServers.length > 0
        ? '请先连接一个服务器（只拉清单、不调用工具），例如：mcp({ connect: "' + coldServers[0] + '" })\n'
        : "") +
      '连接成功后就可以用 mcp({ search: "关键词" }) 检索了。'
    );
  }
  const index = new Map(entries.map((entry) => [entry.doc.qualifiedName, entry]));
  const docs = entries.map((entry) => entry.doc);

  if (useRegex) {
    const result = searchByRegex(docs, query, 1000);
    if (!result.ok) return "无法执行这个正则搜索：" + result.error;
    if (result.matches.length === 0)
      return '没有匹配 "' + query + '" 的工具（正则模式，共检索 ' + entries.length + " 个工具）。";
    const page = result.matches.slice(offset, offset + limit);
    const lines = [
      '正则搜索 "' +
        query +
        '" 命中 ' +
        result.matches.length +
        " 个工具，显示第 " +
        (offset + 1) +
        "–" +
        (offset + page.length) +
        " 个：",
    ];
    for (const doc of page) {
      const entry = index.get(doc.qualifiedName);
      if (entry) lines.push(renderToolLine(entry, includeSchemas));
    }
    lines.push('调用方式：mcp({ tool: "<名字>", args: { … } })');
    return lines.join("\n");
  }

  const ranked = rankDocuments(docs, query);
  if (ranked.length === 0) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const near = escaped.length > 0 ? searchByRegex(docs, escaped, 5) : { ok: true, matches: [] as RankDocument[] };
    const hint =
      near.ok && near.matches.length > 0
        ? "\n你是不是想找：" + near.matches.map((doc) => doc.qualifiedName).join("、")
        : "";
    return '没有匹配 "' + query + '" 的工具（当前缓存里有 ' + entries.length + " 个工具）。" + hint + coldHint(core);
  }
  const page = ranked.slice(offset, offset + limit);
  const lines = ["找到 " + ranked.length + " 个工具，显示第 " + (offset + 1) + "–" + (offset + page.length) + " 个："];
  for (const match of page) {
    const entry = index.get(match.doc.qualifiedName);
    if (entry) lines.push(renderToolLine(entry, includeSchemas));
  }
  if (offset + page.length < ranked.length) {
    lines.push(
      "还有更多，用 mcp({ search: " + JSON.stringify(query) + ", offset: " + (offset + page.length) + " }) 继续。",
    );
  }
  lines.push('调用方式：mcp({ tool: "<名字>", args: { … } })；先用 mcp({ describe: "<名字>" }) 看参数。');
  return lines.join("\n");
}

/** 名字（原名 / 服务器__原名 / glob）能对上的工具。 */
export function matchingTools(entries: readonly DocEntry[], name: string, serverName?: string): DocEntry[] {
  return entries.filter(
    (entry) =>
      (serverName === undefined || entry.server.serverName === serverName) &&
      toolCandidates(entry.server.serverName, entry.tool.name).some((candidate) => matchesPattern(name, candidate)),
  );
}

/** mcp({ describe })：一个工具的完整说明与 inputSchema。 */
export function handleDescribe(core: RuntimeCore, args: Record<string, unknown>): string {
  const query = typeof args.describe === "string" ? args.describe : "";
  const serverFilter = typeof args.server === "string" ? args.server : undefined;
  const matches = matchingTools(core.allDocuments(), query, serverFilter);
  if (matches.length === 0) {
    const disabledMatches = matchingTools(core.disabledDocuments(), query);
    if (disabledMatches.length > 0) {
      return (
        '工具 "' +
        query +
        '" 属于已停用的服务器 "' +
        disabledMatches[0]!.server.serverName +
        '"。到「能力中心 → MCP 服务器」启用它之后再试。'
      );
    }
    const knownServer = core.findServer(query);
    if (knownServer) {
      return (
        '那是服务器名，不是工具名：mcp({ search: "' +
        query +
        '" }) 可以看到它有哪些工具。' +
        (knownServer.disabled ? "\n注意：该服务器当前已被停用。" : "")
      );
    }
    const prefix = query.toLowerCase().slice(0, Math.max(2, Math.min(4, query.length)));
    const suggestions = core
      .allDocuments()
      .filter((entry) => entry.doc.qualifiedName.toLowerCase().includes(prefix))
      .slice(0, 5)
      .map((entry) => entry.doc.qualifiedName);
    return (
      '没有名为 "' +
      query +
      '" 的工具。' +
      (suggestions.length > 0
        ? "你是不是想找：" + suggestions.join("、") + "？"
        : '可以先用 mcp({ search: "关键词" }) 检索。') +
      coldHint(core)
    );
  }
  const servers = [...new Set(matches.map((entry) => entry.server.serverName))];
  if (servers.length > 1) {
    return (
      '"' +
      query +
      '" 同时存在于多个服务器上：' +
      servers.join("、") +
      '。请用 mcp({ describe: "' +
      query +
      '", server: "<服务器名>" }) 指定一个。'
    );
  }
  const entry = matches[0]!;
  const lines = [
    "工具：" + entry.doc.qualifiedName,
    "服务器：" + entry.server.serverName,
    "描述：" + ((entry.tool.description ?? "").trim() || "（该工具没有提供描述）"),
  ];
  const summary = schemaSummary(entry.tool.inputSchema);
  // 标签与 search 的 renderToolLine、以及 F3-Q1 参考实现的 renderDescribe（Parameters:）保持一致，
  // 不写成中文「参数：」—— 同一个 schema 摘要在两个动作里必须是同一个字符串。
  if (summary) lines.push("parameters: " + summary);
  lines.push("完整 inputSchema：");
  lines.push(safeStringify(entry.tool.inputSchema));
  lines.push('调用方式：mcp({ tool: "' + entry.tool.name + '", args: { … } })');
  return lines.join("\n");
}

/** mcp({ instructions })：服务器自己发布的用法说明（来自缓存）。 */
export function handleInstructions(core: RuntimeCore, args: Record<string, unknown>): string {
  const name = typeof args.instructions === "string" ? args.instructions : "";
  const server = core.findServer(name);
  if (!server) return unknownServerText(core, name);
  if (server.disabled) return '服务器 "' + name + '" 已在配置里停用。';
  const entry = core.cache.get(name);
  if (!entry)
    return '服务器 "' + name + '" 还没有缓存。用 mcp({ connect: "' + name + '" }) 拉一次，然后再看它的用法说明。';
  if (!entry.instructions) return '服务器 "' + name + '" 没有发布用法说明。';
  return '服务器 "' + name + '" 的用法说明：\n\n' + entry.instructions;
}
