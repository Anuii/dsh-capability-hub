/**
 * 代理工具 mcp 的参数 schema（D-D1：**恒定**，绝不随配置变化）。
 *
 * 为什么恒定是硬要求（F1-Q4）：工具 schema 会进 system prompt 前缀，
 * 「可见定义与其顺序不变时前缀稳定」；一旦把服务器名/工具名做成枚举写进 schema，
 * 每次增删服务器都会从第一个变化的 token 起击穿 KV-cache。
 * 我们按 D-D1 只列「已启用服务器名」（在描述里），参数部分完全恒定。
 *
 * **形状（PLAN §3.6 变更，2026-10-04 调度者批准）**：恒定的**原始 JSON Schema**，
 * 顶层 type: 'object'，由平台层手写工具定义直接交给 ctx.tools.register
 * （不用 dsh-tools 的 defineTool，原因见 `src/platform/host/tool-registrar.ts` 顶部）。
 * 本文件**不是**别人的 DSL，就是最终交给 register 的那份对象。
 *
 * 类型映射：
 *   - DSL 的 'string'  → { type: 'string' }
 *   - DSL 的 'boolean' → { type: 'boolean' }
 *   - DSL 的 'integer' → { type: 'integer' }
 *   - DSL 的 'json'（任意值）→ **只写 description、不带 type** 的属性 —— JSON Schema 里
 *     「没有 type」就是「不约束」，这正是 MCP 工具参数要的「任意值」。
 *     （实测 ctx.tools.register 接受这种写法。）
 */
export const PROXY_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    search: {
      type: "string",
      description:
        "在本地工具缓存里检索 MCP 工具（按名称、描述、服务器名、searchKeywords 排序）。只读缓存，不启动任何服务器。",
    },
    describe: {
      type: "string",
      description: "查看一个具名工具的完整参数 schema。工具名可以用原名、<服务器>__<工具名>，或 glob。只读缓存。",
    },
    tool: {
      type: "string",
      description: "要调用的 MCP 工具名。这是唯一会按需启动服务器的路径。",
    },
    args: {
      description: "传给 tool 的参数对象，形状与 describe 显示的一致。",
    },
    server: {
      type: "string",
      description: "MCP 服务器名；当两个服务器有同名工具时用来消歧。",
    },
    connect: {
      type: "string",
      description: "立即连接某个服务器并刷新它的工具清单（不调用任何工具）。默认受失败退避约束。",
    },
    instructions: {
      type: "string",
      description: "显示某个服务器自己发布的用法说明（如果有）。只读缓存。",
    },
    regex: {
      type: "boolean",
      description: "把 search 当成正则表达式。默认 false。",
    },
    includeSchemas: {
      type: "boolean",
      description: "search 结果里是否包含参数摘要。默认 true。",
    },
    limit: {
      type: "integer",
      description: "search 最多返回多少条。默认 12，上限 40。",
    },
    offset: {
      type: "integer",
      description: "search 跳过前面多少条（分页用）。",
    },
    force: {
      type: "boolean",
      description: "配合 connect 使用：绕过失败退避，强制重试一次。配置刚修好时用它。",
    },
  },
  additionalProperties: false,
} as const;

/** "mcp" 工具的参数名清单（用于动作分派与测试断言形状）。 */
export const PARAMETER_NAMES = Object.keys(PROXY_TOOL_PARAMETERS.properties);
