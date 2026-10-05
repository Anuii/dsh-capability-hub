/**
 * mcp-runtime 模块入口（PLAN §3.6 / §3.7）。
 *
 * 工厂签名与契约一致：
 *   createMcpRuntimeModule(ctx: HubContext, deps: { config: McpConfigSource; sdk: McpSdk })
 *     => HubModule & { runtime: McpRuntime }
 *
 * 路由（PLAN §3.7「MCP·运行态」）：
 *   GET  mcp/runtime               → { servers, sessions }
 *   POST mcp/runtime/refresh       { name }              → { toolCount }
 *   POST mcp/runtime/disconnect    { name, sessionId? }  → { closed }
 *
 * start() 是平台层在注册工具后调用的（T0 负责接线）：它只做后台工作
 * （配置监听、空闲巡检、启动探测），即使它抛错也不该影响插件加载 ——
 * 调用方按永不失败外壳的约定自行 catch；这里尽量把错误降级为日志。
 */
import { createMcpRuntime } from './runtime.ts';
import type { McpRuntimeInternal } from './runtime.ts';
import { BAD_REQUEST, NOT_FOUND } from './atoms/errors.ts';
import type { McpConfigSource, McpSdk } from './contract.ts';
import type { HubContext, HubModule, RouteRequest } from '../../platform/contract/host.ts';

export interface McpRuntimeModuleDeps {
  config: McpConfigSource;
  sdk: McpSdk;
}

export interface McpRuntimeModule extends HubModule {
  runtime: McpRuntimeInternal;
  /** 启动后台工作；返回 Promise 便于平台层在 dev 环境下 await，生产环境可 fire-and-forget。 */
  start(): Promise<void>;
}

function readBody(req: RouteRequest): Record<string, unknown> {
  const body = req.body;
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw BAD_REQUEST('请求体必须是一个 JSON 对象');
  return body as Record<string, unknown>;
}

function requireName(body: Record<string, unknown>): string {
  const name = body.name;
  if (typeof name !== 'string' || name.trim().length === 0) throw BAD_REQUEST('缺少必填字段 name（MCP 服务器名）');
  return name;
}

export function createMcpRuntimeModule(ctx: HubContext, deps: McpRuntimeModuleDeps): McpRuntimeModule {
  const runtime = createMcpRuntime({ ctx, config: deps.config, sdk: deps.sdk });

  const routes: HubModule['routes'] = {
    'GET mcp/runtime': async () => runtime.status(),

    'POST mcp/runtime/refresh': async (req) => {
      const body = readBody(req);
      const name = requireName(body);
      try {
        return await runtime.refresh(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('没有名为')) throw NOT_FOUND(message);
        throw BAD_REQUEST(message);
      }
    },

    'POST mcp/runtime/disconnect': async (req) => {
      const body = readBody(req);
      const name = requireName(body);
      const sessionIdRaw = body.sessionId;
      if (sessionIdRaw !== undefined && typeof sessionIdRaw !== 'string') {
        throw BAD_REQUEST('sessionId 必须是字符串（省略 = 断开所有会话）');
      }
      try {
        return await runtime.disconnect(name, sessionIdRaw as string | undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('没有名为')) throw NOT_FOUND(message);
        throw BAD_REQUEST(message);
      }
    },
  };

  return {
    routes,
    runtime,
    start: () => runtime.start(),
    dispose: () => runtime.dispose(),
  };
}

export { createMcpRuntime } from './runtime.ts';
export { TOOL_NAME, unwrapGatewayEnvelope, probeSessionId } from './runtime.ts';
export type { McpRuntimeInternal, McpRuntimeOptions, ProbeReason, SessionRef } from './runtime.ts';
export { PROXY_TOOL_PARAMETERS, PARAMETER_NAMES } from './tool-schema.ts';
