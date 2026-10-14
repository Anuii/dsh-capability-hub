/**
 * 把 agent（会话或子代理）的创建与释放转告 MCP 运行时：按会话的服务器要挂到 agent.ctx 上（ADR-0010）。
 *
 * DSH 事实（dsh-agent）：
 *   - agent/created 是**串行**事件，载荷 { agent, source, signal? }；监听器要立刻返回——挂载放到后台做，
 *     不能拖住会话创建（官方插件连接可能要几秒）。
 *   - agent/disposed 是 emit 事件，载荷 { agent }。挂在 agent.ctx 上的插件随作用域一起回收，这里只记账。
 *   - agent.id 就是会话 id；agent.ctx 是该 agent 的作用域（在它上面注册的工具只对这个 agent 可见）。
 */

import type { PluginScope } from "../../mcp/contract/runtime.ts";
import type { HubLogger } from "../contract/host.ts";
import { errorText } from "../../shared/error-text.ts";

export interface AgentSink {
  agentCreated(sessionId: string, scope: PluginScope): void;
  agentDisposed(sessionId: string): void;
}

interface AgentFace {
  id?: unknown;
  session?: { id?: unknown };
  ctx?: unknown;
}

function agentOf(payload: unknown): AgentFace | undefined {
  const record = payload as { agent?: unknown } | undefined;
  const agent = (record?.agent ?? payload) as AgentFace | undefined;
  return agent !== null && typeof agent === "object" ? agent : undefined;
}

function sessionIdOf(agent: AgentFace): string | undefined {
  const id = typeof agent.id === "string" && agent.id !== "" ? agent.id : agent.session?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** 订阅 agent 事件；返回解绑函数。拿不到 ctx.on 时只记一条警告（按会话的服务器就挂不上）。 */
export function attachAgentHook(hostCtx: unknown, sink: AgentSink, logger: HubLogger): () => void {
  const on = (hostCtx as { on?: (event: string, listener: (...args: unknown[]) => unknown) => unknown } | undefined)
    ?.on;
  if (typeof on !== "function") {
    logger.warn("ctx.on 不可用：按会话挂载的 MCP 服务器不会生效");
    return () => {};
  }
  const disposers: (() => void)[] = [];
  const subscribe = (event: string, listener: (...args: unknown[]) => void): void => {
    try {
      const dispose = on.call(hostCtx, event, listener);
      if (typeof dispose === "function") disposers.push(dispose as () => void);
    } catch (error) {
      logger.warn("订阅 " + event + " 失败：" + errorText(error));
    }
  };
  subscribe("agent/created", (payload) => {
    try {
      const agent = agentOf(payload);
      const sessionId = agent === undefined ? undefined : sessionIdOf(agent);
      const scope = agent?.ctx as PluginScope | undefined;
      if (sessionId === undefined || scope === undefined || typeof scope.plugin !== "function") return;
      sink.agentCreated(sessionId, scope);
    } catch (error) {
      logger.warn("agent/created 处理失败：" + errorText(error));
    }
  });
  subscribe("agent/disposed", (payload) => {
    try {
      const agent = agentOf(payload);
      const sessionId = agent === undefined ? undefined : sessionIdOf(agent);
      if (sessionId !== undefined) sink.agentDisposed(sessionId);
    } catch (error) {
      logger.warn("agent/disposed 处理失败：" + errorText(error));
    }
  });
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // 作用域回收时 DSH 也会摘掉监听
      }
    }
  };
}
