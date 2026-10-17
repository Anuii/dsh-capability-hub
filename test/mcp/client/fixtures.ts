/**
 * 客户端 MCP 页的测试夹具（纯数据，不碰 DOM / 网络）。
 *
 * 0.9.0 起没有运行状态的夹具（页面不读它）：连接状态只在宿主 GET health 的 mcpServers 里，
 * 由宿主侧的测试覆盖。
 */

import type { ConfigPayload, ServerView } from "../../../src/mcp/contract/config.ts";

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
