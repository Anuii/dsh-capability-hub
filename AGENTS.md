# AGENTS.md

DeepSeek Harness（DSH）插件「能力中心」：技能管理、MCP 服务器管理、MCP 懒加载代理工具 `mcp`。界面与文档以中文为主。

## 先读
- 如果存在 `.local/HANDOFF.md`（本地文件，不在版本库里），先读它：里面是当前进度和使用者本机的状态。
- 术语以 [GLOSSARY.md](GLOSSARY.md) 为准；产品决策见 [docs/DECISIONS.md](docs/DECISIONS.md)，改动决策前要征得使用者同意。
- 新建文件、移动代码、跨目录 import 前读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；架构决策在 [docs/adr/](docs/adr/)，不要重新提已否决的方案。
- 改界面前读 [docs/UI-DESIGN.md](docs/UI-DESIGN.md)；构建、测试、打包、测试 profile 见 [docs/DEV.md](docs/DEV.md)；客户端写法见 [docs/CLIENT-GUIDE.md](docs/CLIENT-GUIDE.md)。

## 常用命令（仓库根，Windows PowerShell）
```powershell
node build.mjs                                  # 构建 lib/index.js 与 lib/client.js
.\node_modules\.bin\tsc.cmd --noEmit           # 类型检查，须 0 错
node --test "test/**/*.test.ts"                 # 全部单测（在线测试需 $env:RUN_LIVE='1'）
npm run format                                  # prettier 排版
pwsh -NoProfile -File scripts\pack.ps1          # 打包到 dist\（被 .gitignore 忽略）
pwsh -NoProfile -File scripts\dev-link.ps1 watch # 测试 profile 跟随源码：改客户端刷新页面，改宿主再 dev-profile.ps1 restart
```
mcp-runtime 集成测试与 YAML 对拍要在 Electron-as-node 下运行，命令见 docs/DEV.md 第 2 节。

## 硬规则
1. **`link:` 只许指向暂存目录，绝不指向源码目录**：Windows 上 pnpm 移除 link 依赖时会顺着 junction 清空目标目录。测试 profile 只用 `scripts/dev-link.ps1` 建的 link（目标是 `<profile>\.dev-link\dsh-capability-hub`，里面只有可重建的构建产物）；其他 profile（包括 Desktop）一律装 `scripts/pack.ps1` 打出的 tgz。对任何 profile 做插件或 pnpm 操作之前，先确认 `git status --short` 为空，且该 profile 的 `node_modules\dsh-capability-hub` 要么是真实目录，要么是指向上述暂存目录的链接（`dev-link.ps1 status` 会检查）；指向别处立即停手。详见 docs/DEV.md 第 4 节。
2. **使用者的真实数据只读**：`~/.agents`（含 `.skill-lock.json`）、`~/.dsh/storages/dsh-capability-hub`、`~/.claude*`、`~/.codex`。开发与走查只在隔离的测试 profile 里做，用 devOverrides 把 homeDir 指向 `.dev/home` 夹具。使用者日常用的 Desktop profile 只读，安装、升级由使用者本人在插件页完成。
3. **走查不得新建会话**：测试 profile 与 Desktop 共用 `~/.dsh` 的会话存储，新会话会出现在使用者真实的会话列表里。
4. **不按进程名杀进程**（不用 `taskkill /IM`），只清理自己启动的 PID 或占用的端口。
5. **令牌与敏感值**不打印、不落盘、不进截图。
6. **公开仓库保持干净**：提交前扫描受跟踪文件，不得出现用户名、本机绝对路径、会话 id、令牌；只对本机有意义的东西放 `.local/` 或 `.dev/`（都已忽略）。
7. **提交信息用约定式提交**（docs/DEV.md 第 12 节）。

## 写代码
- TypeScript 只用可擦除语法（无 enum、namespace、参数属性、装饰器）；相对 import 带 `.ts` 扩展名；界面用 JSX。
- 谁能 import 谁由 `test/architecture/imports.test.ts` 强制：四个宿主模块互不 import，只通过外壳注入的接口协作；客户端只能 `import type` 各功能的 `contract/`。任何模块故障只降级，不得拖垮 DSH。
- 规则写进可单测的视图模型或状态仓库（经数据 adapter 访问宿主），组件只渲染；不为测内部细节而导出函数。
- 界面文案写在各页的 `strings.ts`；颜色只用主题变量；界面用 `src/kit` 的组件拼。
- 完成的标准：tsc 0 错、全部单测通过；改界面要有亮色、暗色截图，并满足 UI-DESIGN 第 5 节。
