/**
 * 把 McpRuntime 注册成 DSH 的全局工具 mcp（F1-Q4）。
 *
 * 事实要点：
 *   - 在 profile 根 ctx 上 ctx.tools.register(def) 即「全局注册」（所有 agent 可见），
 *     这正是「只注册 1 个 schema 恒定的代理工具」该做的事。
 *   - register() 返回 scope-aware 的 disposer，必须挂进 ctx.effect 由 fiber 释放。
 *   - 工具描述是「活」的：原地改 definition.description 后，下次组装 system prompt
 *     立刻生效，不需要重新 register（schemaOf 每次重算，不做快照）。
 *   - execute 的 exec 里没有 session id，要取 exec.agent.session.id；
 *     父会话在 **session.header** 的 parentSession（origin === "subagent"）。
 *     注意别读错成 session.requestHeader()：那是 LLM 请求的 epoch header，
 *     没有 parentSession（FIX-8 的 D-E1 根因，见 sessionHeaderOf 的注释）。
 *
 * **为什么手写 definition，而不是 import @deepseek-ai/dsh-tools 的 defineTool**：
 *   1. 实测（A6 诊断）：从本插件动态 import @deepseek-ai/dsh-tools 会直接抛
 *      "The requested module '@deepseek-ai/dsh-llm' does not provide an export named 'CallId'"
 *      —— 插件侧的 @deepseek-ai/* 解析与 DSH 内部不是同一条路径，依赖它很脆。
 *   2. defineTool 的 parameters 是 dsh-tools 自有 DSL，无法表达任意 JSON Schema；
 *      而能力中心要代理的是任意 MCP 服务器的 inputSchema（F1-Q4.1）。
 *   3. DSH 自带的 dsh-mcp-client 就是手写 definition（把 MCP inputSchema 原样赋给
 *      parameters，再交给 ctx.tools.register），本文件照抄这条姿势。
 *   代价：parameters 必须是「受支持的 JSON Schema 子集」，register 会校验 output.schema。
 */
import type { McpRuntime } from "../../mcp/contract/runtime.ts";
import type { HubLogger } from "../contract/host.ts";

/** 从 exec.agent 取会话身份；取不到时回退并记录。 */
export interface SessionIdentity {
  sessionId: string;
  parentSessionId?: string;
  title?: string;
  /** 取值来源：agent | fallback */
  source: "agent" | "fallback";
}

/**
 * 读 header 上的父会话 id。
 *
 * origin 只允许 undefined 或 "subagent"（dsh-session/lib/index.js:1050）；缺失时也接受
 * parentSession（FIX-8：实测过的 header 形态里两者总是同在，但不为此丢掉父会话）。
 */
function parentOf(header: unknown): string | undefined {
  const record = header as { parentSession?: unknown; origin?: unknown } | undefined;
  if (record === undefined || record === null || typeof record !== "object") return undefined;
  if (record.origin !== undefined && record.origin !== "subagent") return undefined;
  return typeof record.parentSession === "string" && record.parentSession !== "" ? record.parentSession : undefined;
}

/**
 * 读会话 header。
 *
 * **FIX-8 根因修复**：必须优先读 `session.header`（真正的 SessionHeader，
 * dsh-session/lib/index.js:1699-1710 组装、1048-1052 校验），
 * 它在首次 LLM 请求之前也存在且带 parentSession / origin / delegationDepth。
 * `session.requestHeader()` **不是**会话 header —— 它是 request/header 事件的折叠
 * （dsh-session:1494-1500 → foldRequestHeader:634-638），是下一次请求的 epoch header，
 * 既没有 parentSession 也没有 origin，首次请求前还是 undefined。
 * FIX-8 之前这里优先读它，工具执行上下文的 parentSessionId 因此永远取不到（D-E1）。
 */
