/**
 * 提示词标签页的字典（D-A3：界面只做中文，标签页字典不需要英文）。
 *
 * 约定：
 *   - key 前缀统一 prompts.*，避免与其他标签页打架；
 *   - 所有用户可见文案都写在这里，组件与状态仓库里只出现 t("prompts.xxx")；
 *   - 宿主返回的诊断 message 已经是中文，直接展示，不进字典；
 *   - 字典里不留死键（test/prompts/client/strings.test.ts 双向检查）。
 */

import { createTranslator } from "../../kit/translate.ts";

export const zh = {
  /* ---- 通用 ---- */
  "prompts.loading": "读取中…",
  "prompts.loadFailed": "读取失败：{message}",
  "prompts.retry": "重试",
  "prompts.cancel": "取消",
  "prompts.close": "关闭",
  "prompts.refresh": "刷新",
  "prompts.crash.title": "提示词页渲染失败",
  "prompts.crash.hint": "错误已被捕获，其他标签页不受影响：{message}",
  "prompts.action.failed": "操作失败：{message}",
  "prompts.warnings.title": "提示",

  /* ---- 工具栏 ---- */
  "prompts.create": "新建 AGENTS.md",
  "prompts.more.trash": "回收站",
  "prompts.more.trashCount": "回收站（{count}）",

  /* ---- 分组与层 ---- */
  "prompts.group.global": "全局",
  "prompts.group.workspace": "当前工作区",
  "prompts.group.count": "{count} 个",
  "prompts.group.noWorkspace": "当前会话没有工作区，不显示项目里的提示词。",
  "prompts.group.empty": "这里还没有 AGENTS.md / CLAUDE.md。",
  "prompts.layer.projectRoot": "项目根",
  "prompts.layer.workspace": "当前工作区",

  /* ---- 列表行 ---- */
  "prompts.row.disabled": "已停用",
  "prompts.row.duplicate": "与 {name} 相同，DSH 只加载一份",
  "prompts.row.tooLarge": "超过 1 MiB，DSH 不加载",
  "prompts.row.budgetOmitted": "约 {size} 超出预算，DSH 会省略",
  "prompts.row.budgetTruncated": "约 {size} 超出预算，DSH 会截断",
  "prompts.row.toggleLabel": "启用或停用「{name}」",

  /* ---- 底部合计 ---- */
  "prompts.foot.budget": "约 {used} / {max}",
  "prompts.foot.loaderDisabled": "当前 profile 里 DSH 的提示词加载已关闭",
  "prompts.foot.sourceConfig": "预算来自 DSH 的组合配置。",
  "prompts.foot.sourceDefault": "读不到 DSH 的组合配置，按默认值 65536 字节算。",

  /* ---- 详情抽屉 ---- */
  "prompts.detail.overview": "概览",
  "prompts.detail.path": "路径",
  "prompts.detail.size": "大小",
  "prompts.detail.state": "状态",
  "prompts.detail.stateOn": "启用",
  "prompts.detail.stateOff": "已停用（文件名以 .disabled 结尾，DSH 不加载）",
  "prompts.detail.content": "内容",
  "prompts.detail.openFailed": "读取内容失败：{message}",
  "prompts.detail.notOpen": "还没有打开任何提示词。",
  "prompts.detail.save": "保存",
  "prompts.detail.saving": "保存中…",
  "prompts.detail.revert": "还原",
  "prompts.detail.revertTitle": "放弃未保存的改动",
  "prompts.detail.saved": "已保存，旧内容已放进回收站",
  "prompts.detail.conflict": "文件已在别处修改",
  "prompts.detail.reload": "重新加载",

  /* ---- 启停确认 ---- */
  "prompts.toggle.titleOff": "停用提示词",
  "prompts.toggle.titleOn": "启用提示词",
  "prompts.toggle.bodyOff": "「{name}」会原地改名成 {name}.disabled，DSH 就不再加载它；文件不会丢，随时可以改回来。",
  "prompts.toggle.bodyOn": "「{name}」会原地改名回 {name}，DSH 会重新加载它。",
  "prompts.toggle.git": "这个目录在 git 仓库里，git 会显示文件被改名。",
  "prompts.toggle.confirmOff": "停用",
  "prompts.toggle.confirmOn": "启用",
  "prompts.toast.toggleOff": "已停用「{name}」",
  "prompts.toast.toggleOn": "已启用「{name}」",

  /* ---- 新建 ---- */
  "prompts.createDialog.title": "新建 AGENTS.md",
  "prompts.createDialog.hint": "新建的固定是 AGENTS.md；CLAUDE.md 与 .local.md 要自己放。",
  "prompts.createDialog.location": "位置",
  "prompts.createDialog.unavailableExists": "这里已经有 AGENTS.md 了",
  "prompts.createDialog.unavailableNoWorkspace": "没有当前会话工作区",
  "prompts.createDialog.unavailableMissing": "这个位置现在不可用",
  "prompts.createDialog.confirm": "新建",
  "prompts.createDialog.creating": "新建中…",
  "prompts.createDialog.done": "已新建「{path}」",
  "prompts.createDialog.conflict": "这个位置已经有 AGENTS.md 了",

  /* ---- 回收站 ---- */
  "prompts.trash.title": "回收站",
  "prompts.trash.subtitle": "共 {count} 条",
  "prompts.trash.empty": "回收站是空的。",
  "prompts.trash.rowSub": "{reason} · {time} · {size}",
  "prompts.trash.reason.save": "保存前",
  "prompts.trash.reason.restore": "恢复前",
  "prompts.trash.restore": "恢复",
  "prompts.trash.purge": "彻底删除",
  "prompts.trash.purgeAll": "清空",
  "prompts.trash.restoreTitle": "恢复这一版",
  "prompts.trash.restoreBody": "「{path}」会写回这一版内容；文件里现在的内容会先进回收站，之后还能恢复。",
  "prompts.trash.restoreConfirm": "恢复",
  "prompts.trash.restored": "已恢复「{path}」",
  "prompts.trash.purgeOneTitle": "彻底删除这一条",
  "prompts.trash.purgeOneBody": "回收站里这一份「{path}」会被永久删除，无法再恢复。",
  "prompts.trash.purgeAllTitle": "清空回收站",
  "prompts.trash.purgeAllBody": "回收站里 {count} 条记录会全部被永久删除，无法再恢复。",
  "prompts.trash.purgeAck": "我明白这些内容无法再恢复",
  "prompts.trash.purgeConfirm": "永久删除",
  "prompts.trash.purgedOne": "已从回收站彻底删除 1 条",
  "prompts.trash.purgedAll": "已清空回收站（{count} 条）",
} as const;

export type PromptsKey = keyof typeof zh;

/** 取一条文案（支持 {name} 模板参数）。 */
export const t = createTranslator<PromptsKey>(zh);
