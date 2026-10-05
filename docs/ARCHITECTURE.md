# 架构（一页）

能力中心是一个 DSH 插件，分两半发布在同一个包里：**宿主半**（`lib/index.js`，跑在 DSH 进程里，提供 HTTP 路由与 `mcp` 工具）与**客户端半**（`lib/client.js`，跑在 DSH 的网页界面里）。源码按**功能**切片，每个功能下再分宿主、客户端与两者共用的契约（ADR-0001）。

```
src/
  platform/   外壳
    host/       组装四个宿主模块、接 DSH（路由、mcp 工具注册、会话事件、加载 DSH 自带的 MCP SDK 与 yaml）
    client/     页头、两个标签、HTTP 客户端 api.ts、标签契约 tab-props.ts
    contract/   外壳 ↔ 宿主模块：HubContext、HubModule、RouteTable、HubError、FieldError
  skills/     技能
    local/      宿主·本地技能：扫描技能目录、frontmatter 判断与「只改一行」启停（frontmatter/）、回收站
    remote/     宿主·远程技能：来源记录（lock）、仓库列表与发现（repo-catalog.ts）、浏览、安装、检查更新
    client/     技能页（列表、详情、回收站）与「添加技能」仓库视图（remote/）
    contract/   local.ts、remote.ts（HTTP 形状与进程内接口）、yaml.ts（注入的 yaml 库）
  mcp/        MCP
    config/     宿主·MCP 配置：落盘、校验、遮罩、粘贴 JSON / 预设 / 只读导入
    runtime/    宿主·MCP 懒加载运行时：core.ts（缓存、连接池、探测）、actions/（mcp 工具的各个动作）、status-view.ts
    client/     MCP 页；running/ 是页面底部的「运行中」区域
    contract/   config.ts、runtime.ts
  kit/        界面组件、样式写法（css.ts）、折叠（fold.ts）、状态仓库（store.ts）
  shared/     宿主与客户端共用的叶子工具：错误码、错误文字、请求参数
test/         与 src/ 同构；test/architecture/ 守 import 规则
```

## 谁能引用谁

由 `test/architecture/imports.test.ts` 强制，违反即单测失败：

1. 四个宿主模块（skills/local、skills/remote、mcp/config、mcp/runtime）互不 import，只通过外壳注入的接口协作（例如外壳把本地技能的 `SkillsLocalApi` 交给远程技能，把配置模块的 `McpConfigSource` 交给运行时）；
2. 宿主外壳不引用客户端；客户端（功能、外壳、kit）不引用宿主代码；
3. 客户端功能之间互不 import，只用客户端外壳公开的 `api.ts` 与 `tab-props.ts`；kit 只引用 kit；
4. 契约只放类型，只引用契约，别人只能 `import type` 它（构建时擦除，浏览器产物里没有宿主代码，ADR-0002）；
5. `shared/` 与 `version.ts` 谁都能用。

## 宿主半

`platform/host/index.ts` 是入口：`shell.ts` 解析上下文、加载 DSH 自带的 MCP SDK 与 yaml（都不打包，ADR-0006 / D-A4），再按依赖顺序装载模块：**mcp-config → skills-local → skills-remote（与 skills-local 互相绑定 lock 条目）→ mcp-runtime**。每个模块独立 try/catch：任何一个失败只让它自己降级（health 里看得到原因），DSH 照常运行；mcp-runtime 不可用时 `mcp` 工具退回只会说「不可用」的桩。

路由由各模块的 `routes` 汇总，统一挂在 `/api/dsh-capability-hub/` 下，响应是 `{ ok, data }` / `{ ok: false, error }` 信封；错误码与工厂在 `shared/errors.ts`。磁盘数据都在 `~/.dsh/storages/dsh-capability-hub`，另外读写 `~/.agents/.skill-lock.json`（与 `npx skills` 兼容）。

## 客户端半

`platform/client/index.tsx` 导出 `apply`：注入样式、注册侧栏行与中央面板。面板（`panel.tsx`）同时挂载技能页与 MCP 页，切换只改 `hidden`。每个页面分三层（ADR-0005）：

- **规则**：视图模型（如 `skills/client/row.ts`「一行技能长什么样」）与状态仓库（如 `mcp/client/runtime-store.ts`、`skills/client/remote/repo-view-store.ts`、`skills/client/skills-store.ts`），不碰 React，经数据 adapter 访问宿主，单测用内存 fake；
- **数据**：`data.ts` 调 `api.get / api.post`，补成安全形状，类型来自契约；
- **组件**：JSX（ADR-0003），只订阅仓库、渲染 kit 组件、转发用户操作。

样式写在 TS 里、紧挨组件（ADR-0004）；文案在各页的 `strings.ts`。渲染效果靠 `scripts/ui-shot-pages.mjs` 的亮 / 暗截图与审计验收，不引入 DOM 测试库。

## 想改某样东西，先看哪里

| 要改的 | 位置 |
|---|---|
| 技能能不能加载、启停怎么改写 SKILL.md | `skills/local/frontmatter/`（规则在 rules.ts，改写在 toggle.ts） |
| 技能列表一行显示什么 | `skills/client/row.ts`；分组在 `tree.ts`；折叠规则在 `kit/fold.ts` |
| 仓库列表、发现、补扫规则 | 宿主 `skills/remote/repo-catalog.ts`；界面流程 `skills/client/remote/repo-view-store.ts` |
| mcp 工具的某个动作 | `mcp/runtime/actions/`；冷却规则在 `failures.ts` |
| MCP 页的状态点、红点、「运行中」 | `mcp/client/runtime-store.ts`（唯一的运行状态读取处） |
| 新接口 | 宿主模块的 routes + `contract/` 里的形状 + 客户端 `data.ts` |

决策：产品决策在 [DECISIONS.md](DECISIONS.md)，架构决策在 [adr/](adr/)。
