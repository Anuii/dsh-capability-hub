/**
 * 运行态标签页的字典（D-A3：界面只做中文，标签页字典不需要英文）。
 * key 前缀统一 runtime.*；所有用户可见文案都写在这里，组件里只出现 t("runtime.xxx")。
 * 宿主返回的 message 已经是中文，直接展示，不进字典。
 *
 * UI-B 起：页面上的常驻说明长句全部删除，说明改放 title 工具提示（runtime.pollHint）或抽屉里。
 */

export const zh = {
  /* ---- 通用 ---- */
  "runtime.loadFailed": "读取运行态失败：{message}",
  "runtime.retry": "重试",
  "runtime.close": "关闭",
  "runtime.crash.title": "运行态标签渲染失败",
  "runtime.crash.hint": "错误已被捕获，其他标签页不受影响：{message}",
  "runtime.pollFailed": "自动刷新失败：{message}（下面显示的是上一次的结果）",

  /* ---- 工具栏 ---- */
  "runtime.autoRefresh": "自动刷新",
  "runtime.refresh": "刷新",
  "runtime.pollHint": "标签可见时每 5 秒自动刷新；页面不可见时暂停。",
  "runtime.onlyCurrent": "只看当前会话",
  "runtime.onlyCurrentOff": "当前没有会话 id，无法过滤。",

  /* ---- 服务器分组 ---- */
  "runtime.servers.title": "服务器",
  "runtime.servers.empty": "还没有配置任何服务器。",
  "runtime.row.cache": "缓存 {count} 个工具 · 更新于 {time}",
  "runtime.row.noCache": "还没有工具缓存",
  "runtime.row.stale": "缓存已过期",
  "runtime.row.instances": "{count} 个活跃实例",
  "runtime.row.instancesNone": "没有活跃实例",
  "runtime.row.cooldownBadge": "冷却 {seconds}s",
  "runtime.row.cooldown": "冷却中，剩余 {remaining}",
  "runtime.row.refresh": "刷新缓存",
  "runtime.row.disconnect": "断开全部",
  "runtime.row.refreshOk": "「{name}」缓存已刷新：{count} 个工具。",
  "runtime.row.refreshFailed": "刷新「{name}」失败：{message}",
  "runtime.row.disconnectOk": "已断开「{name}」的 {count} 个实例。",
  "runtime.row.disconnectNone": "「{name}」当前没有活跃实例，无需断开。",
  "runtime.row.disconnectFailed": "断开「{name}」失败：{message}",

  /* ---- 会话分组 ---- */
  "runtime.sessions.empty": "模型调用 mcp 工具后，这里会显示会话与实例",
  "runtime.sessions.filteredEmpty": "当前会话没有活跃实例。",
  "runtime.session.child": "子代理",
  "runtime.instance.pid": "PID {pid}",
  "runtime.instance.started": "启动 {time}",
  "runtime.instance.lastUsed": "最近使用 {time}",
  "runtime.instance.disconnect": "断开",
  "runtime.instance.disconnectOk": "已断开这个实例。",
  "runtime.instance.disconnectNone": "这个实例已经不在运行了（可能刚被回收）。",
  "runtime.instance.disconnectFailed": "断开实例失败：{message}",

  /* ---- 实例状态 ---- */
  "runtime.state.ready": "就绪",
  "runtime.state.connecting": "连接中",
  "runtime.state.failed": "失败",
  "runtime.state.closing": "关闭中",
  "runtime.state.closed": "已关闭",
  "runtime.state.unknown": "未知（{state}）",

  /* ---- 服务器抽屉 ---- */
  "runtime.drawer.failureTitle": "最近失败",
  "runtime.drawer.cacheTitle": "缓存",
  "runtime.drawer.instancesTitle": "实例",
  "runtime.drawer.cache": "缓存 {count} 个工具 · 更新于 {time}",
  "runtime.drawer.failure": "{message}（{time}）",
  "runtime.drawer.noInstances": "这个服务器当前没有活跃实例。",
  "runtime.drawer.session": "会话 {id}",

  /* ---- 断开确认 ---- */
  "runtime.dialog.title": "断开 MCP 实例",
  "runtime.dialog.body": "{target}会立即结束；模型下次调用 mcp 工具时会重新连接。",
  "runtime.dialog.targetServer": "「{name}」在当前全部会话里的实例",
  "runtime.dialog.targetInstance": "会话 {sessionId} 里的「{name}」实例",
  "runtime.dialog.confirm": "确认断开",
  "runtime.dialog.cancel": "取消",
} as const;

export type RuntimeKey = keyof typeof zh;

/** 取一条运行态文案（支持 {name} 模板参数）。 */
export function t(key: RuntimeKey, values?: Record<string, unknown>): string {
  let text: string = zh[key];
  if (values !== undefined) {
    for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}
