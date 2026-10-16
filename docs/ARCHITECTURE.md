# 架构（一页）

能力中心是一个 DSH 插件，分两半发布在同一个包里：**宿主半**（`lib/index.js`，跑在 DSH 进程里，提供 HTTP 路由，并把 MCP 工具注册给模型）与**客户端半**（`lib/client.js`，跑在 DSH 的网页界面里）。源码按**功能**切片，每个功能下再分宿主、客户端与两者共用的契约（ADR-0001）。

```
src/
  platform/   外壳
    host/       组装五个宿主模块、接 DSH（路由、MCP 工具注册、会话事件、读组合配置、加载 DSH 自带的 MCP SDK 与 yaml）
    client/     页头、两个标签、HTTP 客户端 api.ts、标签契约 tab-props.ts
    contract/   外壳 ↔ 宿主模块：HubContext、HubModule、RouteTable、HubError、FieldError
  skills/     技能
    local/      宿主·本地技能：扫描技能目录、frontmatter 判断与「只改一行」启停（frontmatter/）、回收站
    remote/     宿主·远程技能：来源记录（lock）、仓库列表与发现（repo-catalog.ts）、浏览、安装、检查更新（按目录指纹，见 fingerprints.ts / skilltree.ts）
    client/     技能页（列表、详情、回收站）与「添加技能」仓库视图（remote/）
    contract/   local.ts、remote.ts（HTTP 形状与进程内接口）、yaml.ts（注入的 yaml 库）
  mcp/        MCP
    rules/      宿主与界面共用的纯规则：服务器字段、默认值、校验（ADR-0008）
    config/     宿主·MCP 配置：落盘、遮罩、粘贴 JSON 识别、检查启动命令
    runtime/    宿主·MCP 运行时：把服务器挂载成 DSH 官方 dsh-mcp-client 插件实例（runtime.ts，全局一份 / 按会话；envFrom 在 atoms/）
    client/     MCP 页（列表、详情抽屉、单服务器 JSON 编辑、粘贴 JSON 添加）
    contract/   config.ts、runtime.ts
  prompts/    提示词（DSH 会加载的 AGENTS.md / CLAUDE.md）
    rules/      宿主与界面共用的纯规则：候选文件名与项目根标记、同层重复判定、预算估算（ADR-0008）
    files/      宿主·提示词：发现（全局层 + 项目根到工作区各层）、查看、保存（版本冲突检测）、
                新建、停用启用、回收站；「读 DSH 的组合配置」由外壳 prompt-settings.ts 注入
    client/     提示词页（待建）
    contract/   prompts.ts（HTTP 形状）
  kit/        界面组件、样式写法（css.ts）、折叠（fold.ts）、状态仓库（store.ts）
  shared/     宿主与客户端共用的叶子工具：错误码、错误文字、请求参数；node/ 是只给宿主用的文件读写（原子写只有这一份）
test/         与 src/ 同构；test/architecture/ 守 import 规则
```

## 谁能引用谁

由 `test/architecture/imports.test.ts` 强制，违反即单测失败：

1. 五个宿主模块（skills/local、skills/remote、mcp/config、mcp/runtime、prompts/files）互不 import，只通过外壳注入的接口协作（例如外壳把本地技能的 `SkillsLocalApi` 交给远程技能，把配置模块的 `McpConfigSource` 交给运行时，把读好的提示词设置 `PromptSettings` 交给提示词模块）；
2. 宿主外壳不引用客户端；客户端（功能、外壳、kit）不引用宿主代码；
3. 客户端功能之间互不 import，只用客户端外壳公开的 `api.ts` 与 `tab-props.ts`；kit 只引用 kit；
4. 契约只放类型，只引用契约，别人只能 `import type` 它（构建时擦除，浏览器产物里没有宿主代码，ADR-0002）；
5. 规则（`<功能>/rules/`）是纯函数，只给本功能的宿主与界面用；它只引用本功能的规则、契约与 `shared/`，不 import 任何包（ADR-0008）；
6. `shared/` 与 `version.ts` 谁都能用；`shared/node/` 只给宿主用（界面、kit、规则、契约都不能引用）。

## 宿主半

`platform/host/index.ts` 是入口：`shell.ts` 解析上下文、加载 DSH 自带的官方 MCP 插件 `@deepseek-ai/dsh-mcp-client`（`mcp-client-loader.ts`）与 yaml（都不打包，ADR-0006 / ADR-0010），再按依赖顺序装载模块：**mcp-config → skills-local → skills-remote（与 skills-local 互相绑定 lock 条目）→ mcp-runtime → prompts-files**（prompts-files 不依赖任何其他功能模块，排在最后只是为了不改前面的顺序）。每个模块独立 try/catch：任何一个失败只让它自己降级（health 里看得到原因），DSH 照常运行。之后外壳接上 agent 事件（`agent-hook.ts`：按会话的服务器挂到 `agent.ctx`），再让 mcp-runtime 把全局服务器挂到插件根作用域。连接、工具注册、图片、MCP 资源、断线重连、服务器用法说明进提示词都由官方插件负责（ADR-0010）。

