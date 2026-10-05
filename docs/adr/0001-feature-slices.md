# ADR-0001：源码按功能切片组织，import 规则由测试守住

日期：2026-10-05 · 状态：已采纳

## 背景
0.3.x 之前源码按「宿主 / 客户端」分两棵树（`src/host/`、`src/client/`）。改一个功能（例如仓库视图）要在两棵树之间来回跳；而「四个宿主模块互不 import」「客户端不引用宿主代码」这些规则只写在文档里，靠自觉遵守。

## 决定
- 目录按功能切片：
  - `src/skills/`：`local/`（宿主：本地技能）、`remote/`（宿主：远程技能）、`client/`（技能页与仓库视图）、`contract/`（共享类型，见 ADR-0002）
  - `src/mcp/`：`config/`、`runtime/`（宿主）、`client/`（MCP 页，`client/running/` 是「运行中」区域）、`contract/`
  - `src/platform/`：`host/`（组装宿主模块、接 DSH）、`client/`（页头、标签、HTTP 客户端）
  - `src/kit/`：界面组件，不知道任何功能
  - `src/shared/`：不知道任何功能的叶子工具（例如宿主侧统一的错误码与错误工厂 `errors.ts`），任何区域都可以引用
- `test/` 的目录结构与 `src/` 一一对应；`test/architecture/imports.test.ts` 扫描 import 语句，违反下列规则即失败：
  1. 四个宿主功能模块互不 import，只能引用自己、契约（仅类型）与共享区（`src/version.ts`、`src/shared/`）；
  2. 宿主外壳不引用客户端代码；
  3. 客户端（功能、外壳、kit）不引用宿主代码；
  4. kit 只引用 kit；
  5. 客户端功能之间互不 import，只用客户端外壳公开的 `api.ts` 与 `tab-props.ts`；
  6. 契约只引用契约，且只能被 `import type`。

## 后果
- 一个功能的宿主、客户端、契约、测试都在同一个目录名下。
- 规则被违反时单测直接失败，不再依赖代码评审。
- 重排目录本身不改任何逻辑：两份构建产物除源码路径注释外逐字节相同。
