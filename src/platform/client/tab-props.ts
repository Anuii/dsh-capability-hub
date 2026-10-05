/**
 * 标签页组件的 props 接口（T0 提供，T4a/T4b 消费；PLAN §3.8）。
 *
 * 为什么要有这个文件：panel.tsx（T0）负责引入三个标签组件，标签组件（T4a/T4b）
 * 与外壳之间必须有一份**小而稳定**的契约 —— 标签作者只需要这两三个值，
 * 而外壳不必知道标签内部在干什么。
 *
 * 兼容性规则（重要）：
 *   - 这三个字段都是**只读**的，外壳不会中途改变语义；
 *   - 标签组件可以只声明自己用得到的字段（TS 结构类型），多余的 props 会被忽略；
 *   - 新增字段只允许**可选**，否则会破坏已写好的标签组件；
 *   - 组件里不要读 ctx（客户端没有 sessions 服务），需要的数据要么在这里，
 *     要么经自己功能的 data.ts 调 `./api.ts`（见 docs/CLIENT-GUIDE.md 第 3、5 节）。
 */

/** 标签 id（顺序即界面上从左到右的顺序）。0.3.0 起运行态并入 MCP 页（D-A2），只剩两个。 */
export type PanelTab = "skills" | "mcp";

/** 标签页组件收到的 props（panel.tsx 传给它引入的每一个标签组件）。 */
export interface TabProps {
  /**
   * 当前会话的工作区绝对路径；取不到时 undefined。
   *
   * 用途：技能页要拿它找项目级技能根（project-dsh / project-agents），
   * MCP 页的项目级导入、运行态页的会话过滤也用它。
   */
  workspace: string | undefined;
  /** 当前会话 id；取不到时 undefined（运行态页按会话过滤实例时用）。 */
  sessionId?: string;
  /**
   * 切换到另一个标签页（标签之间互相跳转用，例如「保存成功后去看运行态」）。
   * 外壳保证这个回调稳定可调用，且在任意标签里都能用。
   */
  openTab(tab: PanelTab): void;
  /**
   * 0.3.4 起（可选）：告诉外壳这个标签现在有没有需要注意的错误（例如 MCP 有服务器连接失败），
   * 外壳在标签文字旁画一个红点，在别的标签里也能察觉。
   */
  reportAttention?(tab: PanelTab, attention: boolean): void;
}
