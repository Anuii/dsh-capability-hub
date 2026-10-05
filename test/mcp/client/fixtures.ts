/**
 * 客户端 MCP 页的测试夹具（纯数据，不碰 DOM / 网络）。
 */

import type { ConfigPayload, McpSettings, RuntimeStatus, ServerView } from "../../../src/mcp/client/types.ts";

export const defaultSettings: McpSettings = {
  idleTimeoutMin: 10,
  outputGuard: { enabled: true, maxBytes: 51200, maxLines: 2000 },
  failureBackoffMs: 60000,
};

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
    lifecycle: "lazy",
    idleTimeoutMin: 10,
    searchKeywords: {},
    disabled: false,
    debug: false,
    meta: {},
    setFields: ["serverName", "transport", "command"],
    defaults: {
      command: null,
      args: [],
      cwd: null,
      env: {},
      envFrom: {},
      allowEmpty: [],
      envFromTimeoutMs: 10000,
      url: null,
      headers: {},
      toolCallTimeoutMs: 60000,
      lifecycle: "lazy",
      idleTimeout: null,
      includeTools: null,
      excludeTools: null,
      searchKeywords: {},
      disabled: false,
      debug: false,
      meta: {},
    },
    ...overrides,
  };
}

export function makeConfig(servers: ServerView[], overrides: Partial<ConfigPayload> = {}): ConfigPayload {
  return { settings: defaultSettings, settingsSet: [], servers, warnings: [], ...overrides };
}

export function makeRuntime(names: string[]): RuntimeStatus {
  return { servers: names.map((name) => ({ name, disabled: false })), sessions: [] };
}
