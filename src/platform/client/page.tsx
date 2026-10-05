/**
 * 页面注册：侧栏面板行 + 中央面板（keyed slot main）。
 *
 * 契约（@deepseek-ai/dsh-cordis-client-runner/lib/client.js:3884-3918 的 slot 声明）：
 *   - sidebar.panellist（list，root）：每个条目 id 对应一个 main 面板；侧栏拥有按钮，
 *     标签从 list 元数据解析（label 可以是 thunk，语言切换时自动跟随）。
 *   - main（keyed，root）：注册已占用的 key 会替换该占位者；reserved "conversation" 归会话。
 *   - 两个 slot 都由别的插件声明，注册一律包在 ctx.slots.inject 里：等 owner 出现再注册，
 *     owner 永不出现时页面只是缺席，而不是让插件启动失败。
 *
 * 直达标签（D-A2）：插件管理页那一行的「配置」按钮只负责把面板切到 MCP 标签；
 * 具体实现见 config-button.tsx。
 */
import * as React from "react";
import { CapabilityHubPage, requestTab, type PanelTab } from "./panel.tsx";
import { t as tt } from "./strings.ts";

/** 侧栏行与 main 面板共用的 id。 */
export const PANEL_ID = "capability-hub";
/** 面板行顺序（官方 Plugins 0 / Schedule 10 / 其他 20 之后）。 */
export const PANEL_ORDER = 30;

/** 侧栏行里的字形（该行 DOM 中唯一由本插件拥有的节点）。 */
export function CapabilityHubPanelIcon({ size, active }: { size: number; active?: boolean }): React.ReactElement {
  return (
    <svg
      data-dsh-panel-entry={PANEL_ID}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-active={active === true ? "" : undefined}
    >
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2.4" />
      <path d="M2.2 6.2h11.6" />
      <path d="M6.6 6.2v7.6" />
      <circle cx="4.3" cy="4.2" r="0.55" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 中央面板组件。 */
function CapabilityHubMain(props: Record<string, unknown>): React.ReactElement {
  return <CapabilityHubPage {...props} />;
}

/** 一个 slot 客户端面（便于测试注入替身）。 */
export interface SlotsFace {
  inject(name: string, callback: () => () => void): () => void;
  register(options: Record<string, unknown>, component: unknown): () => void;
}

/** 一个「切换到面板」的宿主面（layout 服务）。 */
export interface LayoutFace {
  selectPanel?(panelId: string | null): void;
}

/**
 * 注册侧栏行与中央面板。
 * @param slots ctx.slots
 * @param layout ctx.get("layout")（可能为 undefined）
 * @returns 解绑函数
 */
export function registerCapabilityHubPanel(slots: SlotsFace, layout: LayoutFace | undefined): () => void {
  const disposers: Array<() => void> = [];
  try {
    disposers.push(
      slots.inject("sidebar.panellist", () =>
        slots.register(
          {
            name: "sidebar.panellist",
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: () => tt("entry.label"),
          },
          CapabilityHubPanelIcon,
        ),
      ),
    );
    disposers.push(
      slots.inject("main", () =>
        slots.register(
          {
            name: "main",
            key: PANEL_ID,
          },
          CapabilityHubMain,
        ),
      ),
    );
  } catch (error) {
    console.warn("[capability-hub] 面板注册失败：", error);
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 解绑失败不影响其他注册 */
      }
    }
  };
}

/**
 * 打开能力中心面板；可选直达某个标签。
 * @param layout layout 服务面
 * @param tab 目标标签（省略则沿用上一次）
 */
export function openCapabilityHub(layout: LayoutFace | undefined, tab?: PanelTab): void {
  if (tab !== undefined) requestTab(tab);
  try {
    layout?.selectPanel?.(PANEL_ID);
  } catch (error) {
    console.warn("[capability-hub] 切换面板失败：", error);
  }
}
