/**
 * mcp-runtime 模块入口（ADR-0010）：把配置里的服务器挂载成官方 dsh-mcp-client 插件实例。
 *
 * 路由：
 *   GET  mcp/runtime              → { servers }（每台服务器的挂载状态与已注册的工具）
 *   POST mcp/runtime/reconnect    { name } → { server }（未知 404、已停用 409）
 */
import { createMcpRuntime, type McpRuntimeInternal, type McpRuntimeOptions } from "./runtime.ts";
import { asRecord, requireString } from "../../shared/request.ts";
import type { HubContext, HubModule } from "../../platform/contract/host.ts";

export type McpRuntimeModuleDeps = Omit<McpRuntimeOptions, "logger">;

export interface McpRuntimeModule extends HubModule {
  runtime: McpRuntimeInternal;
}

export function createMcpRuntimeModule(ctx: HubContext, deps: McpRuntimeModuleDeps): McpRuntimeModule {
  const runtime = createMcpRuntime({ ...deps, logger: ctx.logger });
  const routes: HubModule["routes"] = {
    "GET mcp/runtime": async () => runtime.status(),
    "POST mcp/runtime/reconnect": async (req) => {
      const name = requireString(asRecord(req.body).name, "name");
      return { server: await runtime.reconnect(name) };
    },
  };
  return { routes, runtime, dispose: () => runtime.dispose() };
}

export { createMcpRuntime } from "./runtime.ts";
export type { McpRuntimeInternal, McpRuntimeOptions } from "./runtime.ts";
