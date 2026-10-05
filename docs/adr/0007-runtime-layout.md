# ADR-0007：MCP 懒加载运行时按职责分文件，对外入口不变

日期：2026-10-05 · 状态：已采纳（使用者选择「只整理，不重写」）

## 背景
`mcp/runtime/runtime.ts` 是一个约 1000 行的闭包：缓存、连接池、失败冷却、探测、六个动作、HTTP 视图、配置监听都在里面，读任何一部分都要先读懂整个函数。它没有已知缺陷，且沉淀了多轮修复（结束整棵进程树、取消不算失败、冷却、输出落盘），重写风险大于收益。

## 决定
- 只整理、不改行为：对外的 `createMcpRuntime` / `McpRuntimeInternal` 与 35 项集成测试、全部单测保持不变。
- 拆分：`core.ts`（RuntimeCore：配置快照、元数据缓存、连接池、探测与去重、后台工作登记）、`failures.ts`（失败记录与冷却、「取消不算失败」）、`actions/read.ts`（status / search / describe / instructions，只读缓存，绝不起进程）、`actions/connect.ts`、`actions/call.ts`、`status-view.ts`（GET mcp/runtime 的视图）、`text.ts`（给模型的文字片段）；`runtime.ts` 只剩对外接口、动作分派、会话事件、配置变化与定时任务。
- 「会话 id 是参数，不是可变字段」的并发约定保留在 core.ts 文件头。

## 后果
- 改一个动作只读那一个文件；冷却规则集中在 failures.ts。
- `atoms/` 下的底层零件（连接、进程树、缓存文件、输出护栏……）不动。
