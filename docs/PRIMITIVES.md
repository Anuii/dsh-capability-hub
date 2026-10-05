# PRIMITIVES — 宿主 UI 组件与主题变量参考

> 面向 `dsh-capability-hub` 两个标签页（技能 / MCP，MCP 页底部含「运行中」区域）的作者。
> 结论来自 asar 内**已发布产物**的静态阅读（无类型声明可读，props 一律从 JSDoc 与解构签名还原）。版本：`@deepseek-ai/dsh-client-ui-primitives` 0.2.0-rc.2，DSH 0.2.0-rc.2 / Windows。

## 路径速记（下文全部用这三个别名）

| 别名 | 实际路径 |
|---|---|
| `[PRIM]` | `...\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-client-ui-primitives\lib\index.js`（12383 行，未压缩 ESM，**保留了源码 JSDoc 与 `//#region lib/types/*.js` 分块标记**） |
| `[THEME]` | `...\app.asar\dsh\node_modules\@deepseek-ai\dsh-client-ui-theme\lib\client.js`（8 张内联 CSS token 表） |
| `[3P]` | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@linxin666\dsh-client-ui-skill-explorer\lib\client.js`（现成第三方插件，只读） |

> asar 内部只能用 Electron-as-node 读：`$env:ELECTRON_RUN_AS_NODE='1'; & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" <脚本.cjs>`。另注：asar 内 **`fs.copyFileSync` 会失败**（ENOENT，走临时文件），要用 `readFileSync`+`writeFileSync`。

---

## P1 — import 说明符（已核实）

**结论：必须用带 `@deepseek-ai/` 前缀的完整包名。**

~~~js
const { Button, Input, Switch, StateDot } = require("@deepseek-ai/dsh-client-ui-primitives");
~~~

证据（三处互相印证）：

1. **宿主自己发布的 52 个客户端产物**一律用前缀形式。逐个扫描 asar 内 `@deepseek-ai/*/lib/client.js`，凡用到该包的，字符串**唯一**是 `"@deepseek-ai/dsh-client-ui-primitives"`：`dsh-client-ui-plugin-manager`、`dsh-client-ui-settings-plugins`、`dsh-client-ui-settings-subagent`、`dsh-client-ui-theme`、`dsh-client-ui-conversation` 等共 52 个文件命中，**无一处**写成无前缀的 `dsh-client-ui-primitives`。（扫描方式见本文末尾「怎么复现本文的结论」）
2. `dsh-capability-hub\build.mjs:38-40` 的 `SEED_MODULES` 逐字列出 `"@deepseek-ai/dsh-client-ui-slots"`、`"@deepseek-ai/dsh-client-ui-primitives"`、`"@deepseek-ai/dsh-client-ui-dockkit"`，并进 `CLIENT_EXTERNALS = [...SEED_MODULES, ...INJECTED_CLIENT_MODULES]`（build.mjs:51）→ esbuild 原样保留 require 写法。
   宿主加载器 `dsh-client-modules/lib/index.js:456` 定义 `window.__ModuleLoader__`，其 README:80 描述同一套 id 解析。

⚠️ **`docs\CLIENT-GUIDE.md:19` 那份清单是简写**（同一行还写着 `@deepseek-ai/cordis`），不可据此推导出无前缀写法。**以 build.mjs 与 52 个宿主产物为准。**
宿主外置、可 require 的完整清单见 `build.mjs:28-51`。

---

## P2 — 导出面（282 个，`[PRIM]:12381`）

| 类别 | 数量 | 说明 |
|---|---|---|
| `Icon*` / `PermissionIcon*` / `ReferenceIcon*` / `LinkIcon*` | 198 | 每图标两个权重变体：`*Regular`（1px 笔画）与 `*Medium`（1.3px）。尺寸用 `size` prop。fill-only 对渲染相同。 |
| 品牌 / 插画 | 9 | `FishLogo`、`BrandWordmark`、`PluginArtwork*`(5)、`GuideArtworkBrowser`、`GuideArtworkFiles` |
| 输出卡片 `*Block` | 7 | `Terminal` / `Read` / `Diff` / `Search` / `Web` / `Code` / `Json` + `Block` |
| hooks | 5 | `useAnchoredMaxHeight`、`useAnchoredPosition`、`useDismissOnOutsidePointer`、`useModalLayer`、`useCodeHighlighter` |
| 工具函数 / 常量 | 63 | `closeTopModal`、`isBehindModal`、`writeClipboard`、`relativeTime`、`fileSizeText`、`classifyFileType`、`languageForPath`、`settingsTextField` … |

**不存在 `CodeCard` 导出。** `lib\CodeCard.module.css` 存在（1690B），但导出的代码卡组件名是 **`CodeBlock`**（`[PRIM]:10769`）。同理 `ImagePreview` 未导出（`[PRIM]:11129` 有定义），对外只有 `ImageLightbox`。

---

## P3 — 重点组件 props 与最小示例

**必填 / 选填是推断值**：本包不发布 `.d.ts`（产物里 `lib/types` 目录不存在，只有 `//#region lib/types/*.js` 标记），运行时也无 PropTypes。判定依据 = JSDoc 措辞 + 解构默认值 + 宿主真实调用点。**凡推断处一律已标注。**

