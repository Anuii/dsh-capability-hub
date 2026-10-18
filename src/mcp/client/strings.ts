/**
 * MCP 服务器标签页的字典（D-A3：界面只做中文，标签页字典不需要英文）。
 *
 * 约定：
 *   - key 前缀统一 mcp.*，避免与其他标签页打架；
 *   - 所有用户可见文案都写在这里，组件里只出现 t("mcp.xxx")；
 *   - 宿主返回的校验 message 已经是中文，直接展示，不进字典；
 *   - 页面上的常驻说明长句一律删除（UI-DESIGN §1），说明改放 title 工具提示或抽屉里。
 */

import { createTranslator } from "../../kit/translate.ts";

export const zh = {
  /* ---- 通用与工具栏 ---- */
  "mcp.loadFailed": "读取失败：{message}",
  "mcp.retry": "重试",
  "mcp.cancel": "取消",
  "mcp.close": "关闭",
  "mcp.saving": "保存中…",
  "mcp.delete": "删除",
  "mcp.jsonMode": "JSON 编辑",
  "mcp.search": "搜索服务器",

  /* ---- 渲染兜底 ---- */
  "mcp.crash.title": "MCP 标签渲染失败",
  "mcp.crash.hint": "错误已被捕获，其他标签页不受影响：{message}",

  /* ---- 服务端提示 ---- */
  "mcp.warnings.title": "服务端提示（{count}）",

  /* ---- 提示 ---- */
  "mcp.toast.failed": "操作失败：{message}",
  "mcp.toast.reordered": "顺序已保存。",
  "mcp.toast.toggleOn": "已启用「{name}」。",
  "mcp.toast.toggleOff": "已停用「{name}」。",
  "mcp.toast.revealed": "已向服务端取回明文，只在本次查看里保留。",
  "mcp.toast.saved": "已保存「{name}」。",

  /* ---- 筛选（0.9.0 起没有「有错误」：页面不显示运行状态） ---- */
  "mcp.filter.all": "全部",
  "mcp.filter.enabled": "已启用",
  "mcp.filter.disabled": "已停用",
  "mcp.filter.label": "筛选服务器",

  /* ---- 添加（对话框里两种方式：粘贴 JSON / 从 Official Registry 搜索） ---- */
  "mcp.add.button": "添加服务器",
  "mcp.add.title": "添加 MCP 服务器",
  "mcp.add.modeLabel": "添加方式",
  "mcp.add.modePaste": "粘贴 JSON",
  "mcp.add.modeRegistry": "从 Official Registry 搜索",

  /* ---- 空状态 ---- */
  "mcp.empty.title": "还没有配置任何 MCP 服务器",
  "mcp.empty.hint": "点「添加服务器」：粘贴一段 mcpServers 配置（JSON），或从 Official Registry 搜索。",
  "mcp.failure.banner": "连接失败：{names}",
  "mcp.failure.reason": "（{message}）",
  "mcp.failure.hint": "连接由 DSH 官方 MCP 插件负责，重启 DSH 会重试；详情见 GET health 的 mcpServers。",
  "mcp.failure.recheck": "重新读取",
  "mcp.empty.add": "添加服务器",
  "mcp.empty.filtered": "没有符合当前搜索与筛选的服务器。",

  /* ---- 列表行 ---- */
  "mcp.row.noCommand": "（未设置启动命令）",
  "mcp.row.noUrl": "（未设置地址）",
  "mcp.row.toggleLabel": "启用或停用「{name}」",
  "mcp.row.dragHint": "拖动可排序",

  /* ---- 详情抽屉（0.9.0 起没有「工具」一节与「重新连接」） ---- */
  "mcp.detail.overview": "概览",
  "mcp.detail.secrets": "环境变量与请求头",
  "mcp.detail.transport": "传输方式",
  "mcp.detail.command": "命令",
  "mcp.detail.url": "地址",
  "mcp.detail.cwd": "工作目录",
  "mcp.detail.description": "描述",
  "mcp.detail.env": "环境变量",
  "mcp.detail.headers": "请求头",
  "mcp.detail.none": "未设置",
  "mcp.detail.show": "显示",
  "mcp.detail.hide": "隐藏",
  "mcp.detail.revealTitle": "向服务端要明文，只在本次查看里保留",
  "mcp.detail.revealFailed": "读取明文失败：{message}",
  "mcp.detail.revealing": "读取中…",
  "mcp.detail.masked": "已遮罩",
  "mcp.detail.deleteTitle": "删除「{name}」",
  "mcp.detail.jsonTitle": "用 JSON 编辑「{name}」",
  "mcp.detail.scope": "进程",
  "mcp.detail.scopeHint": "全局一份：所有会话共用一个进程；按会话：每个会话与子代理各一个进程。",
  "mcp.scope.globalShort": "全局一份",
  "mcp.scope.sessionShort": "按会话",
  "mcp.toast.scopeSession": "已改为按会话：每个会话、子代理各一个进程。",
  "mcp.toast.scopeGlobal": "已改为全局一份：所有会话共用一个进程。",

  /* ---- 单服务器 JSON 编辑 ---- */
  "mcp.json.title": "JSON 编辑「{name}」",
  "mcp.json.hint":
    "这里只列显式设置过的字段（默认值不落盘）；敏感值是遮罩后的 ***hidden***，原样提交即保留原值。可用字段：serverName、transport（stdio / streamable-http）、command、args、cwd、env、envFrom、allowEmpty、envFromTimeoutMs、url、headers、toolCallTimeoutMs、scope（global 全局一份 / session 按会话）、disabled、meta.description。",
  "mcp.json.parseError": "JSON 解析失败：{message}",
  "mcp.json.needObject": '顶层必须是一个 JSON 对象（形如 { "serverName": "…", "transport": "stdio" }）。',
  "mcp.json.errors": "服务端返回 {count} 条错误",
  "mcp.json.format": "格式化",
  "mcp.json.save": "校验并保存",
  "mcp.json.saveFailed": "保存失败：{message}",

  /* ---- 删除确认 ---- */
  "mcp.delete.title": "删除 MCP 服务器",
  "mcp.delete.body": "「{name}」会从配置文件里移除，立即生效。这个操作不可撤销。",
  "mcp.delete.confirm": "确认删除",
  "mcp.delete.cancel": "取消",
  "mcp.delete.done": "已删除「{name}」。",

  /* ---- 粘贴 JSON 添加（D-C2） ---- */
  "mcp.paste.hint":
    '支持 { "mcpServers": { … } }、{ "servers": { … } }、「名称 → 服务器对象」映射，或单个服务器对象。除了标准写法，还可以写 envFrom、scope（global / session）、meta.description 等本插件的字段。识别结果先预览，勾选后才逐个保存。',
  "mcp.paste.placeholder": '{ "mcpServers": { "my-server": { "command": "npx", "args": ["-y", "pkg"] } } }',
  "mcp.paste.textLabel": "JSON 内容",
  "mcp.paste.parse": "解析",
  "mcp.paste.parsing": "解析中…",
  "mcp.paste.clear": "清空",
  "mcp.paste.empty": "还没有解析结果：把 JSON 粘到上面的文本框，点「解析」。",
  "mcp.paste.found": "识别出 {count} 个服务器",
  "mcp.paste.warnings": "解析提示（{count}）",
  "mcp.paste.warningRow": "· {text}",
  "mcp.paste.needText": "请先粘贴要解析的 JSON 内容。",
  "mcp.paste.parseFailed": "解析失败（服务端原文）：",
  "mcp.paste.noServers": "没有识别出任何服务器，请检查 JSON 结构。",
  "mcp.paste.statusNew": "可保存",
  "mcp.paste.statusConflict": "同名冲突",
  "mcp.paste.statusInvalid": "名称不合法",
  "mcp.paste.selectRow": "保存「{name}」",
  "mcp.paste.renameLabel": "保存用的名称",
  "mcp.paste.renameHint": "同名时改一个名字即可保存；不改就取消勾选（跳过这个服务器）。",
  "mcp.paste.useSuggested": "用建议名「{name}」",
  "mcp.paste.selected": "已勾选 {count} / {total}",
  "mcp.paste.selectAll": "全选可保存的",
  "mcp.paste.clearSelection": "取消全选",
  "mcp.paste.blocked": "还有 {count} 行勾选了但不能保存：先改名、用建议名，或取消勾选。",
  "mcp.paste.save": "保存勾选的 {count} 个",
  "mcp.paste.saving": "保存中…",
  "mcp.paste.resultSaved": "已保存",
  "mcp.paste.resultFailed": "保存失败：{message}",
  "mcp.paste.savedMany": "已保存 {count} 个服务器。",
  "mcp.paste.savedNone": "没有任何服务器被保存。",
  "mcp.paste.hiddenWarning": "检测到 ***hidden*** 占位符（{names}）：新建时它会被当成真实值保存，请先替换成真实值。",

  /* ---- 从 Official Registry 搜索添加（0.9.0） ---- */
  "mcp.registry.hint":
    "搜索会请求 Official Registry（registry.modelcontextprotocol.io）的只读接口，不需要令牌。实测比较慢：通常 10–60 秒，请耐心等「加载中…」结束。",
  "mcp.registry.queryLabel": "关键词",
  "mcp.registry.placeholder": "例如 github、filesystem、jira",
  "mcp.registry.search": "搜索",
  "mcp.registry.loading": "加载中…",
  "mcp.registry.searching": "正在搜索 Official Registry，可能要 10–60 秒…",
  "mcp.registry.needQuery": "请先输入搜索关键词。",
  "mcp.registry.searchFailed": "搜索失败：{message}",
  "mcp.registry.retry": "重试",
  "mcp.registry.empty": "没有匹配的服务器，换个关键词再试。",
  "mcp.registry.results": "搜到 {count} 个结果",
  "mcp.registry.more": "加载更多",
  "mcp.registry.needsEnv": "需要填 {count} 个变量",
  "mcp.registry.kind.remotes": "远程 HTTP",
  "mcp.registry.kind.npm": "npm 包",
  "mcp.registry.kind.pypi": "PyPI 包",
  "mcp.registry.kind.oci": "OCI 镜像",
  "mcp.registry.version": "版本 {version}",
  "mcp.registry.back": "返回搜索结果",
  "mcp.registry.detailLoading": "读取详情…",
  "mcp.registry.detailFailed": "读取详情失败：{message}",
  "mcp.registry.detailBroken": "服务端没有返回这条服务器的详情。",
  "mcp.registry.unsupported": "不能一键生成配置：{message}",
  "mcp.registry.notes": "注意",
  "mcp.registry.nameLabel": "服务器名",
  "mcp.registry.nameHint": "保存用的名字：只能包含英文字母、数字、下划线、短横线，长度 1–32（DSH 用它拼工具名）。",
  "mcp.registry.nameEmpty": "服务器名不能为空。",
  "mcp.registry.nameInvalid": "服务器名只能包含英文字母、数字、下划线、短横线，长度 1–32。",
  "mcp.registry.nameConflict": "已经有一台服务器叫「{name}」，换一个名字再保存。",
  "mcp.registry.envTitle": "环境变量",
  "mcp.registry.envRequired": "必填",
  "mcp.registry.envOptional": "可选",
  "mcp.registry.envMissingOne": "必填变量，请先填上。",
  "mcp.registry.envMissing": "还有必填变量没填：{names}",
  "mcp.registry.configTitle": "将要保存的配置（只读）",
  "mcp.registry.save": "保存",
  "mcp.registry.saving": "保存中…",
  "mcp.registry.saved": "已保存「{name}」。",
  "mcp.registry.saveFailed": "保存失败：{message}",
  "mcp.registry.saveConflict": "服务器名「{name}」已经存在（宿主返回 409），换一个名字再保存。",

  /* ---- 进程放在哪（scope） ---- */
  "mcp.scope.global": "全局一份（所有会话共用一个进程）",
  "mcp.scope.session": "按会话（每个会话、子代理各一个进程）",
} as const;

export type McpKey = keyof typeof zh;

/** 取一条文案（支持 {name} 模板参数）。 */
export const t = createTranslator<McpKey>(zh);
