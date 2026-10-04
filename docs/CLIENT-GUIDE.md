# CLIENT-GUIDE — 怎么写一个能力中心的标签页

面向「拿到任务就要写技能页 / MCP 页 / 运行态页」的人。读完这份就能动手，不用翻 DSH 源码。
（文中用「」标注代码标识符。）

---

## 1. 客户端半的产物形态（先知道自己在什么环境里跑）

我们的客户端产物 lib\client.js 不是普通 ESM，而是 DSH 的「懒加载 CJS 工厂」：

    window.__ModuleLoader__.load({
      id: "dsh-capability-hub",
      factory: (require) => { var exports = {}; ...; exports.apply = apply; return exports; }
    });

- 宿主用经典 script 标签投递它，执行时必须调用 window.__ModuleLoader__.load 注册自己；
- 工厂里的 require **只能**解析两类东西：平台种子模块表，以及 package.json 里
  dsh.client.inject 声明过的动态包。种子表是**带前缀的完整包名**（权威清单 = build.mjs 的
  SEED_MODULES；「写简写会在运行期解析失败」已在 docs/PRIMITIVES.md 里核实）：
  `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
  宿主 UI 组件库/主题变量的可用清单见 **docs/PRIMITIVES.md**（唯一权威）。
- 因此 React 必须外置，esbuild 里由 build.mjs 的 CLIENT_EXTERNALS 保证；
- 导出面是 { apply, inject }，apply(ctx) 里做注册，inject 声明必需的客户端服务。

这些都由 build.mjs + scripts\client-wrapper.mjs 处理好，你写源码时**不需要**关心封装。

---

## 2. 目录与职责

    src\client\index.tsx              入口，只导出 inject 与 apply
    src\client\shell\applier.ts       装配：样式、字典、会话源、各 slot 注册（永不失败）
    src\client\shell\page.tsx         侧栏行 + 中央面板（main slot）注册
    src\client\shell\panel.tsx        页面本体：三标签 + 默认折叠的「诊断信息」卡片（标签页作者的样板）
    src\client\shell\config-button.tsx 插件管理页那一行的「配置」入口
    src\client\shell\api.ts           API 客户端（信封、错误、鉴权说明）
    src\client\shell\styles.ts        class 名与 <style> 注入
    src\client\shell\strings.ts       中英字典 + t()
    src\client\shell\useCurrentWorkspace.ts  当前工作区 / 当前会话

---

## 3. 写一个标签页（五步）

> **动手写界面之前先读第 10 节「kit 使用说明」**：列表、工具栏、抽屉、
> 标记、横幅、空状态、骨架屏都由 `src\client\shell\kit\` 提供，标签页**只通过 kit 拼界面**，
> 不要再自己写一遍这些样式（否则三个标签又会各长一套样子）。

**第 1 步：在**你自己标签页的目录**下写组件**（不要在 shell 里堆）：

    src\client\skills\    ← 技能标签（入口 index.tsx 导出 SkillsTab，字典 strings.ts）
    src\client\mcp\       ← MCP 服务器标签（入口 index.tsx 导出 McpTab）
    src\client\runtime\   ← 运行态标签（入口 index.tsx 导出 RuntimeTab）

每个标签页**自带一份 strings.ts**（key 前缀用 skills.* / mcp.* / runtime.*，互不打扰），
外壳的 src\client\shell\strings.ts 只放外壳自己的文案（页面标题、标签名、环境卡片）。
组件里取字典就走自己目录那一份（例如 `import { t } from "./strings.ts"`）。

界面**只做中文**（D-A3）：标签页字典不需要 en 镜像，只写 zh 即可
（外壳字典是历史形态，保持 zh+en 不动）。

组件长这样（占位版就是仓库里的现成样板）：

    import * as React from "react";
    import { api } from "./api.ts";
    import { t } from "./strings.ts";
    import { styles } from "./styles.ts";

    export function SkillsTab(): React.ReactElement {
      const [rows, setRows] = React.useState<unknown[] | undefined>(undefined);
      const [error, setError] = React.useState<string | undefined>(undefined);
      React.useEffect(() => {
        void api.get("skills/list").then(
          (data) => setRows((data as { items?: unknown[] }).items ?? []),
          (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
        );
      }, []);
      if (error !== undefined) return React.createElement("p", { className: styles.error }, t("env.failed", { message: error }));
      if (rows === undefined) return React.createElement("p", { className: styles.muted }, t("env.loading"));
      return React.createElement("ul", { className: styles.kv }, rows.map((row, index) => React.createElement("li", { key: index }, JSON.stringify(row))));
    }

### 2.5 标签页的 props 接口（TabProps）

定义在 `src\client\shell\tab-props.ts`，**形状已经冻结**
（只能加可选字段，不能改已有字段的语义）：

    /** 三个标签的 id。 */
    export type PanelTab = "skills" | "mcp" | "runtime";

    /** 标签页组件收到的 props（panel.tsx 传给它引入的每一个标签组件）。 */
    export interface TabProps {
      /** 当前会话的工作区绝对路径；取不到时 undefined。 */
      workspace: string | undefined;
      /** 当前会话 id；取不到时 undefined。 */
      sessionId?: string;
      /** 切换到另一个标签页（标签之间互相跳转用）。 */
      openTab(tab: PanelTab): void;
    }

用法（组件可以只声明自己用得到的字段，多余的会被忽略）：

    import type { TabProps } from "../shell/tab-props.ts";
    export function SkillsTab(props: TabProps): React.ReactElement { ... }

- `workspace` 来自 slot 标准 prop `useSessions`（见第 4 节），技能页拿它找项目级技能根；
- `sessionId` 来自同一份快照，运行态页按会话过滤实例时用；
- `openTab` 是外壳的切标签回调，稳定可调用（例如「保存成功 → 去看运行态」）。

**硬性规则**

- 只能用 React.createElement（构建走 esbuild 的 classic JSX transform，写 JSX 也可以，
  但现有文件统一用 createElement，保持一致）；
- 所有用户可见文案走自己目录的 t("key")，key 一律写在自己那份 strings.ts 里（只写中文）；
- 只用 node: 之外没有的限制：组件里不要引入任何第三方库（运行时零依赖）；
- 组件不得 throw：错误自己 catch 成 UI 状态。

**第 2 步：什么都不用改**。panel.tsx 已经按固定入口引入三个组件：

    import { SkillsTab } from "../skills/index.tsx";
    import { McpTab } from "../mcp/index.tsx";
    import { RuntimeTab } from "../runtime/index.tsx";
    ...
    tab === "skills" ? SkillsTab : tab === "mcp" ? McpTab : RuntimeTab

所以你只要保证 `src\client\<你的目录>\index.tsx` **导出同名组件**即可，
外壳会用 `TabProps`（见第 2.5 节）调用它。

**第 3 步：如果你的标签要多条接口**，直接照 PLAN §3.1 的路由键在宿主侧加实现，
客户端只用 api.get / api.post，路径不带前导斜杠（见第 5 节）。

**第 4 步：构建**

    node build.mjs

**第 5 步：看效果**

    pwsh -NoProfile -File scripts\dev-profile.ps1 restart
    node scripts\ui-shot.mjs --out <工作区根>\.dev\shots

浏览器产物有 rev 校验（脚本按文件 mtime/size 算 rev），改完 build 后浏览器刷新即可拿到新产物；
拿不到就 restart 一次。

---

## 4. 你能拿到什么（服务与标准 props）

- **不要**指望客户端 ctx 上有「sessions」「workspace」这类服务：实测 ctx.get("sessions") 是
  undefined（客户端诊断里永远报 sessions: 服务缺失）。
- **要**从 slot 的标准 props 拿数据。我们在 page.tsx 注册的组件会收到 owner 注入的一组 props：

  | prop | 用途 |
  |---|---|
  | useSessions | 会话列表快照选择器钩子（当前工作区就是从它取 cwd） |
  | useWorkspaces | 工作区列表 |
  | usePanelInfo | 当前面板信息 |
  | useResource | 资源读取 |

  典型用法（panel.tsx 的 EnvCard 就是这么写的）：

      const workspace = useCurrentWorkspace(props.useSessions);

- ctx.get("layout") 可以用来切换面板（page.tsx 的 openCapabilityHub 用它直达某个标签）；
  拿不到时退化为「只切标签、不切面板」。
- ctx.locale.register(NS, { zh, en }) 注册字典，ctx.locale.bind(NS) 拿运行期翻译。

---

## 5. API 客户端

    import { api, ApiError } from "./api.ts";
    const data = await api.get<{ items: Row[] }>("skills/list", { query: "x" });
    await api.post("skills/remove", { name: "foo" });

约定：

- 路径**文档相对**（不带前导 /），前缀固定 api/dsh-capability-hub/；
- 服务端统一信封 { ok: true, data } / { ok: false, error: { code, message, details } }，
  api 客户端负责解信封并把 error 抛成 ApiError（带 code/details）；
- 401 会被翻译成「未通过 DSH 的浏览器鉴权」；
- 鉴权由 DSH 负责：接口挂在 /api 之下，继承签名 cookie（SameSite=Strict + HttpOnly），
  同源 fetch 自动带上，你什么都不用做。

---

## 6. 字典与样式

- 字典：strings.ts 的 zh 是 key 的权威来源，en 镜像；加 key 时两边都加。
  运行期语言切换由 apply() 里 setRuntimeTranslate(locale.bind(NS)) 接上，纯 DOM 文案也会跟着变。
- 样式：styles.ts 里集中写 class 名，用 injectStyles() 一次性插 <style>。
  颜色/间距一律用主题 CSS 变量（var(--dsh-...)），不要写死颜色，否则暗色/亮色主题会崩。
  页面根节点带 data-dsh-capability-hub-view 属性，方便写作用域选择器。

---

## 7. 注册入口（三种）

| 位置 | 怎么做 | 备注 |
|---|---|---|
| 侧栏行 + 中央面板 | page.tsx 的 registerCapabilityHubPanel（sidebar.panellist + main） | main 是 keyed，key = capability-hub |
| 插件管理页那一行的「配置」 | config-button.tsx 的 registerRowConfig（plugins.row.config） | key = 「dsh-capability-hub#capability-hub」，格式是 <包名>#<行 id> |
| 别的 slot | 一律用 ctx.slots.inject(name, () => ctx.slots.register(...)) | owner 还没出现时 inject 会等，不要直接 register |

注册一律返回 disposer，并挂进 ctx.effect 统一回收（applier.ts 已经这么做）。

---

## 8. 诊断

页面控制台：

    globalThis.__dshCapabilityHubDiagnostics()   // { steps, errors }

- steps 列出了成功的装配步骤；errors 列出缺失的服务或失败的步骤。
- 客户端任何一步失败都只 warn + 记 errors，绝不让整页崩（这是硬约束）。

---

## 10. kit 使用说明（标签页只通过 kit 拼界面）

### 10.1 这是什么、为什么必须用

`src\client\shell\kit\` 是三个标签页共用的 UI 组件层，实现的是这套界面的视觉规范：
安静、一处一事、只在需要时出现、一个强调色。

它替你做了三件容易做砸的事：

1. **视觉一致**：间距 4/8/12/16/24、圆角 10/6、行高 52、字号 18/14/12.5/12/11 全部是
   token（`--chk-*`），颜色只引用 `--dsw-*` 主题变量 —— 暗色主题自动适配；
2. **无障碍**：行可 Tab 聚焦、Enter 打开；抽屉有焦点陷阱、Esc 关闭、关闭后焦点归还；
   尊重 `prefers-reduced-motion`；
3. **不用记宿主 primitives 的坑**（比如 `Switch.label` 必填、`Modal` 的 Escape 归属）。

**规则**：标签页里凡是「列表 / 工具栏 / 抽屉 / 标记 / 状态点 / 横幅 / 空状态 / 骨架屏 /
详情小节 / 键值表」，一律用 kit 的组件；需要新形态就往 kit 里加，
不要在标签页里复制粘贴一份。

    import {
      Toolbar, ListSurface, ListGroup, ListRow,
      Badge, Drawer, Section, KeyValue,
      Banner, EmptyState, SkeletonRows, MoreMenu, MenuItem,
    } from "../shell/kit/index.ts";

kit 的 CSS 由外壳的 `apply()` 统一注入（`injectKitStyles`，一整张 `<style>`，
类名前缀 `chk_`），标签页**什么都不用做**。

### 10.2 五分钟上手

一个「搜 + 筛 + 列表 + 抽屉」的标签页长这样：

    import * as React from "react";
    import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
    import {
      Badge, Drawer, KeyValue, ListGroup, ListRow, ListSurface, Section, Toolbar, kit,
    } from "../shell/kit/index.ts";
    import type { TabProps } from "../shell/tab-props.ts";

    export function McpTab(props: TabProps): React.ReactElement {
      const [query, setQuery] = React.useState("");
      const [filter, setFilter] = React.useState("all");
      const [openId, setOpenId] = React.useState<string | undefined>(undefined);
      const servers = useServers();                       // 你自己的数据
      const counts = { all: servers.length, enabled: servers.filter((s) => s.enabled).length };

      return React.createElement(React.Fragment, null,
        React.createElement(Toolbar, {
          search: { value: query, onChange: setQuery, placeholder: "搜索服务器" },
          filters: {
            value: filter,
            onChange: setFilter,
            items: [
              { id: "all", label: "全部", count: counts.all },
              { id: "enabled", label: "已启用", count: counts.enabled },
            ],
          },
          primary: { label: "添加服务器", menu: [{ id: "json", label: "粘贴 JSON", onClick: openJson }] },
          more: [{ id: "settings", label: "全局设置", onClick: openSettings }],
        }),
        React.createElement(ListSurface, null,
          React.createElement(ListGroup, { title: "服务器", meta: "~/.dsh/mcp.json", count: servers.length },
            servers.map((server) => React.createElement(ListRow, {
              key: server.id,
              testId: "mcp-row-" + server.id,
              title: server.name,
              subtitle: server.command,
              subtitleMono: true,
              leading: server.failing ? "failed" : "idle",     // StatusTone
              badges: server.failing ? [React.createElement(Badge, { tone: "danger", key: "e" }, "连接失败")] : [],
              trailing: React.createElement(Switch, {
                checked: server.enabled, label: server.name,
                onChange: (next) => setEnabled(server.id, next),
              }),
              hoverActions: [{ label: "刷新缓存", onClick: () => refresh(server.id) }],
              onOpen: () => setOpenId(server.id),
            })))),
        React.createElement(Drawer, {
          open: openId !== undefined,
          title: openId ?? "",
          subtitle: "~/.dsh/mcp.json",
          testId: "mcp-drawer",
          onClose: () => setOpenId(undefined),
          footer: React.createElement(React.Fragment, null,
            React.createElement("button", { type: "button", className: kit.dangerButton, onClick: remove }, "删除")),
        },
        React.createElement(Section, { title: "概览" },
          React.createElement(KeyValue, { items: [
            { label: "transport", value: "stdio" },
            { label: "命令", value: server.command, mono: true },
          ] }))));
    }

### 10.3 组件与 props（全量）

**`Toolbar({ search?, filters?, primary?, more?, start?, end?, testId? })`**
一行工具栏：`start` · 搜索 · 筛选分段 ·〔弹性空白〕· `end` · 主按钮 · `⋯`。

| 字段 | 说明 |
|---|---|
| `search` | `{ value, onChange(value), placeholder?, testId? }`，不传就没有搜索框 |
| `filters` | `{ items: { id, label, count? }[], value, onChange(id), label? }`；`count` 显示成后面的小数字。**分段 testid**：给了工具栏 `testId` 时是 `<testId>-filter-<id>`，否则是 `kit-filter-<id>`（三个标签同时挂载，不带前缀会撞车） |
| `primary` | `{ label, onClick, testId? }` 或 `{ label, menu: MenuItem[], testId? }`；**只有它是强调色按钮** |
| `more` | `MenuItem[]`，渲染成右侧「⋯」 |
| `start` / `end` | 两端塞自定义内容（例如运行态页的「只看当前会话」开关） |

**`MenuItem`**（`Toolbar.primary.menu` / `Toolbar.more` / `MoreMenu.items` 通用）：
`{ id?, label, hint?, onClick?, danger?, disabled?, separatorBefore?, info?, testId? }`。
`info: true` 渲染成不可点的只读信息行（例如「GitHub：已连接 · 剩余配额 42」）。

**`ListSurface({ children, testId? })`**
列表容器，只负责纵向排列若干 `ListGroup`（间距 24）。

**`ListGroup({ title?, meta?, metaTitle?, headTitle?, count?, badges?, children, testId? })`**
分组：标题行是 12/500 次要色小字；`meta` 用等宽字体（路径 / 命令）；`badges` 放右侧
标记（例如只读根的「只读」）；`count` 是最右的数字。

- **`title` 可选**：不传时整条标题行都不渲染，只留面板外观（圆角 / 边框 / 底色）——
  只有一组时用这个（MCP 页）；
- `metaTitle` 是 `meta` 的悬停提示（默认等于 `meta`）；没有 `meta` 时用 `headTitle` 把说明挂到标题行上。

**`ListFoot({ text, action?, testId?, textTestId? })`**
列表脚注：一行次要色小字 + 一个可选的文字按钮（技能页的「另有 N 个空的技能目录 · 显示」）。
`action` = `{ label, onClick, testId?, expanded? }`，`expanded` 落到 `aria-expanded` 上。

**`ListRow({ ... })`** —— 一次只回答「这是什么、开没开」

| prop | 类型 | 说明 |
|---|---|---|
| `title` | node | 行标题（14/500 主文字色） |
| `subtitle` | node? | 副标题（12.5/400 次要色，单行截断） |
| `subtitleMono` | boolean? | 副标题用等宽（路径 / 命令） |
| `subtitleTone` | `"default"｜"danger"｜"warn"`? | 副标题语义色（失败信息用 danger） |
| `leading` | `StatusTone` 或 node? | 传 `"idle"｜"active"｜"failed"｜"cooling"` 会渲染状态点；传节点则原样渲染 |
| `badges` | node[]? | **最多显示 2 个**（多的自动截掉）。用 `Badge` 造：`tone` 取 neutral/accent/warn/danger |
| `trailing` | node? | 行尾控件（通常是一个 `Switch`）；**点它不会触发 `onOpen`** |
| `hoverActions` | `{ label, onClick, danger?, testId? }[]`? | 悬停 / 键盘聚焦时才淡入的文字按钮 |
| `dragHandle` | `true` 或 node? | 悬停时出现的拖动把手（MCP 页排序用） |
| `onOpen` | `() => void`? | 给了它就整行可点、可 Tab 聚焦、Enter 打开，行尾出现淡色「›」 |
| `selected` | boolean? | 选中态底色 |
| `testId` | string? | 挂到行根节点上 |
| `attrs` | `Record<string,string>`? | 透传到行元素的额外属性；**只放行 `data-*` 与 `aria-*`**，其余键忽略（见 `passthroughAttrs`） |

**`Badge({ children, tone?, title?, testId? })`**：小号描边胶囊，11/500。
`tone` = `neutral`（灰，默认）/ `accent`（强调，「可更新」）/ `warn`（琥珀，冷却）/
`danger`（红，不可加载）。`title` 写悬停解释（例如「被 X 遮蔽」）。

**`StatusDot({ tone, title?, testId? })`**：直径 7px 的圆点。
`tone` = `idle`（灰，默认）/ `active`（强调色，有活跃实例）/ `failed`（红，最近失败）/
`cooling`（琥珀，冷却中）。**只在 MCP 与运行态用**。

**`Drawer({ open, title, subtitle?, subtitleTitle?, headerEnd?, onClose, footer?, width?, testId?, children })`**
从右侧滑出的详情抽屉（宽 560px，窄屏 100%；`width` 可覆盖，安装抽屉用 720）。
`subtitle` **单行截断**，完整内容放进 `subtitleTitle`（省略时用 `subtitle`）——路径被缩写成 `~\…` 时就靠它给全路径。

- 头部：标题 + 等宽副标题 + `headerEnd`（通常放开关）+ 关闭按钮；`testId` 生成
  `<testId>-close` / `<testId>-mask` 两个子 testid；
- 正文：自上而下排 `Section`（间距 16，可滚动）；
- `footer`：底部固定操作区，**危险操作放最左**，用 `Button variant="ghost"` 配
  `className={kit.dangerButton}`（弱化的红色文字按钮）；右侧用 `React.createElement("span", { className: kit.drawerFootSpacer })` 顶开；
  **footer 只在有真正的操作时才传**；不要再放「关闭」按钮（头部已有 ×，Esc 也能关）；
- Esc / 点遮罩都能关，关闭后焦点回到打开它的那一行，Tab 在抽屉内部环绕。

**`Section({ title, collapsible?, defaultCollapsed?, end?, children, testId? })`**
详情里的一节。`collapsible` 时标题左边出现 12px 折角（展开时旋转 90°）并可折叠；`end` 放右侧动作
（例如「刷新」）。`testId` 生成 `<testId>-toggle`。

**`KeyValue({ items, testId? })`**，`items: { label, value, mono?, title?, testId? }[]`。
两列网格：label 次要色、value 略亮；`mono` 给路径 / 命令 / id。

**`Banner({ children, tone?, action?, testId? })`**
一条横幅，**只在需要时出现**。`tone` = `neutral` / `warn`（默认场景）/ `danger`。
`action` = `{ label, onClick, testId? }`。左侧色条表达语气。

**`EmptyState({ title, description?, action?, testId? })`**
居中空状态：一句标题 + 一句说明 + 一个按钮（`action` = `{ label, onClick, testId? }`）。

**`SkeletonRows({ rows?, testId? })`**
加载占位，默认 **6** 行灰条；**不要用转圈**。

**`MoreMenu({ items, label, testId? })`**：只想要一个「⋯」按钮时直接用。

> **菜单项的 `data-testid`**：宿主 `MenuItemButton` 不透传未知 props，所以 kit 把菜单项文字包了一层
> `<span data-testid=...>`，testid 挂在 **span** 上（点它等于点菜单项）。走查脚本按 `testId ?? id` 找它。

**`RefreshIcon({ className? })`**：刷新字形（环形箭头）。运行态页原来在自己目录里手画了一份，现已收进 kit。

**工具函数**
`countByPredicates(items, predicates)` 算分段里的 `count`；
`clampBadges(badges)`；`rowKeyDecision(key)` / `drawerKey(...)` 等键盘判定（单测覆盖）。

### 10.4 视觉规则（写界面时照着做）

- **一处一事**：一行只说「这是什么、开没开」。其他信息全部放进抽屉。
- **只在需要时出现**：标记、横幅、悬停操作只在有事时才出现；一切正常时画面上没有它们。
- **一个强调色**：只有主按钮、「可更新」标记、活跃状态点用强调色。**不用绿色**；
  红＝错误，琥珀＝冷却 / 警告。
- **不套卡片**：列表行靠 1px 最弱分隔线分隔，不要给每行加边框 / 圆角 / 阴影。
- **行高固定 52px**：有没有副标题都一样（内容垂直居中），否则一列排下来会参差。
- **行副标题的颜色**：`--chk-fg-sub`（= `color-mix(in srgb, var(--dsw-alias-label-tertiary) 85%, var(--dsw-alias-label-primary))`）。
  直接用 tertiary 在亮色下只有 3.71:1，达不到 WCAG AA 小字 4.5:1；混 15% 主文字色后亮色 4.70:1、暗色 8.30:1。
  标签页不要自己改副标题颜色，`test/client-kit/styles.test.ts` 会拦下来。
- **等宽字体用主题变量**：`--ds-font-family-code`（注意是 `--ds-` 前缀，
  不是 `--dsw-`）。kit 的 `--chk-mono` 已经指向它；不要自己写 `monospace`——
  那会在中文系统上落到中文等宽字体，字距松散、显旧。
- **开关（Switch）**：kit 已经把能力中心作用域内的宿主 `Switch` 缩到约 80%（36×20 → 29×16），
  你**不需要**做任何事；也不要自己再包一层缩放，或在 kit 之外覆盖它。
- **不写死颜色**：需要新颜色时用 `--dsw-*` 变量（见 docs\PRIMITIVES.md 第 4 节），
  写死颜色会在另一个主题里崩。`test\client-kit\styles.test.ts` 会拦下来。
- **不写常驻解释长句**：说明放 `title` 工具提示或抽屉里。

### 10.5 开发预览与自测

kit 的每一种形态都能一眼看全（截图审查用）：

    http://127.0.0.1:19411/?token=<令牌>&hubKitPreview=1

带这个参数时，能力中心正文位置会换成 kit 预览面板（工具栏、两个分组含只读标记、
10 行各种标记与状态点、悬停操作、打开的抽屉、空状态、骨架屏、横幅）。
加 `hubKitDrawer=1` 可让抽屉默认关闭。**正式使用时永远看不到它。**

改完 UI 到新界面：

    pwsh -NoProfile -File scripts\dev-sync-client.ps1     # build + 只复制 lib\client.js
    # 刷新浏览器页面

不需要重启 profile、不需要 pnpm（原理见 docs\DEV.md 的「客户端热同步」一节）。

---

## 9. 常见坑

1. 用了 ctx.get("sessions") / ctx.get("workspace") → 拿不到，用 slot 标准 props。
2. 路径写成 "/api/dsh-capability-hub/x" → 子路径部署下会逃出前缀，必须写 "x"（文档相对）。
3. 直接 import 第三方库 → 工厂 require 解析不到，运行时抛错。
4. 忘了在 dsh.client.inject 里声明要用的动态包 → require 解析失败。
   种子表里的 9 个（react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/cordis、
   @deepseek-ai/dsh-client-store、@deepseek-ai/dsh-client-ui-slots、
   @deepseek-ai/dsh-client-ui-primitives、@deepseek-ai/dsh-client-ui-dockkit）不用声明 ——
   但**必须写完整包名**，写「dsh-client-ui-slots」这类简写会在运行期解析失败（已在 docs\PRIMITIVES.md 核实）。
5. 改完不 build 就看页面 → 看到的还是旧产物。
6. 组件里 throw → 会让面板整块消失；错误要转成 UI 状态。
7. 把标签组件写进 src\client\shell → 会和外壳耦合；每个标签有自己的目录（见第 3 节）。
8. 想知道有哪些现成的宿主组件可复用 → 读 docs\PRIMITIVES.md，不要自己猜 class 名。