### Button — `[PRIM]:3208-3227`

| prop | 类型 | 必填 | 含义 |
|---|---|---|---|
| `variant` | `'primary'` / `'ghost'` / `'outline'` / `'toolbar'` | 否（默认 `'ghost'`） | 视觉族（`[PRIM]:3210`） |
| `size` | `'md'` / `'sm'` | 否（默认 `'md'`） | `md`=H36/R12，`sm`=H28/R8（`[PRIM]:3211`） |
| `icon` | ReactNode | 否 | 前置 16px 图标（`[PRIM]:3212`） |
| `className` / `children` | string / node | 否 | — |
| `...rest` | 原生 button 属性 | — | 透传；`ref` 指向原生 button |

~~~tsx
<Button variant="primary" onClick={save}>{t("save")}</Button>
~~~

### Input — `[PRIM]:3523`
props：`icon`（可选 ReactNode，前置 16px 图标）、`ref`（可选，指向原生 input；**卸载时会被清空**）、`...rest`（原生 input 属性全透传，`value` / `onChange` / `placeholder` 都靠它）。
返回的是**外层 span 包裹的原生 input**（`[PRIM]:3526`）。
~~~tsx
<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search")} />
~~~

### Checkbox — `[PRIM]:3497-3520`

| prop | 类型 | 必填 | 含义 |
|---|---|---|---|
| `checked` | boolean | **是**（受控） | 当前勾选态 |
| `onChange` | `(next:boolean)=>void` | **是（推断）** | 收到"请求的"勾选态 |
| `label` | string | **是** | 可见且无障碍的标签文案（调用方本地化） |
| `disabled` | boolean | 否（默认 false） | — |
| `title` | string | 否 | 悬停提示 |
| `className` | string | 否 | 加在 label 上 |

~~~tsx
<Checkbox checked={ack} onChange={setAck} label={t("iUnderstand")} />
~~~

### Switch — `[PRIM]:3383-3408`

| prop | 类型 | 必填 | 含义 |
|---|---|---|---|
| `checked` | boolean | **是**（完全受控） | — |
| `onChange` | `(next:boolean)=>void` | **是（推断）** | 收到请求的新状态 |
| `label` | string | **是** | 无障碍名，**必填**（README:44 "so the control cannot ship unnamed"） |
| `disabled` | boolean | 否 | 写入在途时也应由 owner 置 true |
| `title` | string | 否 | 通常解释为何被锁 |
| `className` | string | 否 | — |

尺寸 36×20；off 态滑块恒读 `--dsw-alias-switch-thumb`，两主题下都保持浅色（README:44）。
~~~tsx
<Switch checked={on} onChange={(v) => setEnabled(id, v)} label={t("enable")} disabled={busy} />
~~~

### Modal — `[PRIM]:5190-5262`

| prop | 类型 | 必填 | 含义 |
|---|---|---|---|
| `open` | boolean | **是** | 关闭时返回 `null` |
| `onClose` | `()=>void` | **是** | 应用级关闭命令、Escape、点遮罩都会调它 |
| `title` | string | **是** | 标题；**任何模式下都作为 aria-label** |
| `closeLabel` | string | **是（推断）** | 关闭按钮的无障碍文案 |
| `children` / `footer` / `description` | node / node / string | 否 | 正文 / 动作行（Cancel、Create）/ 标题下的说明句 |
| `className` / `contentClassName` | string | 否 | 卡片 / 可滚动内容区 |
| `backdropBlur` | boolean | 否（默认 true） | 主调方已自己模糊背景时设 false |
| `headless` | boolean | 否（默认 false） | 去掉默认 header/close/body 外壳；遮罩、卡片、Escape、aria-label 保留 |
| `onKeyDownCapture` / `shortcutModal` | fn / string | 否 | 嵌套对话框抢在 document Escape 前处理按键 / 命令作用域 |

**注意**：JSDoc 明确要求"**用 `data-modal-autofocus` 标记初始焦点控件，不要用 React `autoFocus`**"（`[PRIM]:5200`，README:30）。但宿主自己在 `dsh-client-ui-plugin-manager\lib\client.js:2769` 对 footer 里的 Button 用了 `autoFocus: true` —— 两处不一致，标 **未确认**，建议按 JSDoc 走。
~~~tsx
<Modal
  open={open} onClose={onClose} title={t("confirmTitle")} closeLabel={t("close")} description={t("confirmDesc")}
  footer={<Button variant="primary" data-modal-autofocus onClick={ok}>{t("ok")}</Button>}
>
  {body}
</Modal>
~~~

### Toast — `[PRIM]:6797-6882`
props：`text`（**必填**，已解析横幅文案）、`icon`（可选前置字形，`tone="success"` 时忽略）、`tone`（`'success'` 渲染绿勾，省略则图标座保留警示色调）、`actions`（`{prefix,label,onClick?}[]`——注意产物里是 `onClick`，不是 `onSelect`，`prefix` 是连接词如"或"，`label` 渲染成蓝色可点文字）、`holdMs`（默认 3000，同时驱动卸载计时与 CSS 淡出延迟）、`anchor`（横幅水平中心跟随该元素，省略则居中于视口）、`onDone`（**必填（推断）**，淡出完成后调用，**在这里卸载**）。