function sessionHeaderOf(session: { header?: unknown; requestHeader?(): unknown } | undefined): unknown {
  if (session === undefined || session === null) return undefined;
  const header = session.header;
  if (header !== undefined) return header;
  try {
    return typeof session.requestHeader === "function" ? session.requestHeader() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从 dsh-tools 的 exec 提取会话身份。
 * @param exec 工具定义的第二个参数
 */
export function sessionIdentityOf(exec: unknown): SessionIdentity {
  const agent = (exec as { agent?: { session?: { id?: unknown; header?: unknown; requestHeader?(): unknown } } } | undefined)?.agent;
  const sessionId = agent?.session?.id;
  if (typeof sessionId === "string" && sessionId !== "") {
    let header: unknown;
    try {
      header = sessionHeaderOf(agent?.session);
    } catch {
      header = undefined;
    }
    const parent = parentOf(header);
    const title = (header as { title?: unknown } | undefined)?.title;
    return {
      sessionId,
      ...(parent === undefined ? {} : { parentSessionId: parent }),
      ...(typeof title === "string" && title !== "" ? { title } : {}),
      source: "agent",
    };
  }
  // 回退：exec 上没有 agent（例如无 agent 上下文的调用）。
  // 键必须仍然存在（返回的是 string），用一个稳定且不会与真实 id 撞车的前缀。
  return { sessionId: "anonymous", source: "fallback" };
}

/** 只注册一次的工具注册结果。 */
export interface ToolRegistration {
  /** 当前生效的描述（读的时候实时取）。 */
  description(): string;
  /** 解绑描述监听并注销工具。 */
  dispose(): void;
  /** 是否真的注册成功（false = 已降级）。 */
  registered: boolean;
  /** 失败原因（成功时 undefined）。 */
  error?: string;
}

/** DSH 侧的最小面（避免静态依赖 @deepseek-ai/dsh-tools 的类型）。 */
export interface ToolsFacade {
  register(definition: unknown): () => void;
}

/** 手写工具定义的形状（ToolRuntime 消费的字段子集）。 */
export interface ToolDefinitionLike {
  name: string;
  description: string;
  parameters: unknown;
  output: {
    schema: unknown;
    render(args: unknown, value: unknown): unknown[];
  };
  execute(args: unknown, exec: unknown): Promise<unknown>;
}

/**
 * 注册全局工具 mcp。任何失败都只记降级、不抛。
 * @param tools ctx.tools
 * @param runtime 运行时（阶段 A 是桩）
 * @param logger 日志面
 * @param onSession 观测钩子：每次 execute 都会带着会话身份回调（用于 V5 证据）
 */
export function registerMcpTool(options: {
  tools: ToolsFacade;
  runtime: McpRuntime;
  logger: HubLogger;
  onSession?: (identity: SessionIdentity) => void;
}): ToolRegistration {
  const { tools, runtime, logger, onSession } = options;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let unregister: (() => void) | undefined;
  const identityFallbackWarned = { value: false };

  const definition: ToolDefinitionLike = {
    name: runtime.toolName,
    description: runtime.toolDescription(),
    parameters: runtime.toolParameters(),
    output: {
      schema: { type: "string" },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
      ],
    },
    async execute(args: unknown, exec: unknown): Promise<string> {
      const identity = sessionIdentityOf(exec);
      if (identity.source === "fallback" && !identityFallbackWarned.value) {
        identityFallbackWarned.value = true;
        logger.warn("mcp 工具调用没有 agent 上下文，会话 id 回退为 anonymous（已记录一次）");
      }
      try {
        onSession?.(identity);
      } catch {
        /* 观测钩子不得影响工具执行 */
      }
      const signal = (exec as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal;
      try {
        return await runtime.execute(args, {
          sessionId: identity.sessionId,
          ...(identity.parentSessionId === undefined ? {} : { parentSessionId: identity.parentSessionId }),
          signal,
        });
      } catch (error) {
        // McpRuntime 契约要求永不 reject；这里再兜一层，保证工具本身也不炸。
        const message = error instanceof Error ? error.message : String(error);
        logger.error("mcp 工具执行抛出未预期错误：", message);
        return "能力中心：MCP 调用失败（" + message + "）";
      }
    },
  };

  try {
    unregister = tools.register(definition);
    unsubscribe = runtime.onDescriptionChange(() => {
      if (disposed) return;
      try {
        definition.description = runtime.toolDescription();
      } catch (error) {
        logger.warn("更新 mcp 工具描述失败：", error instanceof Error ? error.message : error);
      }
    });
    return {
      description: () => runtime.toolDescription(),
      dispose(): void {
        disposed = true;
        unsubscribe?.();
        unregister?.();
      },
      registered: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("注册 mcp 全局工具失败（已降级，不影响 DSH）：" + message);
    return {
      description: () => runtime.toolDescription(),
      dispose(): void {
        disposed = true;
      },
      registered: false,
      error: message,
    };
  }
}
