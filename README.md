# dsh-capability-hub（能力中心）

A plugin for DeepSeek Harness (DSH) that puts three things in one page: **prompts** (the AGENTS.md
files DSH loads), **skills** (browse / toggle / install / update), and **MCP servers** (JSON config;
DSH's official `@deepseek-ai/dsh-mcp-client` plugin does the connecting and registers every tool as
`mcp__<server>__<tool>`).
The UI is Chinese-only. Runs locally; interfaces sit behind DSH's own `/api` authentication.
Licensed under the MIT License.

---

## 这是什么

「能力中心」是 DSH 的一个插件，把三件平时要靠手改文件完成的事收进一个页面。标签顺序是
**提示词 / 技能 / MCP**，默认打开「提示词」。

### 提示词（0.8.0 起）
管理 DSH 会加载的 `AGENTS.md` / `CLAUDE.md` 一类文件：全局 `~/.dsh` 一份，加上当前会话工作区
从项目根到工作区每一层。

- 查看、编辑（保存前旧内容进插件回收站）、新建 `AGENTS.md`（全局 / 项目根 / 当前工作区）；
- 停用 / 启用（原地改成 `AGENTS.md.disabled`，有确认；**不做删除**）；
- 显示 DSH 的提示词预算（约 x KB / 64 KB），超出会提示「DSH 会省略 / 截断」；
- 回收站：恢复、彻底删除、清空；文件被别处改过时保存会 409，绝不覆盖别人的改动。

### 技能（Skills）
只读查看与管理 DSH 的技能，不编辑技能内容、不新建技能。

- 按层级（DSH 内置 / 用户级 / 项目级）与来源仓库两级折叠浏览，可按技能目录筛选与搜索；
- 只读查看、启用 / 停用（改 `disable-model-invocation` 那一行）、删除（进回收站，可恢复）、体检；
- 检查更新（比 GitHub 目录指纹）与更新；支持前缀式 GitHub 镜像（只用于下载）；
- 「添加技能」是仓库视图：维护仓库列表（可设分支与子目录），汇总发现后勾选安装；也能搜 skills.sh；
- 默认装到 `~/.agents/skills`，可选装到当前项目；来源记录写 `~/.agents/.skill-lock.json`（与 `npx skills` v3 兼容）。

### MCP 服务器
- 配置只走 JSON：粘贴 JSON 添加（预览、同名冲突与改名建议）、单服务器 JSON 编辑（废弃字段会被拦下）；
- 启停、拖拽排序、显示配置文件、启动命令存在性检查；`env` / `headers` 默认打码，显式「显示」才给明文；
- **从 Official Registry 搜索**（0.9.0）：直接搜
  [registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io)（只读接口、不用令牌），
  预览生成的配置、填好必填环境变量后保存；远程 `streamable-http` 优先，其次 npm / pypi / oci，
  只有 SSE 或只有 mcpb 的会说明原因；
- **进程归属**（0.9.3）：详情抽屉里可直接在「全局一份（默认）/ 按会话」之间切换，切换即保存；
- **连接**由 DSH 官方 MCP 插件负责，每台服务器可选全局一份或每个会话各一份；**连不上时页面顶部有一条失败提示**，
  完整信息看 `GET /api/dsh-capability-hub/health` 的 `mcpServers`（与 `boot.json`），要重试就重启 DSH。
  MCP 页不显示运行状态（0.9.0 起没有状态点、工具数、工具清单与「重新连接」）。

插件是「永不失败外壳」：每个功能模块独立加载，任何一个出问题只降级并给出原因，
不影响其余模块，也不会让 `dsh web` 启动失败。

## 界面

三个标签，下划线式：**提示词 / 技能 / MCP**，默认落在「提示词」。每页的界面规格与设计原则见
[docs/UI-DESIGN.md](docs/UI-DESIGN.md)；想在本地看效果，按 [docs/DEV.md](docs/DEV.md) 在测试 profile
里跑一遍（截图脚本 `scripts/ui-shot-pages.mjs` 会输出亮 / 暗两套）。

## 安装与升级

需要 DSH 0.2.x（Windows；0.9.x 在 DSH 0.2.1-rc.2 上实测，npm 最新版本是 0.9.3）。

1. 打开 DSH 的**插件**页 → **添加插件** → 在输入框里填包名 `dsh-capability-hub` → **安装**。
2. 在「已安装」那一行点**立即启用**。
   （安装 ≠ 启用：只安装不启用时插件不会加载，接口是 404。）
3. 升级：在插件页安装新版本后需要**重启 DSH**，新代码才会加载。替换已加载的包是官方文档里
   唯一要求重启的场景；平时的启用/停用是热生效的。升级不会动插件数据——
   `~/.dsh/storages/dsh-capability-hub` 下的 MCP 配置、技能来源记录、镜像设置与回收站都保留。

离线或想固定版本时，也可以直接装 `.tgz`：

