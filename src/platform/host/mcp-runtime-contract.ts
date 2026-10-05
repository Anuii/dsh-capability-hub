/**
 * 平台层对 mcp-runtime（T3b）的最小结构契约。
 *
 * 功能模块之间不得互相 import，平台层也不 import T3b 的实现；两边都按这份
 * 结构类型对接（PLAN §3.6）。阶段 A 只有桩实现（stub-runtime.ts）。
 */

/** 一次工具调用的执行上下文。 */
export interface McpCallContext {
  sessionId: string;
  parentSessionId?: string;
  signal: AbortSignal;
}

/** 会话开始信息。 */
export interface McpSessionInfo {
  sessionId: string;
  parentSessionId?: string;
  title?: string;
}

/** T3b 的 McpRuntime 面。 */
export interface McpRuntime {
  readonly toolName: "mcp";
  /**
   * 工具参数的**原始 JSON Schema**（恒定，不随配置变化）。
   *
   * 注意：不是 dsh-tools 的 parameters DSL。平台层手写工具定义（见 tool-registrar.ts
   * 的说明），parameters 直接交给 ctx.tools.register，因此必须是受支持的 JSON Schema
   * 子集（顶层 type: "object"）。
   */
  toolParameters(): unknown;
  /** 恒定前缀 + 已启用服务器名（配置顺序），不写工具数量。 */
  toolDescription(): string;
  /** 描述变化回调；返回解绑函数。 */
  onDescriptionChange(cb: () => void): () => void;
  /** 永不 reject；失败以文本返回。 */
  execute(args: unknown, call: McpCallContext): Promise<string>;
  /** 不得阻塞。 */
  sessionStarted(info: McpSessionInfo): void;
  sessionEnded(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}
