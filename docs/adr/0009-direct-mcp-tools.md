# ADR-0009：去掉懒加载网关，每个 MCP 工具直接注册成 DSH 工具

日期：2026-10-12 · 状态：已采纳（使用者：「把懒加载去掉」「主要是现在 PTC 模式好像就不会调用 mcp 了」）；推翻 D-D1 / D-D2 / D-D9

## 背景
0.1–0.5 只向模型注册一个 `mcp` 工具：参数 schema 恒定，模型要先 `search` / `describe` 找到工具，再 `{ tool, args }` 调用。设计目标是工具描述不随服务器的工具增减变化、保住提示词前缀缓存。

DSH 的 PTC 模式下，模型只看到 `run_code` 和一份按工具 schema 生成的类型化 SDK。一个参数是「随便一个 JSON」的网关在 SDK 里只是 `tools.mcp(args)`，模型看不出背后有哪些能力，实际上几乎不调用。使用者确认要去掉网关。

## 决定
- 每个已启用服务器的每个可见工具（includeTools / excludeTools 过滤后）直接注册成 DSH 工具，名字 `mcp__<服务器>__<工具>`，与 DSH 官方 `dsh-mcp-client` 同一算法（不合规字符替换、超 64 字截断，变形时接身份哈希）。PTC 模式下每个工具都是独立的类型化绑定。
- 工具来自**工具缓存**，不是会话开始时现连：缓存由保存 / 启动时的后台探测写入（D-C6）。这样会话开始不用等任何进程，进程仍在第一次调用时才启动（D-D4 的四种生命周期不变）。代价：新加的服务器要等探测完成（通常几秒）才出现在模型那里。
- DSH 只接受一个 JSON Schema 子集（单一 type、oneOf、布尔 additionalProperties、字符串 enum……），MCP 服务器常用的 anyOf、类型数组、`$ref`、format、范围在原样注册时会被拒绝（本机 25 个工具里 8 个）。`mcp/runtime/atoms/schema-subset.ts` 把它们转成子集：等价改写或放宽，不收紧；丢掉的约束写进参数说明。转换结果由 Electron-as-node 下的 `schema-subset-check.mjs` 用 DSH 自带的校验器核对。仍被 DSH 拒绝的工具只跳过它自己（官方客户端会放弃整台服务器），在 health 的 `tools.failed` 里可见。
- 稳定性：工具清单按「服务器配置顺序、工具名」排序，内容不变时逐字节相同、不通知；清单变化时外壳只注销 / 注册变了的那几个工具。
- 服务器清单（名字 + `meta.description` 第一行）与服务器自带的用法说明（MCP instructions）放进系统提示词的一段（`ctx.systemPrompt.section`，与官方客户端同一做法），文字是活的。
- 调用失败以失败的工具调用返回（PTC 下是 ToolCallError）：连不上 / 超时进冷却；服务器自己返回的 isError 原文交给模型、不进冷却；取消不算失败。
- 删除：`mcp` 工具、search / describe / connect / instructions / status 动作、搜索排序、`searchKeywords` 表单字段（旧配置照旧接受、不起作用）。

## 后果
- 模型在原生与 PTC 模式下都能直接看到并调用每个 MCP 工具；每个工具的参数说明常驻上下文（MaaMCP 24 个工具约几 KB）。
- 改服务器的工具清单会改变注册的工具集合，提示词前缀缓存随之失效一次；只改生命周期、超时、标签之类不会。
- health 的 `tool` 字段换成 `tools { registered, failed, prompt, error? }`；运行态的 `cache.tools[]` 多了 `exposedAs`（模型看到的名字），详情抽屉列的就是它。
