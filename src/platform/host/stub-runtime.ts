/**
 * 阶段 A 的桩 runtime。
 *
 * 目的：在真正的 mcp-runtime（T3b）接入前，先把「只注册 1 个全局工具 mcp」这条
 * 链路跑通并可观测——固定的参数 DSL、固定的描述、execute 一律返回「尚未就绪」。
 *
 * 注意 KV-cache 事实（F1-Q4.5）：description 是「活」的，schemaOf 每次组装 system
 * prompt 都重算，所以原地改 description 会立刻生效；但描述文本变化会击穿前缀缓存，
 * 因此 runtime 只会在配置变化时改描述，这是设计约束而非实现选择。
 */
import type { McpCallContext, McpRuntime, McpSessionInfo } from "../../mcp/contract/runtime.ts";

/**
 * 工具参数：**原始 JSON Schema**（不是 dsh-tools 的 DSL）。
 *
 * 阶段 A 就是这份恒定 schema；阶段 B 的真实 runtime 会把它换成「不受任何 MCP
 * inputSchema 影响」的恒定代理 schema（懒加载的核心约束：schema 恒定保 KV-cache）。
 */
const STUB_PARAMETERS = {
  type: "object",
  properties: {
    action: { type: "string", description: "动作：search / describe / call / connect / instructions / status" },
    server: { type: "string", description: "服务器名（call / describe / connect / instructions 用）" },
    tool: { type: "string", description: "工具名（call 用）" },
    arguments: { type: "object", description: "工具入参对象（call 用）" },
    query: { type: "string", description: "检索词（search 用）" },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

const PREFIX = "MCP 服务器代理（能力中心）。当前可用服务器：";

/** 一个可见常量：桩就绪前的固定描述后缀。 */
const NOT_READY = "（尚未就绪）";

/**
 * 构造桩 runtime。
 *
 * 阶段 B 起，桩只在**真实 mcp-runtime 不可用**时使用（依赖缺失、SDK 未加载、路由冲突…），
 * 此时 `reason` 会写进工具描述与 execute 的返回文本 —— 模型必须看得见「为什么不可用」，
 * 而不是拿到一句含糊的「尚未就绪」。
 */
export function createStubRuntime(options: { servers?: string[]; reason?: string } = {}): McpRuntime {
  let servers = options.servers ?? [];
  const reason = options.reason;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* 监听者抛错不得影响 runtime */
      }
    }
  };
  return {
    toolName: "mcp",
    toolParameters(): unknown {
      return STUB_PARAMETERS;
    },
    toolDescription(): string {
      const names = servers.length === 0 ? "无" : servers.join(", ");
      const suffix = reason === undefined ? NOT_READY : `${NOT_READY}真实运行时不可用：${reason}`;
      return `${PREFIX}${names}${suffix}`;
    },
    onDescriptionChange(cb: () => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async execute(args: unknown, call: McpCallContext): Promise<string> {
      const action = (args as { action?: unknown } | undefined)?.action;
      return [
        "能力中心：MCP 运行时不可用（桩实现）。",
        `原因：${reason ?? "阶段 A 桩实现（未接入真实 mcp-runtime）"}`,
        `收到动作：${typeof action === "string" ? action : "（空）"}`,
        `会话：${call.sessionId}${call.parentSessionId === undefined ? "" : `（父会话 ${call.parentSessionId}）`}`,
      ].join("\n");
    },
    sessionStarted(info: McpSessionInfo): void {
      void info;
    },
    async sessionEnded(sessionId: string): Promise<void> {
      void sessionId;
    },
    async dispose(): Promise<void> {
      listeners.clear();
    },
    /** 测试/演示用：改服务器名列表并触发描述变化。 */
    ...({
      setServers(next: string[]): void {
        servers = [...next];
        emit();
      },
    } as Record<string, unknown>),
  } as McpRuntime;
}
