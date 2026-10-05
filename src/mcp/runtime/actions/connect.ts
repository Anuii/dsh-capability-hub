/** mcp({ connect })：在调用方的会话里连上一台服务器并刷新它的工具清单（会起进程）。 */

import { isCancellation, seconds } from "../failures.ts";
import { unknownServerText } from "../text.ts";
import type { RuntimeCore, SessionRef } from "../core.ts";
import { errorText } from "../../../shared/error-text.ts";

export async function handleConnect(
  core: RuntimeCore,
  args: Record<string, unknown>,
  session: SessionRef,
  signal: AbortSignal,
): Promise<string> {
  const name = typeof args.connect === "string" ? args.connect : "";
  const force = args.force === true;
  const server = core.findServer(name);
  if (!server) return unknownServerText(core, name);
  if (server.disabled) return '服务器 "' + name + '" 已在配置里停用，无法连接。';
  const blocked = core.failures.blockedMessage(name, force);
  if (blocked) return blocked;
  if (signal.aborted) return '连接服务器 "' + name + '" 的操作已被取消。';
  try {
    // 用调用方自己的会话实例探测：会话隔离下不该为「连接」再起一个进程给别的会话用。
    // 注意：如果此刻恰好有一个「探测会话」的同服务器探测在跑（例如启动探测），probe 会
    // 去重并复用那一个 —— 于是调用方的会话仍然是空的。所以这里再确保一次调用方会话连通，
    // 使 connect 的语义「这个会话现在有了一个连着的实例」在任何情况下都成立。
    const entry = await core.probe(server, force ? "manual" : "lazy", session);
    const instance = core.pool.get(session.sessionId, server.serverName);
    if (!instance || !instance.isAlive) {
      await core.pool.acquire(session, server).ensureConnected();
    }
    return (
      '已连接服务器 "' +
      name +
      '" 并刷新了它的工具清单：' +
      entry.tools.length +
      " 个工具" +
      (entry.instructions ? '，另有用法说明（mcp({ instructions: "' + name + '" }) 可看）' : "") +
      "。\n" +
      '现在可以 mcp({ search: "关键词" }) 检索它的工具了。'
    );
  } catch (err) {
    if (isCancellation(err)) return '连接服务器 "' + name + '" 的操作已被取消。';
    const remaining = core.failures.remaining(name);
    return (
      '连接服务器 "' +
      name +
      '" 失败：' +
      errorText(err) +
      "\n" +
      (remaining > 0 ? "已进入 " + seconds(remaining) + " 秒冷却，期间不会自动重试。" : "") +
      '检查配置（command / args / env / cwd）后可以再用 mcp({ connect: "' +
      name +
      '", force: true }) 强制重试。'
    );
  }
}
