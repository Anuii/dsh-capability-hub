/**
 * 客户端 MCP 页的测试夹具（纯数据，不碰 DOM / 网络）。
 */

import type { ConfigPayload, ServerView } from "../../../src/mcp/contract/config.ts";
import type { RuntimeServerView, RuntimeStatus } from "../../../src/mcp/contract/runtime.ts";

/** 造一个 ServerView（默认是「什么都没设置」的 stdio 服务器）。 */
export function makeServerView(overrides: Partial<ServerView> = {}): ServerView {
  return {
    serverName: "demo",
    transport: "stdio",
    command: "node",
    args: [],
    env: {},
    envFrom: {},
    allowEmpty: [],
    envFromTimeoutMs: 10000,
    headers: {},
    toolCallTimeoutMs: 60000,
    scope: "global",
    disabled: false,
    meta: {},
    setFields: ["serverName", "transport", "command"],
    ...overrides,
  };
}

export function makeConfig(servers: ServerView[], overrides: Partial<ConfigPayload> = {}): ConfigPayload {
  return { servers, warnings: [], ...overrides };
}

/** 一行运行状态（默认：全局、已连接、两个工具）。 */
export function makeRow(overrides: Partial<RuntimeServerView> & { name: string }): RuntimeServerView {
  return {
    scope: "global",
    state: "connected",
    tools: [{ name: "mcp__" + overrides.name + "__echo" }, { name: "mcp__" + overrides.name + "__ping" }],
    sessions: 0,
    ...overrides,
  };
}

export function makeRuntime(rows: RuntimeServerView[]): RuntimeStatus {
  return { servers: rows };
}