经 body portal 渲染；重新显示同一文案需由 owner 换 `key` 重挂载（`[PRIM]:6799-6801`）。
~~~tsx
{toast && <Toast key={seq} text={toast} holdMs={4000} onDone={() => setToast(null)} />}
~~~

### Tooltip — `[PRIM]:4647-4685`

props：`label`（可选，气泡文字；空串 = 只显示快捷键；可传 resolver，**仅在可见时求值**）、`shortcutKeys`（可选，平台格式化键帽，接在文字后）、`side`（可选，默认 `'right'`）、`align`（可选，默认 `'center'`，仅 bottom/top 有效）、`portal`（可选，默认 false；挂到 body 躲开祖先 overflow / stacking context）、`delayMs` / `focusDelayMs`（可选，默认 0）、`gap`（可选，默认 8，仅 bottom/top）、`disabled`（可选，抑制气泡但锚点渲染不变，避免重挂载打断 CSS 过渡）、`maxWidth`（可选，气泡宽度上限）、`openOnClick`（可选，默认 false；点击钉住气泡，再次点击 / Escape / Tab / 外部 pointerdown 关闭）、`children`（**必填**，单个锚点元素；它自己的 ref 会被一并转发）。

~~~tsx
<Tooltip label={t("refresh")} side="bottom">
  <Button icon={IconRefreshOutlineRegular} onClick={reload} />
</Tooltip>
~~~

### Tag — `[PRIM]:3320-3333`
`tone`（默认 `'outline'`，八种调色板；`SettingsValueField` 内部用 `'neutral'`、`SettingsSecretField` 用 `'neutral'` / `'quiet'`，见 `[PRIM]:7004,7065`）、`className`、`children`（文案由渲染点负责）。**只读。**
~~~tsx
<Tag tone="neutral">{t("overridden")}</Tag>
~~~

### Pill — `[PRIM]:3230-3248`
`active`（默认 false）、`onClick`、`className`、`children`。**给 `onClick` 时渲染 button，否则渲染静态 span** —— 这是它与 `Tag` 的核心差别（README:78：尺寸也决定用法，Pill 可坐在 24px 文本行上）。
~~~tsx
<Pill active={tab === "mcp"} onClick={() => setTab("mcp")}>{t("mcpServers")}</Pill>
~~~

### StateDot — `[PRIM]:3052-3095`

| prop | 类型 | 必填 | 含义 |
|---|---|---|---|
| `state` | `'done'` / `'warning'` / `'ongoing'` / `'error'` / `'idle'` | **是** | 绿 / 琥珀 / 旋转加载 / 红 / 中性灰 |
| `size` | number | 否 | 外径 px；`ongoing` 默认 14，实心态默认 10 |
| `appearance` | `'dot'` / `'step'` | 否（默认 `'dot'`） | `step` 用填充勾 / 空心待办圈 |
| `className` | string | 否 | — |

**`aria-hidden`**：无障碍名字由渲染点自己给（`[PRIM]:3060`）。
~~~tsx
<StateDot state="ongoing" />
~~~

### SegmentedTabs — `[PRIM]:3251-3276`（标签页首选）

| prop | 类型 | 必填 | 含义 |
|---|---|---|---|
| `items` | `{value,label,id,panelId}[]` | **是** | 非空、value 唯一、DOM id 唯一 |
| `value` | string | **是** | 必须属于 items（受控） |
| `onChange` | fn | **是** | 点击 / ←→ / Home / End |
| `label` | string | **是** | tablist 的无障碍名 |
| `className` | string | 否 | 面板由调用方自己渲染 |

真实用法（`dsh-client-ui-agent-preset\lib\client.js:724-748`）：`items[i]` 给 `id: "<guideId>-explanation-tab"` 与 `panelId`；面板 div 写 `role="tabpanel"` + `aria-labelledby={id}` + `hidden`。
~~~tsx
<SegmentedTabs
  label={t("sections")} value={page} onChange={setPage}
  items={[{ value: "skills", label: t("skills"), id: "hub-skills-tab", panelId: "hub-skills-panel" }]}
/>
~~~

### SegmentedControl — `[PRIM]:3430-3466`

props：`id`（**必填**，基础 id：每个 tab 是 `<id>-<value>`，其面板是 `<id>-<value>-panel`）、`value`（**必填**，受控选中值）、`options`（**必填**，≥2 个分段，按显示顺序）、`onChange`（**必填**，**不会**用已选中的值回调）、`label`（**必填**，tablist 无障碍名）、`disabled`（可选，锁住全部分段——面板有在途写入时用）、`className`。

与 SegmentedTabs 的分工：前者面板由 owner 经 `aria-labelledby` 指回；后者的 `items` 自带 id / panelId。README:79 另有 Pill vs SegmentedControl 的判据。

### Menu / MenuItemButton — `[PRIM]:3815-3875`（MenuItemButton）、`[PRIM]:3876-3990`（Menu）

