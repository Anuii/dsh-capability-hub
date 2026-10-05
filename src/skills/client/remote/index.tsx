/**
 * 远程部分（安装 / 来源 / 更新 / 批量动作）的对外出口。
 *
 * 契约（UI-A 重做后）：
 *   AddSkillDrawer    ← ../index.tsx（「添加技能」抽屉；宽度 720px）
 *   SkillSourceSection ← ../detail.tsx（详情抽屉「来源与更新」里的来源一段，inline）
 *   SkillUpdateSection ← ../detail.tsx（同一节里的更新一段，inline）
 *   useSkillsRemoteMenu ← ../index.tsx（工具栏「⋯」里的检查全部更新 / 全部更新 / 推测来源）
 *
 * 为什么不再有 extension.ts：三个视图是**静态**组件，barrel 直接导出即可；
 * 多一层「可选扩展位」只会让 hooks 规则与类型都复杂化（UI-A 简化掉）。
 */

export { AddSkillDrawer } from "./install-view.tsx";
export { SkillSourceSection } from "./source.tsx";
export { SkillUpdateSection } from "./update.tsx";
export { useSkillsRemoteMenu } from "./batch.tsx";
