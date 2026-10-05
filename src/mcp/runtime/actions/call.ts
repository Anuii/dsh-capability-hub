/**
 * mcp({ tool, args })：在调用方的会话里调用一个 MCP 工具（会起进程）。
 *
 * 找不到工具时按需探测一次再找；冷却中直接返回说明（D-D7）；结果过输出护栏（D-D6）；
 * 成功后清空失败记录，并在缓存较旧时顺带刷新一次清单（D-C6）。
 */

import { REFRESH_AFTER_MS } from "../constants.ts";
import { applyOutputGuard } from "../atoms/output-guard.ts";
import { renderCallToolResult } from "../atoms/result-text.ts";
import { qualify } from "../atoms/tool-name.ts";

import { isCancellation, seconds } from "../failures.ts";
import { matchingTools } from "./read.ts";
import type { EffectiveServer } from "../../contract/config.ts";
import type { DocEntry, RuntimeCore, SessionRef } from "../core.ts";
import { errorText } from "../../../shared/error-text.ts";

interface Resolution {
  matches: DocEntry[];
  /** 名字对得上、但属于已停用服务器的工具 */
  disabled: DocEntry[];
}

function resolveTool(core: RuntimeCore, name: string, serverName: string | undefined): Resolution {
  return {
    matches: matchingTools(core.allDocuments(), name, serverName),
    disabled: matchingTools(core.disabledDocuments(), name, serverName),
  };
}

export async function handleCall(
  core: RuntimeCore,
  args: Record<string, unknown>,
  session: SessionRef,
  signal: AbortSignal,
): Promise<string> {
  const name = typeof args.tool === "string" ? args.tool : "";
  const serverName = typeof args.server === "string" ? args.server : undefined;
  const toolArgs = (args.args ?? {}) as Record<string, unknown>;
  if (name.length === 0) return 'mcp({ tool }) 需要一个工具名。可以先用 mcp({ search: "关键词" }) 找。';

  let resolution = resolveTool(core, name, serverName);
  const attempts: string[] = [];
  if (resolution.matches.length === 0) {
    // 可能缓存还没建，或工具所在的服务器刚被配置进来 ⇒ 按需要连一次再解析。
    const targets =
      serverName !== undefined
        ? core.enabledServers().filter((server) => server.serverName === serverName)
        : core
            .enabledServers()
            .filter((server) => !resolution.disabled.some((entry) => entry.server.serverName === server.serverName));
    for (const server of targets) {
      try {
        const entry = await core.ensureMetadata(server, session);
        attempts.push(server.serverName + "：已缓存 " + entry.tools.length + " 个工具");
      } catch (err) {
        attempts.push(server.serverName + "：" + errorText(err));
      }
    }
    resolution = resolveTool(core, name, serverName);
  }

  if (resolution.matches.length === 0) {
    if (resolution.disabled.length > 0) {
      return (
        '工具 "' +
        name +
        '" 属于已停用的服务器 "' +
        resolution.disabled[0]!.server.serverName +
        '"。' +
        "到「能力中心 → MCP 服务器」启用它之后再试。"
      );
    }
    return (
      '找不到名为 "' +
      name +
      '" 的 MCP 工具（当前缓存里共 ' +
      core.allDocuments().length +
      " 个工具）。\n" +
      (attempts.length > 0 ? "尝试启动服务器：\n  - " + attempts.join("\n  - ") + "\n" : "") +
      '可以先用 mcp({ search: "关键词" }) 找工具名，或 mcp({ connect: "<服务器名>" }) 刷新缓存。'
    );
  }

  const servers = [...new Set(resolution.matches.map((entry) => entry.server.serverName))];
  if (servers.length > 1) {
    return (
      '"' +
      name +
      '" 同时存在于多个服务器上：' +
      servers.join("、") +
      '。请用 mcp({ tool: "' +
      name +
      '", server: "<服务器名>" }) 指定一个。'
    );
  }

  const target = resolution.matches[0]!;
  const server = target.server;
  const toolName = target.tool.name;

  const blocked = core.failures.blockedMessage(server.serverName, false);
  if (blocked) return blocked;

  try {
    const instance = core.pool.acquire(session, server);
    if (!instance.isAlive) {
      try {
        await core.ensureMetadata(server, session);
      } catch (err) {
        // 拉不到元数据不必然代表不能调用（也可能是刚写缓存失败）；交给 ensureConnected 决定。
        core.logger.debug("MCP 服务器 " + server.serverName + " 元数据刷新失败：" + errorText(err));
      }
    }
    const blockedAfterProbe = core.failures.blockedMessage(server.serverName, false);
    if (blockedAfterProbe) return blockedAfterProbe;
    await instance.ensureConnected(signal);
    const raw = await instance.callTool(toolName, toolArgs, {
      ...(signal ? { signal } : {}),
      timeoutMs: server.toolCallTimeoutMs,
    });
    const rendered = renderCallToolResult(raw);
    core.failures.clear(server.serverName);
    const header = rendered.isError
      ? "[服务器返回错误] " +
        qualify(server.serverName, toolName) +
        " —— 以下是服务器自己返回的内容，本机网关没有改动它：\n"
      : "";
    const guarded = await applyOutputGuard(rendered.text, core.settings().outputGuard, core.spill);
    refreshAfterCall(core, server, session);
    return header + guarded.text;
  } catch (err) {
    if (isCancellation(err)) return '调用 "' + qualify(server.serverName, toolName) + '" 的操作已被取消。';
    core.failures.record(server.serverName, errorText(err));
    const remaining = core.failures.remaining(server.serverName);
    return (
      '调用 "' +
      qualify(server.serverName, toolName) +
      '" 失败：' +
      errorText(err) +
      "\n" +
      (remaining > 0
        ? "已进入 " +
          seconds(remaining) +
          ' 秒冷却，这期间不会再自动尝试这台服务器。用 mcp({ connect: "' +
          server.serverName +
          '", force: true }) 可强制重试。'
        : "")
    );
  }
}

/** 成功调用后：缓存较旧（超过 REFRESH_AFTER_MS）且不在冷却中时，用调用方的会话顺带刷新一次清单。 */
function refreshAfterCall(core: RuntimeCore, server: EffectiveServer, session: SessionRef): void {
  const entry = core.cache.get(server.serverName);
  if (entry && core.clock.now() - entry.updatedAt <= REFRESH_AFTER_MS) return;
  if (core.failures.remaining(server.serverName) > 0) return;
  core.probeInBackground(server, "refresh-after-call", "的调用后刷新失败", session);
}