- 从 [Releases](https://github.com/Anuii/dsh-capability-hub/releases) 下载 `dsh-capability-hub-<版本>.tgz`；
  或自行打包（见 [docs/DEV.md](docs/DEV.md) 的「打包」一节）：`pwsh -NoProfile -File scripts\pack.ps1`
- 插件页 → **添加插件** → 粘贴 `.tgz` 的**绝对路径** → **安装** → **立即启用**。

详细步骤、测试 profile 的搭法、以及升级时容易踩的坑，见 [docs/DEV.md](docs/DEV.md)。

## 数据位置

插件只读写下面这些位置（都是 DSH 自己的惯例路径，插件不另立门户）：

| 路径 | 内容 |
|---|---|
| `~/.agents/skills` | 用户级技能目录（默认安装目标） |
| `~/.agents/.skill-lock.json` | 技能来源记录，与 `npx skills` v3 兼容（不改 version、保留他人条目与未知字段） |
| `~/.dsh/skills` | DSH 自己的用户级技能目录 |
| `~/.dsh/storages/dsh-capability-hub` | 插件自己的数据：MCP 配置、技能与提示词回收站、镜像设置、启动报告 `boot.json` |
| `<当前会话工作区>/.agents/skills`、`<当前会话工作区>/.dsh/skills` | 项目级技能目录（只显示当前会话的工作区） |
| `~/.dsh/AGENTS.md` 与项目里各层的 `AGENTS.md` / `CLAUDE.md` | 提示词页读写的就是这些文件（DSH 会加载的那一份） |

MCP 配置存在插件数据目录下，所有 profile 共用一份；插件**不会**去改任何 profile 的
`package.json` 或 cordis 配置。

## 安全说明

- **接口鉴权**：所有 HTTP 接口都注册在 DSH 的 `ctx.connection.fetch` 上，挂在 `/api` 前缀之后，
  因此完全继承 DSH 自己的认证闸（launch token → 签名 cookie）与 Host/Origin 信任检查。
  插件不额外开一条无鉴权的通道。
- **GitHub 令牌**：检查更新 / 从 GitHub 安装时按 `GITHUB_TOKEN` → `gh auth token` → 匿名
  的顺序取凭据。令牌只放在请求头里，不出进程、不落盘；接口返回的凭据状态只有 `mode`
  （`env` / `gh` / `anonymous`）。
- **敏感值**：MCP 服务器的 `env` 与 `headers` 值默认在界面上遮罩，接口默认也只下发打码后的形式，
  显式点「显示」才返回明文。
- **删除**：技能删除是移入插件回收站（可恢复、可手动清空），不是直接抹掉；提示词不做删除，
  「停用」只是原地改名成 `.disabled`，随时可改回来。
- 插件只写上面列出的那些目录；对 Claude Code / Codex 的配置只读。

## 发布（维护者）

发布由维护者明确指示后触发。流程：改版本号 → 提交 → 推 `v<版本>` tag →
GitHub Actions（`.github/workflows/publish.yml`）用 **npm Trusted Publishing（OIDC）** 自动发布，
带 provenance，不需要本地 2FA、不保存任何长期 token。

> npm 包的 Trusted publishing 设置里必须允许 `npm publish` 权限，否则 workflow 会在发布那一步
> 拿到 E404（前面的构建与 provenance 都会成功，很容易误判）。

## 开发

- 整体结构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；架构决策：[docs/adr/](docs/adr/)
- 环境、构建、类型检查、测试、打包、测试 profile、客户端热同步：[docs/DEV.md](docs/DEV.md)
- 写客户端界面（标签页、kit、宿主组件约定）：[docs/CLIENT-GUIDE.md](docs/CLIENT-GUIDE.md)
- 宿主 UI 组件与主题变量参考：[docs/PRIMITIVES.md](docs/PRIMITIVES.md)
- 设计决策记录（代码注释里的 `D-xx` 指向这里）：[docs/DECISIONS.md](docs/DECISIONS.md)
- 界面设计规范：[docs/UI-DESIGN.md](docs/UI-DESIGN.md)；术语表：[GLOSSARY.md](GLOSSARY.md)
- 给编程代理的约定：[AGENTS.md](AGENTS.md)

## 目录结构

    build.mjs              esbuild 构建脚本（种子模块 / 外置清单）
    cordis.patch.yml       插件交给 DSH 的装配声明（只 insert，不写 config）
    .github/workflows/     发布（推 v* tag → GitHub Actions 用 Trusted Publishing 发 npm）
    scripts/               打包、测试 profile 启停与 link 暂存、客户端热同步、接口冒烟、走查与截图
    src/skills/            技能：local/、remote/（宿主）、client/（技能页与仓库视图）、rules/、contract/
    src/mcp/               MCP：config/、runtime/（宿主：挂载官方 MCP 插件）、registry/（Official Registry 代理）、client/（MCP 页）、rules/、contract/
    src/prompts/           提示词：files/（宿主：发现、读写、回收站）、client/（提示词页）、rules/、contract/
    src/platform/          外壳：host/（组装模块、接 DSH）、client/（页头、标签、HTTP 客户端）、contract/
    src/kit/               界面组件、样式写法、折叠、状态仓库
    src/shared/            宿主与客户端共用的叶子工具（错误码、错误文字、请求参数）
    test/                  与 src/ 同构的 node:test 单测 + 架构规则 + 夹具
    docs/                  架构、开发指南、客户端指南、宿主 primitives 参考、产品决策、架构决策（adr/）、界面规范

## 许可证

本项目以 [MIT 许可证](LICENSE) 发布。