路由由各模块的 `routes` 汇总，统一挂在 `/api/dsh-capability-hub/` 下，响应是 `{ ok, data }` / `{ ok: false, error }` 信封；错误码与工厂在 `shared/errors.ts`。磁盘数据都在 `~/.dsh/storages/dsh-capability-hub`，另外读写 `~/.agents/.skill-lock.json`（与 `npx skills` 兼容）。

## 客户端半

`platform/client/index.tsx` 导出 `apply`：注入样式、注册侧栏行与中央面板。面板（`panel.tsx`）同时挂载技能页与 MCP 页，切换只改 `hidden`。每个页面分三层（ADR-0005）：

- **规则**：视图模型（如 `skills/client/row.ts`「一行技能长什么样」、`mcp/client/view-model.ts`）与状态仓库（技能页 `skills-store.ts`、仓库视图 `remote/repo-view-store.ts`、来源 `remote/source-flow.ts`；MCP 页 `servers-store.ts`、运行状态 `runtime-store.ts`），不碰 React，经数据 adapter 访问宿主，单测用内存 fake；
- **数据**：`data.ts` 调 `api.get / api.post`，补成安全形状，类型来自契约；接口错误的错误码与逐字段错误用 `api.ts` 的 `errorCodeOf` / `fieldErrorsOf` 解析；
- **组件**：JSX（ADR-0003），只订阅仓库、渲染 kit 组件、转发用户操作。

样式写在 TS 里、紧挨组件（ADR-0004）；文案在各页的 `strings.ts`（`t` 由 kit 的 `createTranslator` 生成）。不引入 DOM 测试库：渲染效果靠 `scripts/ui-shot-pages.mjs` 的亮 / 暗截图与审计，操作流程靠 `scripts/ui-walk-*.mjs` 在无头浏览器里真实点击。

## 想改某样东西，先看哪里

| 要改的                                           | 位置                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| DSH 从哪些目录加载技能（只读技能目录）           | `platform/host/skill-roots.ts`（读组合树在 `composition.ts`，诊断在 `diagnostics.ts`）                                              |
| 技能能不能加载、启停怎么改写 SKILL.md            | `skills/local/frontmatter/`（规则在 rules.ts，改写在 toggle.ts）                                                                    |
| 技能列表一行显示什么                             | `skills/client/row.ts`；分组在 `tree.ts`；折叠规则在 `kit/fold.ts`                                                                  |
| 仓库列表、发现、补扫规则                         | 宿主 `skills/remote/repo-catalog.ts`；界面流程 `skills/client/remote/repo-view-store.ts`                                            |
| MCP 服务器能填哪些字段、怎么校验、哪些字段已废弃 | `mcp/rules/server.ts`（宿主与界面的 JSON 编辑共用）；旧配置里的废弃字段读到即丢在 `mcp/config/schema.ts`                            |
| MCP 服务器挂在哪、什么时候挂、怎么判断连上没有   | `mcp/runtime/runtime.ts`；agent 事件在 `platform/host/agent-hook.ts`                                                                |
| MCP 页的状态点、红点                             | `mcp/client/runtime-store.ts`（唯一的运行状态读取处）；状态文字在 `view-model.ts`                                                   |
| MCP 页的启停、排序、删除、重新连接、保存后的提示 | `mcp/client/servers-store.ts`；JSON 编辑在 `json.tsx` 与 `json-model.ts`，粘贴添加在 `intake/`                                      |
| 技能「来源」的手动登记                           | `skills/client/remote/source-flow.ts`                                                                                               |
| 检查更新怎么判断「有没有更新」                   | `skills/remote/updates.ts`（比目录指纹）+ `skills/remote/skilltree.ts`（trees + raw，回退 tar.gz）+ `skills/remote/fingerprints.ts` |
| GitHub 镜像（前缀式，只用于下载）                | `skills/remote/settings.ts`（校验与落盘）+ `skills/remote/github.ts`（applyMirror / downloadRequest）                               |
| DSH 会加载哪些提示词、提示词怎么编辑/启停         | 宿主 `prompts/files/`（发现在 `discover.ts`，读写在 `api.ts`）；候选名与预算规则在 `prompts/rules/`；读 DSH 组合配置在 `platform/host/prompt-settings.ts` |
| 新接口                                           | 宿主模块的 routes + `contract/` 里的形状 + 客户端 `data.ts`                                                                         |

决策：产品决策在 [DECISIONS.md](DECISIONS.md)，架构决策在 [adr/](adr/)。
