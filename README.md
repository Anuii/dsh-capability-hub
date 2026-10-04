# dsh-capability-hub（能力中心）

A plugin for DeepSeek Harness (DSH) that manages agent skills and MCP servers
in one place: browse/toggle/install/update skills, edit and validate `mcpServers` configuration,
and expose all configured MCP servers through a single lazy-loading `mcp` proxy tool.
The UI is Chinese-only. Runs locally; interfaces sit behind DSH's own `/api` authentication.
Licensed under the MIT License.

---

## 这是什么

「能力中心」是 DSH 的一个插件，把两件平时要靠手改文件完成的事收进一个页面：

- **技能（Skills）**：浏览、只读查看、启用/停用、删除（回收站）、体检、从 GitHub 安装、
  检查更新与更新；
- **MCP 服务器**：粘贴 JSON / 表单 / 预置模板 / 从 Claude Code、Codex 只读导入，
  保存前校验，敏感值打码；
- **MCP 懒加载运行时**：只向模型注册**一个**工具 `mcp`（`search` / `describe` / `call` /
  `connect` / `instructions` / `status`），服务器进程按需启动、空闲回收，按会话隔离；
- **运行态面板**：各服务器的工具缓存、各会话的活跃实例、最近失败与退避冷却，
  可手动刷新缓存、断开实例。

插件是「永不失败外壳」：每个功能模块独立加载，任何一个出问题只降级并给出原因，
不影响其余模块，也不会让 `dsh web` 启动失败。

## 界面

截图见 Releases，或按 [docs/DEV.md](docs/DEV.md) 自行构建后在本地查看。

## 安装

需要 DSH 0.2.x（Windows）。

1. 取得 `.tgz` 安装包：
   - 从 Releases 下载 `dsh-capability-hub-<版本>.tgz`；或
   - 自行打包（见 [docs/DEV.md](docs/DEV.md) 的「打包」一节）：
     `pwsh -NoProfile -File scripts\pack.ps1`
2. 打开 DSH 的**插件**页 → **添加插件** → 粘贴 `.tgz` 的**绝对路径** → **安装**。
3. 在「已安装」那一行点**立即启用**。
   （安装 ≠ 启用：只安装不启用时插件不会加载，接口是 404。）
4. 升级：替换同名插件后需要**重启 DSH**，新代码才会加载。替换已加载的包是官方文档里
   唯一要求重启的场景；平时的启用/停用是热生效的。

详细步骤、测试 profile 的搭法、以及升级时容易踩的坑，见 [docs/DEV.md](docs/DEV.md)。

## 数据位置

插件只读写下面这些位置（都是 DSH 自己的惯例路径，插件不另立门户）：

| 路径 | 内容 |
|---|---|
| `~/.agents/skills` | 用户级技能目录（默认安装目标） |
| `~/.agents/.skill-lock.json` | 技能来源记录，与 `npx skills` v3 兼容（不改 version、保留他人条目与未知字段） |
| `~/.dsh/skills` | DSH 自己的用户级技能目录 |
| `~/.dsh/storages/dsh-capability-hub` | 插件自己的数据：MCP 配置、工具缓存、回收站、启动报告 `boot.json` |
| `<当前会话工作区>/.agents/skills`、`<当前会话工作区>/.dsh/skills` | 项目级技能目录（只显示当前会话的工作区） |

MCP 配置存在插件数据目录下，所有 profile 共用一份；插件**不会**去改任何 profile 的
`package.json` 或 cordis 配置。

## 安全说明

- **接口鉴权**：所有 HTTP 接口都注册在 DSH 的 `ctx.connection.fetch` 上，挂在 `/api` 前缀之后，
  因此完全继承 DSH 自己的认证闸（launch token → 签名 cookie）与 Host/Origin 信任检查。
  插件不额外开一条无鉴权的通道。
- **GitHub 令牌**：检查更新 / 从 GitHub 安装时会按 `GITHUB_TOKEN` → `gh auth token` → 匿名
  的顺序取凭据。令牌只放在请求头里，不出进程、不落盘；接口返回的凭据状态只有 `mode`
  （`env` / `gh` / `anonymous`）。
- **敏感值**：MCP 服务器的 `env` 与 `headers` 值默认在界面上遮罩，接口默认也只下发打码后的形式，
  显式点「显示」才返回明文。
- **删除**：技能删除是移入插件回收站（可恢复、可手动清空），不是直接抹掉。
- 插件只写上面列出的那些目录；对 Claude Code / Codex 的配置只读。

## 开发

- 环境、构建、类型检查、测试、打包、测试 profile、客户端热同步：[docs/DEV.md](docs/DEV.md)
- 写客户端界面（标签页、kit、宿主组件约定）：[docs/CLIENT-GUIDE.md](docs/CLIENT-GUIDE.md)
- 宿主 UI 组件与主题变量参考：[docs/PRIMITIVES.md](docs/PRIMITIVES.md)
- 设计决策记录（代码注释里的 `D-xx` 指向这里）：[docs/DECISIONS.md](docs/DECISIONS.md)

## 目录结构

    build.mjs              esbuild 构建脚本（种子模块 / 外置清单）
    cordis.patch.yml       插件交给 DSH 的装配声明（只 insert，不写 config）
    scripts/               打包、测试 profile 启停、客户端热同步、接口冒烟、截图
    src/host/              宿主半：平台外壳 + skills-local / skills-remote / mcp-config / mcp-runtime
    src/client/            客户端半：外壳、技能 / MCP / 运行态三个标签页、共用 UI kit
    test/                  node:test 单测 + MCP 运行时集成测试 + 夹具
    docs/                  开发指南、客户端指南、宿主 primitives 参考、设计决策

## 许可证

本项目以 [MIT 许可证](LICENSE) 发布。