`Menu` 关键 props（完整 JSDoc 见 `[PRIM]:3883-3911`）：
`open`（必填）、`anchor`（**必填**，触发元素，就地渲染）、`items`（数据行，默认 `[]`）、`children`（组件行，每个是 `MenuItemButton`）、`onSelect`、`onClose`、`selectedId` / `selectedIds`、`align`（默认 `'start'`）、`side`（默认 `'bottom'`）、`portal`、`closeOnPointerLeave`、`dense`、`compact`、`autoFocus`、`selection`（`'check'` 默认 / `'fill'`）、`getAnchorRect`（**portal 模式下渲染型 / 代理型锚点必须给**）、`footer`、`className`（锚点 wrapper）、`listClassName`（**唯一能穿透到 portaled 列表的样式钩子**）。

`MenuItemButton` props：`children`、`shortcut`、`icon`、`disabled`（默认 false）、`danger`（默认 false）、`separatorBefore`（默认 false）、`onSelect`。

### DisclosureRow — `[PRIM]:3150-3205`
`icon`、`title`、`open`、`expandable`、`onToggle`、`running`（默认 false）、`expandOnRowClick`、`previewChevron`（默认等于 `expandable`）、`keepContentWhenOpen`、`collapsedContent`、`children`，以及 7 个样式钩子 `className` / `rowClassName` / `contentClassName` / `contentLayoutClassName` / `leadingClassName` / `chevronClassName` / `titleClassName`。
**它是 `memo` + 浅比较**（`[PRIM]:3152`）：回调与 ReactNode 必须保持引用稳定。
README:80：它固定 24px 高、标题与内容**并排**；"名字压在描述上"的卡片是另一种布局，属于你自己写。

### JsonTree — `[PRIM]:8654`
`data`（**必填**）、`label`（无障碍名，**必填（推断）**）、`className`、`collapsedStringLines`（默认 3）、`stringWrapping`、`copyable`（默认 true）、`expandTopLevel`（默认 true）、`labels`（本地化 chrome）。
~~~tsx
<JsonTree data={server.config} label={t("config")} collapsedStringLines={3} />
~~~

### CodeBlock — `[PRIM]:10769`
`code`（**必填**）、`lang`、`streaming`、`className`、`contentRef`、`lineNumbers`（默认 false）、`showHeader`（默认 true）、`copyLabel`、`copiedLabel`、`toolbarLabels`（开启共享卡头与间距）、`wrap`。
owner 自带语言与复制工具条时设 `showHeader={false}`（README:67）。**导出名是 `CodeBlock`，不是 `CodeCard`。**

### RiskConfirmation — `[PRIM]:5269-5312`（**敏感操作确认，MCP 页会用到**）
`open`、`title`、`description`、`acknowledgeLabel`、`cancelLabel`、`closeLabel`、`confirmLabel`、`acknowledged`、`disabled`（默认 false）、`onAcknowledgedChange`、`onCancel`、`onConfirm`。
主操作在 `acknowledged` 为真前不可用（`[PRIM]:5272`）。真实调用点：`dsh-client-ui-permission-presets\lib\client.js:419-434`。
~~~tsx
<RiskConfirmation
  open={!!pending} title={t("t")} description={t("d")} acknowledgeLabel={t("ack")}
  cancelLabel={t("cancel")} closeLabel={t("close")} confirmLabel={t("confirm")}
  acknowledged={ack} onAcknowledgedChange={setAck} onCancel={close} onConfirm={() => doIt(pending)}
/>
~~~

### PathLabel — `[PRIM]:3337-3380`
`path`（**必填**）、`className`、`...attributes`（透传到外层 span）。目录弱化、文件名突出、悬停显示完整路径；放不下时左缘渐隐（README:53）。
~~~tsx
<PathLabel path="C:/Users/you/.dsh/mcp.json" />
~~~

### MarkdownText / MarkdownDelegateProvider — `[PRIM]:11789`、`[PRIM]:11034`

`MarkdownText` props：`text`（**必填**，不可信内容，已禁原始 HTML 与危险协议）、`streaming`（默认 false）、`labels`（本地化 fence 与脚注 chrome；**必须传引用稳定的对象**，否则会丢掉流式渲染缓存）、`fileMentions`（把内联 code 里的真实文件变成链接）、`pathImages`（把本地图片路径改写成可显示 URL）、`variant`（默认 `'body'`，`'compact'` 用 13px 次级排版）。

`labels` 实测形状（`dsh-client-ui-agent-preset\lib\client.js:752-765`）：
~~~js
labels: { code: { copyLabel, copiedLabel, toolbarLabels: { codeLabel, wrapLabel, unwrapLabel } }, footnotes }
~~~

`MarkdownDelegateProvider` props：`children`、`openExternalLink`、`openFile`、`fileImages`。**无 provider 也能用**（`createContext({})` 默认值，`[PRIM]:11032`），只是本地链接保持纯文本、不触发打开。
~~~tsx
<MarkdownText text={skill.description} variant="compact" />
~~~

### settings-form 四件套（`[PRIM]:6918 / 6973 / 7052 / 7166`）

> 能力中心的标签页**大概率不需要**它：它服务于"插件设置页"（Host settings 命名空间），需要 `ctx.configForms` 与 `ctx.remote`。仅当能力中心要编辑某个 settings 命名空间时才用。

