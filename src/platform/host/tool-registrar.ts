/**
 * 把运行时给出的每个 MCP 工具直接注册成 DSH 工具（D-D1），并随工具集合变化增量更新。
 *
 * 事实要点：
 *   - 在 profile 根 ctx 上 ctx.tools.register(def) 即「全局注册」（所有 agent 可见）；PTC 模式下每个工具
 *     都会成为一个独立的类型化 SDK 绑定（tools.mcp__<服务器>__<工具>(...)）。
 *   - register() 返回 disposer；注册时 DSH 会校验 parameters 是否在它支持的 JSON Schema 子集里
 *     （运行时已经转换过，见 mcp/runtime/atoms/schema-subset.ts）。某个工具仍被拒时只跳过它、记下原因，
 *     其余工具照常注册（DSH 官方 MCP 客户端是整台服务器一起放弃）。
 *   - 工具集合变化时只动变了的那几个：没变的不注销不重注册，提示词前缀缓存才不失效。
 *   - execute 的 exec 里没有 session id，要取 exec.agent.session.id；
 *     父会话在 **session.header** 的 parentSession（origin === "subagent"）。
 *     注意别读错成 session.requestHeader()：那是 LLM 请求的 epoch header，
 *     没有 parentSession（FIX-8 的 D-E1 根因，见 sessionHeaderOf 的注释）。
 *
 * **为什么手写 definition，而不是 import @deepseek-ai/dsh-tools 的 defineTool**：
 *   1. 实测（A6 诊断）：从本插件动态 import @deepseek-ai/dsh-tools 会直接抛
 *      "The requested module '@deepseek-ai/dsh-llm' does not provide an export named 'CallId'"
 *      —— 插件侧的 @deepseek-ai/* 解析与 DSH 内部不是同一条路径，依赖它很脆。
 *   2. defineTool 的 parameters 是 dsh-tools 自有 DSL，表达不了任意 JSON Schema；MCP 工具的参数是 JSON Schema。
 *   3. DSH 自带的 dsh-mcp-client 也是手写 definition（parameters 直接给 JSON Schema）。
 */
import type { McpRuntime, McpToolSpec } from "../../mcp/contract/runtime.ts";
import type { HubLogger } from "../contract/host.ts";
import { errorText } from "../../shared/error-text.ts";

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
  const agent = (
    exec as { agent?: { session?: { id?: unknown; header?: unknown; requestHeader?(): unknown } } } | undefined
  )?.agent;
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

/** 当前的注册结果（health 与启动报告读它）。 */
export interface McpToolsRegistration {
  /** 已注册的工具名（按注册顺序）。 */
  registered(): string[];
  /** 被 DSH 拒绝注册的工具与原因。 */
  failed(): { name: string; error: string }[];
  dispose(): void;
}

/**
 * 注册运行时给出的全部 MCP 工具，并订阅变化。任何失败都只记录、不抛。
 * @param onSession 观测钩子：每次 execute 都会带着会话身份回调
 */
export function registerMcpTools(options: {
  tools: ToolsFacade;
  runtime: McpRuntime;
  logger: HubLogger;
  onSession?: (identity: SessionIdentity) => void;
}): McpToolsRegistration {
  const { tools, runtime, logger, onSession } = options;
  const live = new Map<string, { key: string; dispose: () => void }>();
  const failures = new Map<string, string>();
  let fallbackWarned = false;
  let disposed = false;

  const definitionOf = (spec: McpToolSpec): ToolDefinitionLike => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: "string" },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
      ],
    },
    async execute(args: unknown, exec: unknown): Promise<string> {
      const identity = sessionIdentityOf(exec);
      if (identity.source === "fallback" && !fallbackWarned) {
        fallbackWarned = true;
        logger.warn("MCP 工具调用没有 agent 上下文，会话 id 回退为 anonymous（已记录一次）");
      }
      try {
        onSession?.(identity);
      } catch {
        /* 观测钩子不得影响工具执行 */
      }
      const signal = (exec as { signal?: AbortSignal } | undefined)?.signal ?? new AbortController().signal;
      // 失败直接抛：DSH 把它记成失败的工具调用（PTC 模式下是 ToolCallError），不会中止这一轮
      return runtime.call(spec.name, args, {
        sessionId: identity.sessionId,
        ...(identity.parentSessionId === undefined ? {} : { parentSessionId: identity.parentSessionId }),
        signal,
      });
    },
  });

  const sync = (): void => {
    if (disposed) return;
    let specs: McpToolSpec[];
    try {
      specs = runtime.tools();
    } catch (error) {
      logger.warn("读取 MCP 工具清单失败（保持现有注册）：" + errorText(error));
      return;
    }
    const wanted = new Map(specs.map((spec) => [spec.name, spec]));
    const keyOf = (spec: McpToolSpec): string => JSON.stringify([spec.description, spec.parameters]);
    for (const [name, entry] of live) {
      const spec = wanted.get(name);
      if (spec !== undefined && keyOf(spec) === entry.key) continue;
      try {
        entry.dispose();
      } catch (error) {
        logger.warn("注销 MCP 工具 " + name + " 失败：" + errorText(error));
      }
      live.delete(name);
    }
    for (const name of [...failures.keys()]) if (!wanted.has(name)) failures.delete(name);
    for (const spec of specs) {
      if (live.has(spec.name)) continue;
      try {
        live.set(spec.name, { key: keyOf(spec), dispose: tools.register(definitionOf(spec)) });
        failures.delete(spec.name);
      } catch (error) {
        const message = errorText(error);
        if (failures.get(spec.name) !== message)
          logger.warn("MCP 工具 " + spec.name + " 注册失败（已跳过）：" + message);
        failures.set(spec.name, message);
      }
    }
  };

  sync();
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = runtime.onToolsChange(sync);
  } catch (error) {
    logger.warn("订阅 MCP 工具变化失败（工具清单不再跟随更新）：" + errorText(error));
  }
  return {
    registered: () => [...live.keys()],
    failed: () => [...failures].map(([name, error]) => ({ name, error })),
    dispose(): void {
      disposed = true;
      unsubscribe?.();
      for (const [name, entry] of live) {
        try {
          entry.dispose();
        } catch (error) {
          logger.warn("注销 MCP 工具 " + name + " 失败：" + errorText(error));
        }
      }
      live.clear();
    },
  };
}
