/**
 * 调用一个直接注册的 MCP 工具（会按需起进程）。
 *
 * 冷却中直接拒绝（D-D7）；结果过输出护栏（D-D6）；成功后清空失败记录，并在缓存较旧时顺带刷新一次清单（D-C6）。
 * 失败一律抛错（DSH 把它记成失败的工具调用，PTC 模式下是 ToolCallError）：连不上 / 超时会进冷却，
 * 服务器自己返回的错误（isError）原文交给模型、不进冷却，取消不算失败。
 */

import { REFRESH_AFTER_MS } from "../constants.ts";
import { applyOutputGuard } from "../atoms/output-guard.ts";
import { renderCallToolResult } from "../atoms/result-text.ts";
import { isCancellation, seconds } from "../failures.ts";
import { errorText } from "../../../shared/error-text.ts";
import type { EffectiveServer } from "../../contract/config.ts";
import type { McpToolSpec } from "../../contract/runtime.ts";
import type { RuntimeCore, SessionRef } from "../core.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function callTool(
  core: RuntimeCore,
  spec: McpToolSpec,
  args: unknown,
  session: SessionRef,
  signal: AbortSignal,
): Promise<string> {
  const server = core.findServer(spec.server);
  if (server === undefined || server.disabled) {
    throw new Error('MCP 服务器 "' + spec.server + '" 已停用或已删除，' + spec.name + " 暂时不能用。");
  }
  const blocked = core.failures.blockedMessage(server.serverName, false);
  if (blocked !== undefined) throw new Error(blocked);

  let rendered: { text: string; isError: boolean };
  try {
    const instance = core.pool.acquire(session, server);
    await instance.ensureConnected(signal);
    const raw = await instance.callTool(spec.tool, isRecord(args) ? args : {}, {
      signal,
      timeoutMs: server.toolCallTimeoutMs,
    });
    rendered = renderCallToolResult(raw);
  } catch (err) {
    if (isCancellation(err)) throw new Error('调用 "' + spec.name + '" 已取消。');
    core.failures.record(server.serverName, errorText(err));
    const remaining = core.failures.remaining(server.serverName);
    throw new Error(
      '调用 "' +
        spec.name +
        '" 失败：' +
        errorText(err) +
        (remaining > 0 ? "\n已进入 " + seconds(remaining) + " 秒冷却，这期间不会再自动尝试这台服务器。" : ""),
    );
  }
  core.failures.clear(server.serverName);
  refreshAfterCall(core, server, session);
  const guarded = await applyOutputGuard(rendered.text, core.settings().outputGuard, core.spill);
  if (rendered.isError) throw new Error(guarded.text);
  return guarded.text;
}

/** 成功调用后：缓存较旧（超过 REFRESH_AFTER_MS）且不在冷却中时，用调用方的会话顺带刷新一次清单。 */
function refreshAfterCall(core: RuntimeCore, server: EffectiveServer, session: SessionRef): void {
  const entry = core.cache.get(server.serverName);
  if (entry && core.clock.now() - entry.updatedAt <= REFRESH_AFTER_MS) return;
  if (core.failures.remaining(server.serverName) > 0) return;
  core.probeInBackground(server, "refresh-after-call", "的调用后刷新失败", session);
}