`SettingsForm` props：`state`、`labels`、`children`、`onSave`、`onDiscard`。
- `state` 形状（由 `SettingsFormModel.shell()` 产出，`[PRIM]:7190-7201`）：`{ available, writable, dirty, invalid, saving, failed }`；`labels` 形状（实测 `dsh-client-ui-settings-subagent\lib\client.js:94-102`）：`{ unavailable, readOnly, saveFailed, save, saving }`
- **只在保存按钮写入**；离开页面丢弃全部草稿（卸载时调 `onDiscard`），没有丢弃控件（`[PRIM]:6903-6911`）。

`SettingsValueField` props（逐行读自 `[PRIM]:6973-7042`）：`id`、`label`、`help`（`{label, content}`）、`overridden`、`overriddenLabel`、`resetLabel`、`invalid`、`invalidLabel`、`hint`、`text`、`placeholder`、`numeric`（只提示数字键盘，**不重写用户输入**）、`disabled`、`onEdit(text)`、`onReset()`。

`SettingsSecretField` props：`id`、`label`、`stateLabel`、`configured`、`text`、`disabled`、`onEdit`、`hint`。**只写**：永远从空白开始，`autoComplete="new-password"`，空白草稿不写入（保留已存的 key）。

`SettingsFormModel`：`new SettingsFormModel(scope, specs, secrets = [])`；公开方法 `bind(project)`、`shell()`、`field(field)`、`actions()`、`dispose()`（`[PRIM]:7179 / 7190 / 7207 / 7231 / 7293`）；`settingsNumberField(field)` / `settingsTextField(field)` 造字段 spec。`scope` 来自 `ctx.configForms.get("<namespace>")`（`dsh-client-ui-settings-subagent\lib\client.js:820`）。

### 其余组件一行用途

`ConnectionIndicator`（断线 / 重试 / 恢复的行内控件，6 个 label prop 全必填，`[PRIM]:5317`）· `HoverCard`（可停留选取的悬停预览，`anchor` / `content` 必填，`[PRIM]:4899`）· `TextShimmer`（行内高亮扫光，`children` / `active`，装饰分隔符需 `data-shimmer-decoration`，`[PRIM]:3108`）· `ShortcutKeys`（`keys`、`variant` 默认 `'plain'`，`[PRIM]:3758`）· `MenuSurface`（菜单材质底板，`compact` / `className` / `style`，`[PRIM]:3775`）· `MenuGroup`（`label` + `children`，配 `observeStickyMenuGroups(viewport)`，`[PRIM]:4278 / 4306`）· `FileTypeIcon`（`classifyFileType` / `fileExtension` 的 28px 彩色字形，颜色可用 `--dsh-file-type-icon-color` 覆盖，`[PRIM]:6403`）· `ImageLightbox`（`src` / `alt` / `labels` / `onClose`，`[PRIM]:11064`）· `TerminalBlock`（`command,cwd,home,output,exitCode,signal,running,maxLines=16,copyText,runStateDot,className,labels`，`[PRIM]:9343`）· `ReadBlock`（`label,labels,lines,totalLines,lang,maxLines=16,className`，`[PRIM]:9595`）· `DiffBlock`（`diffs,labels,maxLines=16,className`，`[PRIM]:9796`）· `SearchBlock`（`kind,files,paths,labels`，`[PRIM]:9866-10049`）· `WebBlock`（**`kind` 二选一**：`'search'` → `WebSearchBlock{answer,sources,truncated,labels,className}`，否则 `WebFetchBlock{url,statusCode,truncated,labels,className}`，`[PRIM]:12004`）· `JsonBlock`（`label,payload,defaultOpen=false,truncatedLabel`，`[PRIM]:12010`）。

---

## P4 — 主题变量（`[THEME]`）

### 怎么切换、组件是否自适应

- **暗色不是第二套组件**：宿主在 body 上挂属性 **`data-ds-dark-theme`**，token 表成对写着 `body{...}` 与 `body[data-ds-dark-theme]{...}`（实测 light 与 dark 各 190 个 token，一一对应）。
- 用户可在设置里选 `light` / `dark` / `system`，存在 `ui-theme` 设置命名空间（`dsh-client-ui-theme\README.md:12,28,40`）。**特性插件只管读 `--dsw-*`，不要自己管主题状态**（同 README:28）。组件 CSS module 全部引用 `--dsw-*`，**主题切换是自动的**，你不需要写任何 dark 分支——反过来说，**你硬编码的颜色会在另一主题里崩**，一律走变量。
- 字号同理由 `--dsh-content-font-size` 与派生的 `--dsh-content-font-delta` 驱动，Markdown 字号阶梯会跟着设置走。

### 常用变量（名称 / 亮 / 暗）

> 亮、暗两列取自 `design-platform` 的 `body` 与 `body[data-ds-dark-theme]` 两块；字号 / 圆角 / 阴影取自 `base.css`、`focus.css` 的 `:root` 段。完整表共 403 个 token。

