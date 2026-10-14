# ADR-0010：MCP 运行时改用官方 @deepseek-ai/dsh-mcp-client

日期：2026-10-13 · 状态：已采纳（使用者：「为什么不基于官方插件开发，不喜欢重复造轮子」）；**取代 [ADR-0009](0009-direct-mcp-tools.md)**，并更正其中一处错误

## 背景
0.1–0.6 的 MCP 运行时是本插件自己实现的：连接池、工具缓存与探测、参数 schema 转换、进程生命周期（首次调用启动、空闲回收）、失败冷却、输出护栏、工具注册与系统提示词段落，约 3000 行。这些能力 DSH 自带的官方插件 `@deepseek-ai/dsh-mcp-client` 已经具备，使用者不想为同一件事重复维护一份代码。

验证（2026-10-13，隔离测试 profile）：本插件能在运行时用 `hostCtx.plugin(McpClient, McpClient.Config({...}))` 把官方插件挂到自己的作用域上，返回 thenable、119ms 就绪；5 个工具全部注册（含 anyOf / prefixItems / `$ref` 参数的工具，原样注册），直接 `execute` 成功；`fiber.dispose()` 后工具注销、子进程退出。所以官方插件可以由本插件按需挂载，**配置仍存插件自己的文件、不写进任何 profile**（D-C1 不变）。

## 决定
- 挂载方式在 JSON 里用 `"scope"` 选择：`"global"`（**默认**，全局一份）= 挂在插件根作用域，DSH 启动或启用插件时连接一次、全局共用；`"session"`（按会话）= 会话创建时挂在 `agent.ctx` 上、会话结束卸载。
- `envFrom` 仍由本插件在挂载前解析，再把结果交给官方插件。全局服务器解析一次；按会话的服务器解析一次后复用，配置变了才重算。
- 删除自研运行时整体：连接池、工具缓存与探测、参数 schema 转换（`atoms/schema-subset.ts`）、进程生命周期、失败冷却、输出护栏、工具注册与系统提示词段落。删除范围还包括 `includeTools` / `excludeTools` 过滤（旧值读到忽略、保存时去掉）。
- 输出护栏交给 DSH 的 `dsh-spill-policy`（对所有工具结果生效；旧配置 `outputGuard` 读到忽略）。
- 界面删除：「运行中」区域、全局设置页（`idleTimeout` / `failureBackoffMs` / `outputGuard`）；MCP 页只用 JSON 配置。
- 断线重连用官方默认，不提供表单。

## 后果
- 失去：进程「首次调用才启动」、空闲回收、失败冷却、实例详情（PID、启动时间、最近使用）；`lifecycle` / `idleTimeout` / `debug` 字段一并删除。
- 参数写法复杂的工具（anyOf、类型数组、`$ref`、format、范围等）在 PTC 生成类型时退成 `unknown`，模型看不到精确的参数类型。
- 得到：图片结果、MCP 资源、自动重连；少维护约 3000 行自研代码。
- 每台服务器的连接状态改由界面行显示「已连接 · N 个工具 / 未连接」，详情抽屉提供「重新连接」（卸下再挂上）；行状态来自官方插件（D-E1）。

## 更正 ADR-0009 的一处错误
ADR-0009（与 0.6.0 总结）说「MCP 服务器常用的 anyOf、类型数组、`$ref`……在原样注册时会被拒绝」——这不对：`ctx.tools.register()` 只校验 `output.schema`，**不校验参数 schema**，不支持的参数 schema 照样注册；只是 PTC 生成类型时 `jsonSchemaToTs` 失败、退成 `unknown`。所以参数 schema 转换的实际作用是让这些工具在 PTC 里拥有正确的参数类型，而不是「不转换就注册不上」；「原样注册会被拒 8 个」的说法与 `schema-subset-check.mjs` 的相关措辞同样作废。
