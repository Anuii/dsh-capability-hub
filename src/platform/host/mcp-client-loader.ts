/**
 * 加载 DSH 官方 MCP 插件 @deepseek-ai/dsh-mcp-client（ADR-0010）。
 *
 * 本插件把配置里的服务器挂载成它的插件实例（hostCtx.plugin(McpClient, McpClient.Config(...))）。
 * DSH 的模块解析能从插件里找到 @deepseek-ai/* 包（yaml-loader 同理）；模块名拼接，打包器把它当纯运行时 import。
 * 永不 reject：失败只降级，mcp-runtime 模块随之不可用、health 里写明原因。
 */

import type { McpClientPlugin } from "../../mcp/contract/runtime.ts";

export type McpClientLoadState =
  | { status: "loaded"; plugin: McpClientPlugin; version?: string }
  | { status: "failed"; message: string };

const SPECIFIER = "@deepseek-ai/" + "dsh-mcp-client";

/** 尽力读版本（DSH 自带的包与 DSH 同版本）。 */
async function readVersion(): Promise<string | undefined> {
  try {
    const resolved = import.meta.resolve?.(SPECIFIER + "/package.json");
    if (typeof resolved !== "string") return undefined;
    const { fileURLToPath } = await import("node:url");
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(fileURLToPath(resolved), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param importer 供测试注入的 import 函数
 */
export async function loadMcpClient(
  importer: (specifier: string) => Promise<unknown> = (specifier) => import(/* @vite-ignore */ specifier),
): Promise<McpClientLoadState> {
  try {
    const loaded = (await importer(SPECIFIER)) as Record<string, unknown> | undefined;
    if (loaded === undefined || typeof loaded.Config !== "function" || typeof loaded.apply !== "function") {
      return { status: "failed", message: "DSH 官方 MCP 插件（dsh-mcp-client）的导出不符合预期：缺少 Config 或 apply" };
    }
    const version = await readVersion();
    return {
      status: "loaded",
      plugin: loaded as unknown as McpClientPlugin,
      ...(version === undefined ? {} : { version }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", message: "加载 DSH 官方 MCP 插件（dsh-mcp-client）失败：" + message };
  }
}