| 变量 | 含义 | light | dark |
|---|---|---|---|
| `--dsw-alias-label-primary` | 主文本（本包 CSS 用了 37 次，最高频） | `--dsw-static-neutral-bluish-1000` | `...-50` |
| `--dsw-alias-label-secondary` / `-tertiary` / `-caption` / `-dimmed` | 次级（31 次）/ 三级（35 次）/ 说明小字 / 更弱的文本 | `-700` / `-600` / `-400` / `-200` | `-300` / `-400` / `-600` / `-750` |
| `--dsw-alias-label-primary-foreground` | 主色背景上的前景 | `...-00` | `...-1000` |
| `--dsw-alias-bg-base` | 页面底色 | `...-00` | `...-950` |
| `--dsw-alias-bg-layer-1/2/3` | 逐层叠加的容器底色 | `-00` / `-00` / `-00` | `-875` / `-850` / `-800` |
| `--dsw-alias-bg-module-platform` | 平台模块底色（选择器 / 卡片） | `...-60` | `...-800` |
| `--dsw-alias-bg-mask-1` | 遮罩 | `#0000003d` | `#00000080` |
| `--dsw-alias-settings-card-fill` / `-stroke` | 设置卡片填充 / 描边 | `var(--dsw-alias-bg-layer-2)` / `var(--dsw-alias-border-l4)` | 跟随 layer |
| `--dsw-alias-border-l1` / `-l2` / `-l3` / `-l4` | 分隔线由弱到强（l2 用了 6 次） | `#0000000a` / `#0000001a` / `#0000001f` / `#00000029` | `#ffffff0f` / `#ffffff1f` / `#ffffff29` / `#fff3` |
| `--dsw-alias-border-l2-darkmode-thin` | 暗色细线（0.5px 场景） | `#0000001a` | `#ffffff0f` |
| `--dsw-alias-state-business-primary` | 强调 / 品牌交互色（21 次） | `deepseek-500`（`#4176e6`） | `deepseek-400`（`#7aaaff`） |
| `--dsw-alias-brand-primary` / `-link` | 品牌主色 / 链接色 | `...bluish-1000` / `deepseek-500` | `...bluish-50` / `deepseek-400` |
| `--dsw-alias-state-error`-primary` / `-success-primary` / `-warn-primary` / `-idle-primary` | 危险 / 错误（14 次）、成功（10 次）、警告（6 次）、空闲中性 | `red-600 #ec1313` / `green-500 #22c55e` / `amber-500 #f59e0b` / `neutral-300` | `red-400` / 同左 / 同左 / `neutral-600` |
| `--dsw-alias-interactive-bg`-hover` / `-active` / `-hover-danger` | 悬停底（10 次）/ 按下底 / 危险悬停底 | `#2631480f` / `#2631481a` / `#ec13130d` | `#ffffff14` / `#ffffff24` / `#f25a5a26` |
| `--dsw-focus-ring-color` / `--dsw-focus-ring-width` | 焦点环（15 次 + 10 次） | 默认回退到 `state-business-primary`，宽 `2px` | 同左；**pointer 输入模态下被置为 transparent** |
| `--dsw-radius-xs/sm/md/lg/xl/panel` | 圆角 | `4 / 8 / 12 / 16 / 20 / 28px` | 主题无关 |
| `--dsw-font-family` / `-brand`、`--dsw-font-xs-13`、`--dsw-font-markdown-base/h1..h4/table` | 字体族 / 品牌字体 / `13px/20px` 简写 / Markdown 字号阶梯（随内容字号设置伸缩：`calc(... + var(--dsh-content-font-delta))`） | 系统栈 / Montserrat | 主题无关 |
| `--dsw-elevation-stroke` / `-soft` / `-panel` / `-prominent` | 阴影层级（内部引用 `--dsw-elevation-stroke-color`） | 见 `tokens-final.tsv` | stroke-color 换成 `border-l3` |
| `--dsw-shadow-lv3` | 浮层投影 | `0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px 0 #00000014` | 同左 |
| `--dsw-menu-surface-fill` / `--dsw-menu-backdrop-filter` / `--dsw-mask-blur` | 菜单材质填充 / 菜单背景模糊 / 遮罩模糊 | `#f8f9fa94` / `blur(40px) saturate(150%)` / `none` | `#43454a73` / 同左 / 同左（由 `[data-menu-material]` 改写） |
| `--dsw-alias-menu-icon` / `-menu-group-header-fill` | 菜单图标色 / 粘性组头（94% 不透明） | `bluish-800` / `#f8f9faf0` | `label-primary-dimmed` / `#303136f0` |
| `--dsw-alias-toast-bg` / `-toast-label` | Toast 底色 / 文字（两主题都保证对比） | `bluish-800` | `bluish-750` |
| `--dsw-alias-tooltip-bg` / `-key-bg`、`--dsw-alias-switch-thumb` | 气泡底 / 键帽底 / 关闭态滑块 | `bluish-850` / `color-mix(..., white 18%)` / `bluish-00` | `bluish-750` / 同左 / `bluish-400`（**故意保持浅色**） |
| `--dsw-alias-markdown-code-block` / `-banner`、`--dsw-alias-markdown-inline-code` | 代码块 / 表头 / 行内码底 | `bluish-50` 系 | `bluish-900` / `850` |
| `--dsw-alias-code-diff`-added` / `-deleted`、`--dsw-alias-scrollbar`-bg-l2` / `-hover-l2`、`--dsw-alias-label-shimmer` | diff 增删底 / 滚动条 / TextShimmer 高光 | `green-500-a08` / `red-600-a08` / `neutral-200` / `neutral-300` / 黑 30% | `green-500-a12` / `red-400-a12` / `neutral-600` / `neutral-550` / 白 45% |

