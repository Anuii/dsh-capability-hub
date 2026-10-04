# DEV — dsh-capability-hub 开发指南

面向第一次拿到这份源码的贡献者：怎么搭环境、构建、跑测试、打包，以及怎么在一个隔离的
测试 profile 里把插件装起来看效果。

本文只讲开发循环，不讲界面规范；界面相关的约定见 [CLIENT-GUIDE.md](CLIENT-GUIDE.md) 与
[PRIMITIVES.md](PRIMITIVES.md)，设计决策见 [DECISIONS.md](DECISIONS.md)。

文中用「」标注代码 / 文件名。**所有路径都是相对路径或 `%VAR%` 占位符**，按自己的环境替换即可。
下列环境变量在本文里使用：

| 占位符 | 含义 |
|---|---|
| `<包根>` | 本文件所在目录（`package.json` 的目录） |
| `<仓库根>` | 本仓库根目录；本地的 `dist\`（安装包）与 `.dev\`（夹具、日志、截图）也放在这里，都被 .gitignore 忽略 |
| `%LOCALAPPDATA%\Programs\DeepSeek Harness` | DSH 安装目录（默认位置） |
| `%USERPROFILE%\.dsh\profiles\<你的测试 profile>` | 测试 profile 的目录 |

---

## 1. 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10/11。宿主半用 Win32 进程树查询与 `taskkill /T /F` 收子进程，目前只有 Windows 实现 |
| DSH | 0.2.x（已安装；集成测试与部分脚本会去安装目录里找 `app.asar`） |
| Node.js | 24（自带 TypeScript 类型擦除，可以直接 `node --test "test/**/*.test.ts"`，不需要 precompile） |
| PowerShell | 7+（`pwsh`），脚本都用 `-NoProfile` 跑 |
| 可选 | Microsoft Edge（截图脚本用无头 Edge + CDP） |

自检：

    node --version      # 期望 v24.x
    pwsh -v
    npm --version

---

## 2. 构建、类型检查、测试

都在包根执行：

    node build.mjs                                     # 产出 lib\index.js 与 lib\client.js
    node node_modules/typescript/bin/tsc --noEmit      # 类型检查（等价 npm run typecheck）
    node --test "test/**/*.test.ts"                    # 全部单测（等价 npm run test）
    node --test "test/platform/**/*.test.ts"           # 只跑某一层

`lib\` 与 `node_modules\` 都在 `.gitignore` 里，是构建产物，不进版本库。构建用 esbuild：

- 宿主半 `src\host\**` → `lib\index.js`（CJS）；
- 客户端半 `src\client\**` → `lib\client.js`，由 `scripts\client-wrapper.mjs` 套进 DSH 的
  「懒加载 CJS 工厂」（`window.__ModuleLoader__.load({ id, factory })`），React 等宿主种子模块外置。

### 2.1 在线测试（可选）

`test/skills-remote/live.test.ts` 会真的访问 GitHub，默认跳过。要跑：

    $env:RUN_LIVE='1'
    node --test "test/skills-remote/live.test.ts"

没有 `RUN_LIVE=1` 时它整体 skip，不算失败。它只读公开仓库，不需要令牌；
配了 `GITHUB_TOKEN` 会走令牌（仅放在请求头里，不落盘）。

### 2.2 需要真实技能数据的测试（可选）

`test/skills-local/realdata.test.ts` 会拿一份**技能目录快照**做只读核对（技能总数、模型可见数、
CRLF 技能的启停只改一行）。快照不属于本仓库，指向你自己的副本：

    $env:CAPABILITY_HUB_REAL_SKILLS_DIR='<绝对路径>\agents-skills-snapshot'
    node --test "test/skills-local/realdata.test.ts"

- 默认位置是 `<仓库根>\.dev\snapshots\agents-skills-20261004`；
- 目录不存在（例如换一台机器）→ 自动 skip，不做任何写入；
- `CAPABILITY_HUB_TEST_REAL_DATA=0` 可以整体跳过。

测试全程只读源目录：它先复制到 `os.tmpdir()` 下的临时目录，再在副本上操作。

### 2.3 MCP 运行时集成测试（真 SDK + 真子进程）

单测用内存假 SDK 验策略（时钟可推快、失败可注入）；集成测试用
`@modelcontextprotocol/client` 的真身 + 真 stdio 子进程验「接得上、杀得掉、崩了会退避、超长会落盘」。
SDK 只存在于 DSH 的 `app.asar` 内，本机 Node 解析不到，所以必须用 Electron-as-node：

    $env:ELECTRON_RUN_AS_NODE='1'
    & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" 'test/mcp-runtime/integration/run-integration.mjs'

期望末行 `INTEGRATION-RESULT pass=35 fail=0 leftover-processes=0`。

前提与覆盖：

| 环境变量 | 用途 | 默认 |
|---|---|---|
| `T3B_NODE` | 被拉起的 MCP 服务器子进程用的 node | 依次试 `DSH_NODE` → 真正的 node → `PATH` 上的 `node`（脚本自己跑在 Electron-as-node 下，不能拿它当子进程的解释器） |
| `T3B_DSH_NODE_MODULES` | `app.asar` 内的 `node_modules` 路径 | 由 `%LOCALAPPDATA%` 推导 |

找不到 DSH 安装目录时脚本打印一行提示并以「跳过」退出（不是失败）。

### 2.4 YAML 对拍

把本插件的 frontmatter 解析结果与 DSH 自带的 YAML 解析器逐样本对比：

    node test/skills-local/yaml-parity.mjs

期望「对拍汇总 …… 25/25 一致，无差异」与「结果：全部一致」。

退出码：0 = 全部一致；1 = 有样本不一致；2 = 跳过（找不到官方 Electron 可执行文件）。
可用 `DSH_ELECTRON_EXE` 覆盖可执行文件路径。

---

## 3. 打包

    pwsh -NoProfile -File scripts\pack.ps1
    pwsh -NoProfile -File scripts\pack.ps1 -NoBuild          # 跳过构建，只重打包
    pwsh -NoProfile -File scripts\pack.ps1 -DistDir <目录>    # 换输出目录（默认 <仓库根>\dist）

脚本做四件事：校验 `package.json` 的 `files` 白名单 → `build.mjs` → `npm pack` →
列包内文件并断言没有多余的中间产物。产物 `dist\dsh-capability-hub-<版本>.tgz` 里只有
`package.json`、`lib/index.js`、`lib/client.js`、`cordis.patch.yml`。

`node` / `npm` 默认走 `PATH`，也可以用 `-Node` / `-Npm` 显式指定。

---

## 4. 在隔离的测试 profile 里试装（必读）

### 4.1 为什么要隔离

本插件是**真的会动文件**的：它会读写技能目录、写锁文件、改插件自己的配置。拿日常在用的
profile 做试验，出问题就直接落在真实用户目录上。所以开发时永远只用一个**专用测试 profile**，
并且把它的 `homeDir` 指向工作区里的夹具目录。

### 4.2 建一个测试 profile

以 `capability-hub-dev`（端口 19411）为例：

    pwsh -NoProfile -File scripts\dev-profile.ps1 start     # 后台启动，等到端口就绪才返回
    pwsh -NoProfile -File scripts\dev-profile.ps1 status
    pwsh -NoProfile -File scripts\dev-profile.ps1 restart    # 改完宿主代码用这个
    pwsh -NoProfile -File scripts\dev-profile.ps1 stop       # 停掉整棵进程树

日志在 `<仓库根>\.dev\logs\`：`dev-profile.out.log`（启动那一行带鉴权 URL）、
`dev-profile.err.log`、`dev-profile.pid`。启动行长这样：

    dsh web: http://127.0.0.1:19411/?token=<43 字符令牌>

DSH 安装路径由 `DSH_HOME`（安装目录）或 `DSH_CLI`（`app.asar` 内的 cli.js）覆盖，
默认从 `%LOCALAPPDATA%\Programs\DeepSeek Harness` 推导；profile 名与端口分别用
`-ProfileName` / `-Port` 覆盖，默认 `capability-hub-dev` / `19411`。

> 两个实现细节（脚本里已经处理，想改脚本前先读一遍）：
> 1. 启动用 `Win32_Process.Create` 而不是 `Start-Process`——后者起出来的进程仍在调用者的
>    进程树里，会让调用一直挂到子进程退出。代价是环境变量不继承，所以脚本生成一层 wrapper
>    `.cmd`，在里面设 `ELECTRON_RUN_AS_NODE=1` 并重定向日志。
> 2. 判断「在跑」要看**端口监听**，不要只看 pid 文件：wrapper `cmd` 可能在 DSH 起来后自行退出。

### 4.3 装 / 更新插件

插件在 profile 里是 **tgz 快照安装**，不是链接安装：

    pwsh -NoProfile -File scripts\pack.ps1                    # 1. 重新打包
    # 2. 用 DSH 命令行或界面「添加插件」把这个 tgz 装进测试 profile
    pwsh -NoProfile -File scripts\dev-profile.ps1 restart      # 3. 重启（换了代码必须重启）
    pwsh -NoProfile -File scripts\smoke.ps1 -Path health       # 4. 验证：期望 HTTP 200 + 模块 ok

界面路径与正式使用完全一样：侧栏「插件」→「添加插件」→ 粘贴 tgz 的**绝对路径** → 安装 →
立即启用。

> **重新打包同一个版本号时**：`file:` 依赖说明符没变，pnpm 会直接说 `Already up to date`
> 并跳过解包——即使 tgz 内容已经变了，`node_modules\dsh-capability-hub\lib\client.js`
> 还是旧的。要让新产物真的进去，先 `remove` 再 `add` 同一个 tgz，然后重启。
> 判断有没有换上的办法是比对 `lib\client.js` 与 tgz 里那一个的 SHA256。

### 4.4 两条硬规则

动手之前先做这两步检查：

1. **包根工作区干净**：`git status --short` 输出为空。改了源码就先提交。
2. **目标目录是真实目录**：检查
   `%USERPROFILE%\.dsh\profiles\<你的测试 profile>\node_modules\dsh-capability-hub`

       Get-Item "<上面的路径>" -Force | Select-Object Attributes, LinkType, Target

   `LinkType` / `Target` 有值（Junction / SymbolicLink）→ **立刻停手**。
   空白（`Directory`）或目录不存在，才可以继续。

`scripts\dev-sync-client.ps1` 内置了第 2 条检查，任何一条不满足就直接退出报错。

### 4.5 绝不要用 `link:` 依赖本仓库

不要在任何 profile 里把本插件配成 `link:`（或 `file:` 指向源码目录）的依赖。
装了插件之后再执行安装 / 卸载，包管理器会删除 `node_modules\dsh-capability-hub`；如果那是一个
指向源码目录的 junction，Windows 上的递归删除会**顺着链接把源码目录整个清空**。

预演这类操作时，只用「从来没有 link 过源码」的 profile，并且先做 4.4 的两步检查。

### 4.6 装好之后长什么样

- profile 的 `package.json` 里 `dependencies` 是本插件的 tgz 说明符（**不是** `link:`），
  `node_modules\dsh-capability-hub` 是从 tgz 解出来的真实目录；
- 只安装不启用：依赖在、目录也在，但 `dsh.profile.bundles` 里没有它 → 插件不加载，
  `GET health` 404。这就是「安装 ≠ 启用」；
- **启用是热生效的**：已打开的页面不用刷新，侧栏当场出现「能力中心」；
- 例外：**替换已加载的包**（升级）后必须重启才能加载新代码。

---

## 5. devOverrides（只在测试 profile 里用）

包内 `cordis.patch.yml` **只 insert 条目不写任何 config**，它会装进任何 profile（包括桌面版）。
所以开发期的覆盖一律写在**测试 profile 自己的** `cordis.patch.yml` 里，按 id 覆盖：

    - id: capability-hub
      config:
        devOverrides:
          enabled: true
          homeDir: '<仓库根>/.dev/home'   # 把 homeDir 钉到夹具，别动真实用户目录
          failureDemo: false                # true = 打开两个「故意失败」的演示模块
          failModules: []                   # 例如 ['mcp-config'] = 强制该模块装载失败

- `homeDir`：把 `~/.agents`、`~/.dsh` 换成一个可随时删掉的夹具目录；
- `failureDemo` / `failModules`：验证「永不失败外壳」的降级链——每个功能模块独立 try/catch，
  失败只降级不影响其余模块。改完 `restart`，再用 `scripts\smoke.ps1 -Path health` 看效果。
  期望：目标模块 `degraded` 且带中文原因，**依赖它的下游也 degraded**，其余模块与 DSH 不受影响；
  `tool.description` 退回桩实现并写明原因（`wiring.runtimeSource = "stub"`）。
  验证完把两个开关改回 `false` / `[]` 再 restart。

校验合成结果：`dsh --profile <你的测试 profile> --dump-config`（会打印
「# == dsh-capability-hub, patched by ...cordis.patch.yml」与最终 config）。

---

## 6. 客户端热同步（改 UI 的日常循环）

    pwsh -NoProfile -File scripts\dev-sync-client.ps1     # build + 只复制 lib\client.js
    # 然后刷新浏览器页面

不需要重启 profile、不需要 pnpm、不需要碰插件页，进程号不变。原理：

1. 客户端产物由 `@deepseek-ai/dsh-client-modules` 以 `/plugins/<id>/client.js?rev=<rev>` 提供，
   `rev = hash(mtimeMs, ctimeMs, size)`，响应头按 rev 永久缓存；
2. 该包的 `rebuilt(id)` 是「构建变化进入依赖图」的**唯一**入口——单纯覆盖文件、没有触发
   `rebuilt`，刷新拿到的还是旧产物；
3. `@deepseek-ai/dsh-client-hmr`（Web 组合默认挂载）每 500ms 对每个 client bundle 做一次 stat
   轮询，元数据一变就调用 `rebuilt(id)`，并通过 `/plugins/events`（SSE）把新 rev 推给浏览器。

所以顺序是：**复制覆盖 → 等 ≤1 个轮询周期（脚本里等 1.2s）→ 页面刷新 → 新产物**。

脚本第 4 步会把目标文件的 mtime 顶到当前时间——这一步不是多余的：`Copy-Item` 会把源的
`LastWriteTime` 一起带过去，而 HMR 按 `(mtimeMs, ctimeMs, size)` 判断变化，元数据没变就不会
`rebuilt()`。脚本同时打印复制前后的 SHA256 与两次的进程号，用来证明「不用重启」。
`-Restart` 会在复制后顺带重启 profile，正常情况下不需要。

改宿主半（`src\host\**`）不走这条路：只 build 不会影响已安装的那一份，必须重新打包 + 覆盖安装 + 重启（见第 4 节）。

---

## 7. 调 API（browser-auth）

DSH 的 `/api` 有一道真实的认证闸：每进程随机 launch token → `GET /?token=...` 换
HttpOnly + SameSite=Strict 的签名 cookie（绑定 Host 头的 authority）。**loopback 也不豁免**，
所以裸 curl 一定 401。

一键冒烟（脚本自己从日志里取令牌）：

    pwsh -NoProfile -File scripts\smoke.ps1                        # GET health
    pwsh -NoProfile -File scripts\smoke.ps1 -Path servers -Method POST -Body '{}'

它做三步：换 cookie（期望 303）→ 带 cookie 调用（期望 200 + 信封）→ 不带 cookie 再调一次
（期望 401）。手工版：

    curl.exe -s -o NUL -c jar.txt "http://127.0.0.1:19411/?token=<令牌>"
    curl.exe -s -b jar.txt "http://127.0.0.1:19411/api/dsh-capability-hub/health"

端到端冒烟（技能 / MCP 配置 / 运行态 / health 全链路）：

    pwsh -NoProfile -File scripts\smoke-stage-b.ps1

依次跑 skills/list → skills/view → set-enabled 停用再启用（逐行 diff + SHA256 证明「除那一行外
字节不变」）→ mcp/config → upsert 一个指向 `test\mcp-runtime\fixtures\fake-mcp-server.mjs` 的
stdio 服务器 → 等自动探测把 `toolCount` 写进缓存 → mcp/runtime/refresh → health →
skills/github-auth（**只打印 mode**）→ 删掉测试服务器恢复原状。
失败以非零退出码结束，末行是 `SMOKE-STAGE-B-RESULT pass=N fail=0`。

### 路由必须注册到 `ctx.connection.fetch`

**实测结论**：webserver 的匹配是「exact 全表 → 最长 prefix → fallback」，而 DSH 自己的
Host/Origin 信任闸 + browser-auth 是 `dsh-client-connection` 注册的 **prefix `/api`** 处理器里做的。
任何插件再注册一个更长的 prefix（如 `/api/dsh-capability-hub`）都会把 `/api` 整条盖掉，
接口**完全没有鉴权**（实测：带 cookie 200，不带 cookie 也是 200）。

正确做法是 `ctx.connection.fetch.register({ path, methods, requestBody: "buffered", fetch })`
——这些 exact Fetch 路由由 `/api` 处理器在 `admit()` 之后派发，天然继承 403/401 两层门。
另外 `requestBody` 必须写 `"buffered"`，否则 bridge 会给 Request 挂流式 body，GET 直接抛
「Request with GET/HEAD method cannot have body」，表现为 HTTP 400 空响应。

### 接线状态怎么看

`GET health` 里的 `wiring` 字段：`runtimeSource`（real/stub）、`runtimeReason`、
`lockStashBound`、`runtimeStarted`、`runtimeStartError`、`notes`。启动报告
`<hubHome>/boot.json` 里还有 `skillSources.skillProviders`（技能根扫描）与
`skillSources.presetSpecs`（agent 预设里的插件声明）。

页面控制台里可以跑：

    globalThis.__dshCapabilityHubDiagnostics()

返回 `{ steps: [...], errors: [...] }`，列出客户端注册的每一步与缺失的服务。

---

## 8. 启动报告 boot.json

外壳每次启动会把一份小 JSON 覆盖写到 `<hubHome>/boot.json`（夹具下即
`.dev\home\.dsh\storages\dsh-capability-hub\boot.json`），字段：

    profileName / homeDir / dshHome / hubHome / pid / startedAt
    routes / registeredPaths / registrationError
    sdk / modules / toolRegistered / toolError
    services（逐项探测 connection、webServer、tools、loader、profileContext ... 是否可见）
    skillSources（loader 条目名 + skill 相关条目的配置）

**为什么需要它**：降级状态本来只暴露在 `GET health` 上，但「路由都没注册成功」时 health
根本不可达。`boot.json` 是唯一能自查启动结果的通道，排查插件激活问题先看它。

---

## 9. 截图与 DOM 证据（Edge headless + CDP）

    node scripts\ui-shot.mjs --out <仓库根>\.dev\shots
    node scripts\ui-shot-kit.mjs --out <仓库根>\.dev\shots\ui0

脚本自己从启动日志里取令牌，用 Edge headless + CDP 打开页面：关掉「预览版说明」模态框 →
点开侧栏「能力中心」→ 依次切三个标签（每步一张 PNG）→ 读取 DOM 事实写成 `facts.json`。
`ui-shot-kit.mjs` 额外拍 kit 预览的亮色 / 暗色 / 悬停 / 抽屉态。

两个坑：

- 带 token 的那次 GET 会 303 到 `./`，**查询串会被丢掉**（实测 `location: ./`）。
  所以脚本先用 token 换一次 cookie，之后所有导航都用不带 token 的普通 URL + 查询串；
- Edge 首次启动会有「预览版说明」模态框挡住页面，截图前要先点掉。

诊断信息只在「ⓘ」模态框里存在（默认折叠 / 关闭时 DOM 里**没有**
`[data-testid=capability-hub-env]`），读它的脚本必须先点开。三个标签是**同时挂载**的
（切换只改 `hidden`），判断可见性请读 `hidden` 属性。

默认不新建会话（要新建传 `--new-session`）：profile 与桌面版可能共用 `~/.dsh` 的会话存储，
每跑一次都会在会话列表里多一条。

---

## 10. 常用排查

| 症状 | 先看什么 |
|---|---|
| 插件没激活 / 接口 404 | `boot.json` 的 `registrationError`；`.dev\logs\dev-profile.err.log` |
| 接口 401 | cookie 没换到：确认令牌来自**当前**进程的 `out.log`（每进程随机） |
| 接口 400 空响应 | Fetch 路由漏了 `requestBody: "buffered"` |
| 接口 403 | Host/Origin 信任闸：Host 不是 loopback，或 Origin 与 Host 不一致 |
| 页面没有「能力中心」 | `globalThis.__DSH_BOOT__` 里有没有 `dsh-capability-hub`；客户端诊断 hook |
| 工具没注册 | `boot.json` 的 `toolError` |
| 改了界面没生效 | 是否 build 过；是否刷新过页面；必要时再跑一次 `dev-sync-client.ps1` |
| 改了宿主没生效 | 宿主半必须重新打包 + 覆盖安装 + 重启（第 4 节） |

---

## 11. 目录结构

    <包根>/
      build.mjs              esbuild 构建脚本（种子模块 / 外置清单都在这）
      cordis.patch.yml       插件交给 DSH 的装配声明（只 insert，不写 config）
      package.json           files 白名单 = 打包内容
      src/
        host/                宿主半：平台外壳 + skills-local / skills-remote / mcp-config / mcp-runtime
        client/              客户端半：外壳、三个标签页、共用 UI kit
      test/                  node:test 单测 + 集成测试 + 夹具
      scripts/               开发脚本：打包、测试 profile、热同步、冒烟、截图
      docs/                  开发文档、客户端指南、宿主 primitives 参考、设计决策
      lib/                   构建产物（不进版本库）

---

## 12. 提交信息

一律使用[约定式提交](https://www.conventionalcommits.org/zh-hans/)：`<类型>(<可选范围>): <描述>`，描述以中文为主，可附英文正文。

| 类型 | 用于 |
|---|---|
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 只改文档 |
| `refactor` | 不改行为的重构 |
| `test` | 只改测试 |
| `chore` | 构建、脚本、版本号等杂项 |

范围用模块名，例如 `skills-local`、`skills-remote`、`mcp-config`、`mcp-runtime`、`platform`、`ui`、`kit`。示例：`fix(skills-remote): 拒绝 tar 包内的越界路径`。

