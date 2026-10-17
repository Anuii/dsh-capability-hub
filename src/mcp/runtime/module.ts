/**
 * mcp-runtime 模块入口（ADR-0010）：把配置里的服务器挂载成官方 dsh-mcp-client 插件实例。
 *
 * 0.9.0 起**不再注册任何 HTTP 路由**：页面不显示运行状态、也没有「重新连接」按钮
 * （GET mcp/runtime 与 POST mcp/runtime/reconnect 已删除）。挂载照常进行，状态只由外壳
 * 取 `runtime.status()` 填进 GET health 的 mcpServers 与 boot.json；连接失败只看得到那条记录，
 * 用户要重试就重启 DSH。
 */
import { createMcpRuntime, type McpRuntimeInternal, type McpRuntimeOptions } from "./runtime.ts";
import type { HubContext, HubModule } from "../../platform/contract/host.ts";

export type McpRuntimeModuleDeps = Omit<McpRuntimeOptions, "logger">;

export interface McpRuntimeModule extends HubModule {
  runtime: McpRuntimeInternal;
}

export function createMcpRuntimeModule(ctx: HubContext, deps: McpRuntimeModuleDeps): McpRuntimeModule {
  const runtime = createMcpRuntime({ ...deps, logger: ctx.logger });
  return { routes: {}, runtime, dispose: () => runtime.dispose() };
}

export { createMcpRuntime } from "./runtime.ts";
export type { McpRuntimeInternal, McpRuntimeOptions } from "./runtime.ts";