**两个变量在整份宿主产物里都找不到定义**（标 **未确认**）：`--dsw-alias-label-error`（被 `fields.module.css` 引用）、`--dsw-alias-bg-layer-4`。用它们时自带 fallback，例如 `var(--dsw-alias-label-error, var(--dsw-alias-state-error-primary))`。**`--dsw-hovercard-bg`** 不是全局 token，由 `[PRIM]` 自己的 `lib\HoverCard.module.css` 内联声明（值 `#2C2C2E`）。

---

## P5 — 用法参考（从宿主真实产物摘的模式）

**① 表单页：模型 → 表单壳 → 字段**（`dsh-client-ui-settings-subagent\lib\client.js:489, 427-466, 132-165`）

~~~js
this.form = new SettingsFormModel(scope, [limitField("maxDepth", 0), limitField("maxActiveSubagents", 1)]);
this.store = this.form.bind(() => ({ ...this.form.shell(), maxDepth: this.form.field("maxDepth") }));
// 渲染：壳子拿 labels + state，字段用 ...state.<field> 直接展开
h(SettingsForm, { labels: formLabels(t), state, onSave: props.save, onDiscard: props.discard },
  h(SettingsValueField, {
    id: "plugin-config-subagent-depth", label: t("subagentMaxDepth"),
    overriddenLabel: t("overridden"), resetLabel: t("reset"), invalidLabel: t("subagentDepthInvalid"),
    numeric: true, disabled: !state.writable || state.saving,
    ...state.maxDepth,                                  // {text, overridden, invalid}
    onEdit: text => props.edit("maxDepth", text), onReset: () => props.resetField("maxDepth")
  }))
~~~
要点：**字段状态是展开进去的**（`...state.maxDepth`），配 4 个本地化 label，`disabled` 同时看 `writable` 与 `saving`。

**② 标签页：SegmentedTabs + 自己渲染面板**（`dsh-client-ui-agent-preset\lib\client.js:724-748`）
`items` 每项 `{value,label,id,panelId}`；面板 div 用 `role="tabpanel"` + `aria-labelledby` + `hidden`（见上节示例）。

**③ 确认对话框：Modal + footer 两个 Button**（`dsh-client-ui-plugin-manager\lib\client.js:2757-2776, 2788-2800`）
`Modal` 拿 `open / onClose / title / closeLabel / description`，`className` 与 `contentClassName` 挂自己的布局类；`footer` 里放 `Button variant="outline"`（取消）+ `Button variant="primary"`（确认）。
敏感操作改用 `RiskConfirmation`（`dsh-client-ui-permission-presets\lib\client.js:419-434`），它自带"勾选后才可确认"。

**④ 行内开关 / 列表行**（`dsh-client-ui-plugin-manager\lib\client.js:1935-1937, 2094-2095`）
~~~js
function RowSwitch({ row, t, busy, onChange }) {
  return h(Switch, { checked: row.enabled, disabled: busy, label: row.name, onChange: v => onChange(row, v) });
}
~~~
**`label` 是必填的**——宿主每一处 `Switch` 都传了它。

**⑤ 插件自带 CSS 的注入约定**（宿主每个 client.js 都这么做，可作风格参照；`dsh-client-ui-permission-presets\lib\client.js:438-444`）
~~~js
if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@deepseek-ai/<pkg>"; tag.dataset.pluginCss = tagId;
  tag.textContent = css; document.head.appendChild(tag);
}
~~~
能力中心统一用 `src\kit\css.ts` 的 `injectStyleTag(id, css)`（ADR-0004），不要再手写一份。

**⑥ 第三方插件的前车之鉴**：`[3P]`（`@linxin666/dsh-client-ui-skill-explorer`，**技能浏览器，与本任务最像**）的客户端产物**只 require 了 `react` 与 `react/jsx-runtime`**（`[3P]:7-8`），完全没用 primitives——它自己实现了全部 UI。所以**它不能作为 import 说明符的证据**，但它证明不用 primitives 也能跑通（代价是 UI 与宿主风格脱节）。

---

## P6 — 风险提示

**依赖上下文（不能单用 / 需要宿主服务）**

