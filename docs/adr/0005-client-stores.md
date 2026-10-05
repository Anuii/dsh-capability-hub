# ADR-0005：客户端状态用「状态仓库 + 数据 adapter」，逻辑在组件之外测

日期：2026-10-05 · 状态：已采纳

## 背景
0.3.x 的界面状态混着三种写法：组件里的一堆 `useState`（仓库视图 31 个）、一个手写的外部仓库（来源与更新），以及零散的纯函数。最明显的问题出在 MCP 页：同一个 `GET mcp/runtime` 有两条读取路径——MCP 页只在加载和操作后读一次，「运行中」区域每 5 秒轮询——两边靠 `runningTick` 与 `reportAttention` 手动对齐，服务器状态点与标签红点会比「运行中」旧。规则只写在 React 代码里时，只能靠截图验证。

## 决定
- kit 提供两个通用件：`kit/store.ts` 的 `createStore(initial)`（快照 + 订阅，不依赖 React）与 `kit/use-store.ts` 的 `useStoreState(store)`。
- 一个功能的共享状态写成「状态仓库」：持有快照、提供动作（读取、刷新、断开……），动作完成后自己更新快照；经可替换的数据 adapter 访问宿主——正式运行是 HTTP（`data.ts`），单测是内存 fake，必要时还有开发预览的 adapter。组件只订阅、渲染、转发用户操作。
- 仓库实例由使用它的标签页创建（`React.useMemo`），向下传给子区域；不做全局单例，测试各建各的。
- 不引入 DOM 测试库：规则进可测模块（仓库、视图模型如 `skills/client/row.ts`、`kit/fold.ts`），渲染效果仍靠截图脚本验收。

## 第一批落地
- MCP 页的运行状态：`mcp/client/runtime-store.ts`。服务器行、详情抽屉、「运行中」、标签红点读同一份快照；轮询（5 秒，页面不可见时跳过，多处启动共用一个计时器）、刷新缓存与断开后的重读、保存后等工具数（D-C6）都在仓库里。删掉了 `runningTick` 与重复的 `running/data.ts`。
- 「运行中」的预览数据（?hubPreviewRunning=1）改成一个 adapter：服务器状态照常读，会话换成示例。
