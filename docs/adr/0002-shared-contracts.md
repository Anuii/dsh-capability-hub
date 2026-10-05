# ADR-0002：宿主与客户端共用按功能划分的契约类型

日期：2026-10-05 · 状态：已采纳（推翻了「客户端按 HTTP 响应逐字段复制宿主类型」的旧约定）

## 背景
宿主半与浏览器半是两份产物。旧约定是客户端不 import 宿主的任何东西，而是把每条路由的请求 / 响应形状手抄一份，文件头写着「改契约时两处一起改」。四个宿主模块之间也各自重抄 HubContext、SkillsLocalApi、EffectiveServer 等。到 0.3.4 时同名类型重复了 61 个；新增的 DiscoveryView 就抄了两遍，形状不一致只能在运行时发现。

## 决定
- 每个功能一个只放类型的契约目录：
  - `src/platform/contract/host.ts`：HubContext、HubModule、RouteTable、HubError、FieldError（外壳 ↔ 宿主功能模块）
  - `src/skills/contract/local.ts`：技能列表、查看、回收站的 HTTP 形状 + SkillsLocalApi、LockStash（进程内注入）
  - `src/skills/contract/remote.ts`：来源、仓库列表、发现、更新、安装、搜索的 HTTP 形状
  - `src/mcp/contract/config.ts`：MCP 配置的 HTTP 形状 + McpConfigSource（配置 → 运行时）
  - `src/mcp/contract/runtime.ts`：运行状态的 HTTP 形状 + McpRuntime、McpSdk（外壳 ↔ 运行时）
- 宿主模块与客户端都 `import type` 契约。ADR-0001 的 import 规则测试强制「契约只能被 import type」「契约只引用契约」。
- 模块内部才用到的形状（落盘文件格式、注入点选项）留在模块自己的 `types.ts`；某个模块只需要契约接口的一部分时用 `Pick` 表达（例如远程技能的 `SkillsLocalPort`）。
- 客户端的 `data.ts` 仍负责把接口返回补成安全形状（缺字段给默认值），但目标类型来自契约。

## 后果
- 同名类型重复从 61 个降到 0；契约漂移由 tsc 发现。
- `import type` 在构建时擦除：浏览器产物不包含宿主代码，四个宿主模块之间依然互不 import 实现。
