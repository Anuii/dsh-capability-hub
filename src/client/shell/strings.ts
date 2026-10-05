/**
 * 字典机制（D-A3：界面只做中文，文案集中在字典文件）。
 *
 * 约定（照抄社区插件的做法，见 @linxin666/dsh-client-ui-skill-explorer/lib/client.js:196、350-369）：
 *   - zh 是 key 的权威来源，en 镜像每一个 key；
 *   - apply() 里用 ctx.locale.register(NS, { zh, en }) 注册，并把 ctx.locale.bind(NS)
 *     交给 setRuntimeTranslate，这样运行期切换语言时纯 DOM 文案也会跟着变；
 *   - 组件里一律用 t("key")，不要写死中文。
 *
 * 【UI-0 变更】页头副标题已删除（UI-DESIGN §2），"panel.subtitle" 随之删除；
 * 「诊断信息」不再是页面上的常驻卡片，而是「ⓘ」按钮打开的模态框。
 */

/** 本插件拥有的 locale 命名空间。 */
export const LOCALE_NS = "capability-hub";

/** 中文字典（key 的权威来源）。 */
export const zh = {
  "entry.label": "能力中心",
  "entry.tooltip": "能力中心：管理技能与 MCP 服务器",
  "panel.title": "能力中心",
  "tab.skills": "技能",
  "tab.mcp": "MCP",
  "tab.attention": "有服务器连接失败",
  "placeholder.skills": "技能管理界面将在后续版本接入。",
  "placeholder.mcp": "MCP 服务器配置界面将在后续版本接入。",
  "placeholder.hint": "当前为骨架版本：页面、标签与通道已打通。",
  "env.title": "诊断信息",
  "env.open": "查看诊断信息",
  "env.profile": "profile",
  "env.home": "homeDir",
  "env.hubHome": "hubHome",
  "env.dshHome": "dshHome",
  "env.sdk": "MCP SDK",
  "env.modules": "模块",
  "env.tool": "mcp 工具",
  "env.mcpTool": "mcp 工具",
  "env.workspace": "当前工作区",
  "env.workspaceNone": "（未取得）",
  "env.loading": "读取中…",
  "env.failed": "读取失败：{message}",
  "env.degraded": "部分功能不可用：{modules}",
  "env.staleHost": "能力中心已升级到 {client}，但 DSH 还在运行 {host} 的宿主代码；重启 DSH 后新功能才能用。",
  "env.viewDetails": "查看详情",
  "action.refresh": "刷新",
  "action.close": "关闭",
  "action.open": "打开能力中心",
  "status.degraded": "降级",
  "status.ok": "正常",
  "config.summary": "能力中心：技能与 MCP 服务器管理",
  "config.openMcp": "打开能力中心（MCP 服务器）",
} as const;

/** 英文字典（镜像全部 key）。 */
export const en: Record<string, string> = {
  "entry.label": "Capability Hub",
  "entry.tooltip": "Capability Hub: manage skills and MCP servers",
  "panel.title": "Capability Hub",
  "tab.skills": "Skills",
  "tab.mcp": "MCP",
  "tab.attention": "A server failed to connect",
  "placeholder.skills": "The skills UI arrives in a later release.",
  "placeholder.mcp": "The MCP server UI arrives in a later release.",
  "placeholder.hint": "Skeleton release: the page, tabs and host channel are wired.",
  "env.title": "Diagnostics",
  "env.open": "View diagnostics",
  "env.profile": "profile",
  "env.home": "homeDir",
  "env.hubHome": "hubHome",
  "env.dshHome": "dshHome",
  "env.sdk": "MCP SDK",
  "env.modules": "Modules",
  "env.tool": "mcp tool",
  "env.mcpTool": "mcp tool",
  "env.workspace": "Current workspace",
  "env.workspaceNone": "(unavailable)",
  "env.loading": "Loading…",
  "env.failed": "Failed: {message}",
  "env.degraded": "Some features are unavailable: {modules}",
  "env.staleHost": "Capability Hub was upgraded to {client}, but DSH is still running the {host} host code; restart DSH to enable the new features.",
  "env.viewDetails": "View details",
  "action.refresh": "Refresh",
  "action.close": "Close",
  "action.open": "Open Capability Hub",
  "status.degraded": "degraded",
  "status.ok": "ok",
  "config.summary": "Capability Hub: skills and MCP servers",
  "config.openMcp": "Open Capability Hub (MCP servers)",
};

/** 运行期翻译函数（由 apply() 用 ctx.locale.bind(NS) 接上）。 */
let runtimeTranslate: ((key: string, values?: Record<string, unknown>) => string) | undefined;

/** 接上/断开运行期翻译；传 undefined 恢复按文档语言选择。 */
export function setRuntimeTranslate(
  translate: ((key: string, values?: Record<string, unknown>) => string) | undefined,
): void {
  runtimeTranslate = translate;
}

/** 当前语言的字典（没接运行期翻译时的兜底）。 */
function dictionary(): Record<string, string> {
  const lang = typeof document !== "undefined" && document.documentElement.lang !== ""
    ? document.documentElement.lang
    : "zh";
  return lang.toLowerCase().startsWith("en") ? en : { ...zh };
}

/** 取一条文案，支持 {name} 模板参数。 */
export function t(key: string, values?: Record<string, unknown>): string {
  if (runtimeTranslate !== undefined) {
    try {
      return runtimeTranslate(key, values);
    } catch {
      /* 运行期翻译失败时退回本地字典 */
    }
  }
  let text: string = (dictionary() as Record<string, string>)[key] ?? key;
  if (values !== undefined) {
    for (const [name, value] of Object.entries(values)) text = text.replaceAll("{" + name + "}", String(value));
  }
  return text;
}
