/**
 * 插件管理页「配置」按钮（keyed slot plugins.row.config，D-A2）。
 *
 * 契约（@deepseek-ai/dsh-cordis-client-runner/lib/client.js:4205-4236）：
 *   - kind=keyed，scope=root，key = "<包名>#<行 id>"，测试 profile 里即
 *     "dsh-capability-hub#capability-hub"（行 id 按本包 cordis.patch.yml 声明）。
 *   - owner 渲染两次：view="summary"（列表行摘要，仅在缺包描述时用）与
 *     view="page"（行自己的页面，带保存控件）。
 *   - 只有某个条目点名这一行时，该行的配置页才存在；因此注册要包在 ctx.slots.inject 里。
 *
 * 本按钮的行为：把面板切到「MCP 服务器」标签并打开能力中心。
 */
import * as React from "react";
import { t as tt } from "./strings.ts";
import { openCapabilityHub, type LayoutFace, type SlotsFace } from "./page.tsx";
import { styles } from "./styles.ts";

/** 本包名（= package.json 的 name，也是 slot key 的前半）。 */
export const PACKAGE_NAME = "dsh-capability-hub";
/** cordis 行 id（= cordis.patch.yml 里 insert 的 id）。 */
export const ROW_ID = "capability-hub";
/** keyed slot 的 key。 */
export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ROW_ID}`;

/** 行配置组件收到的 props（owner 提供）。 */
export interface ConfigViewProps {
  readonly view?: "summary" | "page";
  readonly form?: unknown;
  readonly t?: (key: string) => string;
  readonly useSessions?: unknown;
  readonly useWorkspaces?: unknown;
  readonly usePanelInfo?: unknown;
  readonly useResource?: unknown;
  [key: string]: unknown;
}

/** 摘要视图：一行说明。 */
function Summary(): React.ReactElement {
  return <span data-testid="capability-hub-row-summary">{tt("config.summary")}</span>;
}

/** 行页面：一个「打开能力中心（MCP 服务器）」按钮。 */
function RowPage({ layout }: { layout: LayoutFace | undefined }): React.ReactElement {
  return (
    <div className={styles.placeholder} data-testid="capability-hub-row-config">
      <p className={styles.placeholderText}>{tt("config.summary")}</p>
      <button
        type="button"
        className={styles.button}
        data-testid="capability-hub-open-mcp"
        onClick={() => openCapabilityHub(layout, "mcp")}
      >
        {tt("config.openMcp")}
      </button>
    </div>
  );
}

/** 行配置组件（两种 view 共用一个组件）。 */
export function CapabilityHubRowConfig(props: ConfigViewProps & { layout?: LayoutFace }): React.ReactElement {
  // view 缺省按 page 处理：行详情页才是这个控件的主场。
  return props.view === "summary" ? <Summary /> : <RowPage layout={props.layout} />;
}

/**
 * 注册行配置控件。
 * @param slots ctx.slots
 * @param layout ctx.get("layout")
 * @returns 解绑函数
 */
export function registerRowConfig(slots: SlotsFace, layout: LayoutFace | undefined): () => void {
  let dispose: (() => void) | undefined;
  try {
    dispose = slots.inject("plugins.row.config", () =>
      slots.register(
        {
          name: "plugins.row.config",
          key: ROW_CONFIG_KEY,
        },
        (props: ConfigViewProps) => <CapabilityHubRowConfig {...props} layout={layout} />,
      ),
    );
  } catch (error) {
    console.warn("[capability-hub] 行配置注册失败：", error);
  }
  return () => {
    try {
      dispose?.();
    } catch {
      /* 解绑失败不影响其他注册 */
    }
  };
}
