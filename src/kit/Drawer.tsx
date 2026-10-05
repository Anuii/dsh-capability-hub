/**
 * 详情抽屉（UI-DESIGN §1）：从右侧滑出，宽 560px（窄屏 100%）。
 *
 * 无障碍（任务书的硬要求，逐条对应）：
 *   - Esc 关闭、点遮罩关闭；
 *   - 焦点陷阱：打开时把焦点移进抽屉，Tab / Shift+Tab 在抽屉内部环绕；
 *   - 关闭后焦点归还给打开它的那一行（记住打开前的 document.activeElement）；
 *   - prefers-reduced-motion 时不做进出动画（在 kit 样式表的媒体查询里）。
 *
 * 为什么用 portal 到 body：抽屉是 fixed 定位，挂在页面根节点里会被祖先的
 * overflow / stacking context 截断（能力中心的标签正文自己就是滚动容器）。
 */
import * as React from "react";
import { createPortal } from "react-dom";
import { kit } from "./styles.ts";
import { drawerIsFullWidth, drawerKey } from "./pure.ts";

/** 可聚焦元素的选区（焦点陷阱用）。 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** 在抽屉内部收集可聚焦元素（跳过不可见与 aria-hidden 的）。 */
export function focusablesIn(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => {
    if (node.getAttribute("aria-hidden") === "true") return false;
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    if (style !== undefined && (style.display === "none" || style.visibility === "hidden")) return false;
    return true;
  });
}

/** 抽屉的 props。 */
export interface DrawerProps {
  open: boolean;
  title: React.ReactNode;
  /** 副标题（等宽路径）；单行截断，完整内容见 subtitleTitle（省略时用 subtitle 本身）。 */
  subtitle?: string;
  /** 副标题的悬停提示：副标题被缩写（例如 ~\…）时在这里放完整路径。 */
  subtitleTitle?: string;
  /** 头部右侧（例如一个开关）。 */
  headerEnd?: React.ReactNode;
  onClose(): void;
  /** 底部固定操作区（危险操作放最左）。 */
  footer?: React.ReactNode;
  /** 宽度覆盖（默认 560px；安装抽屉用 720px）。 */
  width?: number;
  testId?: string;
  children?: React.ReactNode;
}

/** 右侧详情抽屉。 */
export function Drawer(props: DrawerProps): React.ReactElement | null {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [full, setFull] = React.useState<boolean>(false);
  const { open, onClose } = props;

  // 挂在 body 上；SSR/无 document 时直接不渲染。
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    if (typeof document === "undefined") return;
    setHost(document.body);
  }, []);

  React.useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const measure = (): void => setFull(drawerIsFullWidth(window.innerWidth, props.width ?? 560));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, props.width]);

  // 焦点：打开时移进来，关闭时归还给打开它的那一行。
  React.useEffect(() => {
    if (!open) return;
    const previous =
      typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      if (previous !== null && previous.isConnected) previous.focus();
    };
  }, [open]);

  // 兜底：焦点逃出抽屉时 Esc 仍然关得掉（React 已处理的会被 defaultPrevented 挡掉）。
  React.useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open || host === null) return null;

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const panel = panelRef.current;
    if (panel === null) return;
    const focusables = focusablesIn(panel);
    const current = focusables.indexOf(document.activeElement as HTMLElement);
    const decision = drawerKey(event.key, event.shiftKey, current, focusables.length);
    if (decision.kind === "close") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (decision.kind === "focus") {
      event.preventDefault();
      focusables[decision.index]?.focus();
      return;
    }
    if (decision.kind === "trap") {
      event.preventDefault();
      panel.focus();
    }
  };

  return createPortal(
    <div className={kit.drawerLayer + " " + kit.scope} onKeyDown={onKeyDown}>
      <div
        className={kit.drawerMask}
        data-testid={props.testId === undefined ? undefined : props.testId + "-mask"}
        onClick={onClose}
      />
      <div
        ref={panelRef}
        className={kit.drawer}
        data-full={full ? "" : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={typeof props.title === "string" ? props.title : undefined}
        tabIndex={-1}
        data-testid={props.testId}
        {...(props.width === undefined ? {} : { style: { width: props.width } })}
      >
        <header className={kit.drawerHead}>
          <div className={kit.drawerHeadText}>
            <div className={kit.drawerTitle}>{props.title}</div>
            {props.subtitle === undefined ? null : (
              <div className={kit.drawerSub} title={props.subtitleTitle ?? props.subtitle}>
                {props.subtitle}
              </div>
            )}
          </div>
          <div className={kit.drawerHeadEnd}>
            {props.headerEnd}
            <button
              type="button"
              className={kit.iconButton}
              aria-label="关闭"
              title="关闭"
              data-testid={props.testId === undefined ? undefined : props.testId + "-close"}
              onClick={onClose}
            >
              {"\u00d7"}
            </button>
          </div>
        </header>
        <div className={kit.drawerBody}>{props.children}</div>
        {props.footer === undefined ? null : <footer className={kit.drawerFoot}>{props.footer}</footer>}
      </div>
    </div>,
    host,
  );
}
