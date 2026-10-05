# ADR-0008：同一功能的宿主与界面共用一份纯规则（`src/<功能>/rules/`）

日期：2026-10-06 · 状态：已采纳（第二轮重构；补充 ADR-0001 与 ADR-0002）

## 背景
ADR-0001 规定界面不能引用宿主代码，ADR-0002 只允许共用**类型**。结果 MCP 服务器的规则被写了两份：宿主 `mcp/config/schema.ts` 用来在落盘前把关，界面 `mcp/client/model.ts` 用来做表单即时校验，代码注释里写着「宿主 schema.ts 的镜像（改一处要改两处）」。字段白名单、服务器名正则、默认值、遮罩占位符、约 140 行校验各一份，只靠一条「字段顺序一致」的单测维系。界面提示与保存时宿主的判断随时可能对不上。

这些规则本身是纯函数：只依赖契约里的类型，不碰 Node 也不碰 DOM，在宿主和浏览器里都能跑。

## 决定
- 新增区域 **规则**：`src/<功能>/rules/`，放这个功能的纯业务规则。第一个是 `src/mcp/rules/`：`server.ts`（字段白名单、按传输方式划分的字段、默认值、遮罩占位符、`parseServerInput`）、`settings.ts`（全局设置的默认值与 `parseSettingsInput`）、`values.ts`（值判断）。
- 引用规则（`test/architecture/imports.test.ts` 第 7 条）：
  - 规则只给**本功能**用，宿主模块与界面都可以 import（正常 import，会打进两边的产物）；
  - 规则只引用本功能的规则、本功能的契约（仅类型）与 `shared/`；
  - 规则不能 import 任何包（`node:`、`react`……），由单测扫描保证。
- 磁盘格式的类型（`RawMcpConfigFile`、`RawMcpSettings`）移进契约，规则才能用到它们。
- 界面只保留「表单才有」的检查：数值框里填的不是数字、列表编辑器里留了空行；其余校验对提交体调用同一个 `parseServerInput` / `parseSettingsInput`。

## 后果
- MCP 服务器规则只剩一份，界面提示与宿主判断一致（文案也一致）。
- 宿主的 `mcp/config/schema.ts` 只剩「落盘文件 → 生效配置」的归一化与服务器视图。
- 一个可见的变化：服务器改成 streamable-http 后，草稿里残留的 envFrom 不再报错——提交体本来就按传输方式裁掉它（以前报的错显示在隐藏的字段下，用户看不见却存不了）。