1. `SettingsForm` / `SettingsFormModel` / `settingsNumberField` / `settingsTextField` **必须有 settings scope**（`ctx.configForms.get(ns)`；所需客户端服务见 `dsh-client-ui-settings-subagent\lib\client.js:803-820` 的 `inject = ["slots","locale","remote","remote.session","configForms"]`）。`SettingsFormModel` 构造即 `scope.subscribe`，且 `dispose()` 必须挂到 `ctx.effect` 上。**能力中心若不编辑 settings 命名空间，不要用它。**
2. `MarkdownText` / `JsonTree` / `ConnectionIndicator` / `HoverCard` 与全部 `*Block` 卡片 **要求完整本地化 labels**——包里没有任何语言回退（README:109 "omission fails typechecking"）。**但本包不发 `.d.ts`，编译期不会报错，只会渲染出 `undefined`**：这是本任务最大的隐蔽坑，务必逐个核对 labels 字段。
3. `MarkdownDelegateProvider` 是**可选**（默认 `{}`，`[PRIM]:11032`）：不给也能渲染，只是本地链接不可点。
4. `TextShimmer` 有内部 context 但默认值可用；仅当 children 是复合结构时有约束——**活跃期会渲染两次**，因此 children 不能有副作用或元素 id，且图标 / chevron 要放在 `TextShimmer` **外面**（README:57）。
5. `Menu` 在 `portal` 模式下：`listClassName` 是**唯一**能触达列表卡片的样式钩子；渲染型 / 代理型锚点必须传 `getAnchorRect`，否则测量与宿主 layout effect 竞态（`[PRIM]:3904`）。`DisclosureRow` 是 `memo` + 浅比较：**回调与 node 必须引用稳定**。
6. `Modal` 关不掉的常见原因：内部有 `Menu` 打开时 Escape 先归菜单；`closeTopModal(document)` 会被更晚注册的菜单 / 未注册对话框挡住（README:28）。`Modal` 与 `Menu` 的层级协调依赖 `useModalLayer`，**不要自己再挂 document Escape 监听**去关 Modal。
8. `Toast` 经 portal 渲染；**重复同一文案必须换 `key` 重挂载**才会重播动画；完成前别忘了在 `onDone` 里卸载，否则横幅常驻。

**内部组件 / 不要依赖**

- `FoldToggle` —— 包内私有，**未导出**（README:81）。同理 **未导出**的还有 `CodeCard`、`ImagePreview`、`WebSearchBlock`、`WebFetchBlock`、`SafeLink`、`SourceItem`、`promptLabel`、`statusText`、`runState` 及大量内部函数（对照 `[PRIM]:12381` 的导出表）；只有 `WebBlock` 是那个二选一的门面（`[PRIM]:12004`）。
- `lib/types` 目录**在产物里不存在**：`package.json` 的 `exports["."].types` 指向一个不存在的路径。**任何 TS 工程 import 它都会退化成 `any`**，别指望类型提示；也**不要**试图走 `exports` 里的 `"./src/*"` 拿源码——包里没有 `src` 目录。

**其它**

- CSS module 类名在产物里是哈希过的（如 `css$3.button`），**不要依赖具体类名**；要覆盖样式就传 `className` 或用 `--dsw-*` 变量。
- 图标命名：`*Regular`（1px）/ `*Medium`（1.3px）几何相同，**选权重而不是加边框**；尺寸用 `size` prop（README:87）。

---

## P7 — 未确认清单（明确标注，不要当结论用）

| 项 | 状态 |
|---|---|
| `Checkbox.onChange` / `Toast.onDone` / `JsonTree.label` / `Modal.closeLabel` 是否真"必填" | **推断**。无 `.d.ts`、无 PropTypes；判据是 JSDoc 措辞 + 宿主调用点，运行时不会有警告。 |
| `--dsw-alias-label-error`、`--dsw-alias-bg-layer-4` 的定义 | **未找到**（扫遍 asar 内全部 `@deepseek-ai` 包）。可能由 asar 之外的 web shell 定义，或用例已废弃。 |
| `labels` 对象的**完整**字段形状（MarkdownText / JsonTree / TerminalBlock / ReadBlock / DiffBlock / SearchBlock / WebBlock / ConnectionIndicator / HoverCard） | **未逐字段枚举**；只核实了 `MarkdownText.labels` 与 `SettingsForm.labels`（5 键）。其余请对照各自 region 的渲染代码逐一确认。 |
| `Modal` 初始焦点：JSDoc 要求用 `data-modal-autofocus`，宿主在 `plugin-manager:2769` 用了 `autoFocus`；`RiskConfirmation` 的 `title` / `description` 是否支持 ReactNode | 焦点一项**两处不一致，未确认**（建议按 JSDoc）；ReactNode 一项**未确认**（只见到 string 调用点）。 |
| 加载器是否有别名（无前缀写法能否解析） | **未确认**。`dsh-client-modules\lib\index.js:456` 只定义 `load` / `create` 门面，未见 id 重写表；以 52 个宿主产物实测的唯一写法为准。 |

---

### 怎么复现本文的结论

本文结论全部来自对 asar 内**已发布产物**的只读静态阅读（不改本仓库、不跑 `build.mjs`、不碰任何 profile 与用户目录）。复核路径：

- **导出面 / JSDoc / props**：读 `[PRIM]`，导出名取文件末尾的 `export { ... }` 段，props 取函数签名与 JSDoc；
- **import 说明符证据**：扫 asar 内所有 `@deepseek-ai/*/lib/client.js`，统计 `dsh-client-ui-primitives` 这个字符串出现的形式（核实时是 52 个文件命中、无一处写无前缀形式）；
- **token 表**：从 `[THEME]` 里抽出 8 张内联 CSS 表，按 `:root` 与 `body[data-ds-dark-theme]` 两段解析成「名称 / 亮 / 暗」三列；
- **组件行为**：以宿主自己发布的产物里的真实调用点为准（各节末尾都标了文件与行号）。

读 asar 内部的姿势见上文「路径速记」下的注。
