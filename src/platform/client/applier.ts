/**
 * 客户端半的装配（把 index.tsx 的 apply 与各 shell 部件解耦，便于单测）。
 *
 * 设计约束：客户端插件与宿主插件一样「永不失败」——任何一步抛错都只 warn，
 * 绝不冒泡到 DSH 的 loader，否则一个 UI 插件会把整页拖下水。
 */
import { injectStyles } from "./styles.ts";
import { injectKitStyles } from "../../kit/index.ts";
import { LOCALE_NS, setRuntimeTranslate, en, zh } from "./strings.ts";
import { registerCapabilityHubPanel, type LayoutFace, type SlotsFace } from "./page.tsx";
import { registerRowConfig } from "./config-button.tsx";
import { sessionSourceFromCtx, setSessionSource } from "./useCurrentWorkspace.ts";

/** 客户端 cordis ctx 的最小面。 */
interface ClientCtx {
  slots?: SlotsFace;
  locale?: {
    register(namespace: string, dictionaries: Record<string, unknown>): () => void;
    bind(namespace: string): (key: string, values?: Record<string, unknown>) => string;
  };
  effect?(callback: () => unknown, label?: string): unknown;
  get?(name: string, strict?: boolean): unknown;
}

/** 一条加载诊断（health 读不到，只在控制台可见）。 */
interface ClientDiagnostics {
  steps: string[];
  errors: string[];
}

const diagnostics: ClientDiagnostics = { steps: [], errors: [] };

/** 客户端诊断快照（页面上的环境卡片会显示步骤数）。 */
export function clientDiagnostics(): ClientDiagnostics {
  return { steps: [...diagnostics.steps], errors: [...diagnostics.errors] };
}

/** 把一步包进 try/catch。 */
function step(label: string, action: () => void): void {
  try {
    action();
    diagnostics.steps.push(label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.errors.push(`${label}: ${message}`);
    console.warn(`[capability-hub] 客户端步骤失败（${label}）：`, error);
  }
}

/** 挂载全部客户端部件。 */
export function installApplier(ctx: unknown): void {
  const view = ctx as ClientCtx;
  const disposers: Array<() => void> = [];
  const layout = ((): LayoutFace | undefined => {
    try {
      return view.get?.("layout", false) as LayoutFace | undefined;
    } catch {
      return undefined;
    }
  })();

  step("styles", () => injectStyles());
  // kit 的样式表是独立的一张 <style>（前缀 chk_），同样一次注入、幂等。
  step("kit-styles", () => injectKitStyles());

  const locale = view.locale;
  if (locale !== undefined) {
    step("locale", () => {
      const dispose = locale.register(LOCALE_NS, { zh, en });
      if (typeof dispose === "function") disposers.push(dispose);
    });
    step("locale-bind", () => {
      setRuntimeTranslate(locale.bind(LOCALE_NS));
    });
  } else {
    diagnostics.errors.push("locale: 服务缺失，使用文档语言兜底");
  }

  step("sessions", () => {
    const source = sessionSourceFromCtx(ctx);
    setSessionSource(source === undefined ? undefined : () => source);
    if (source === undefined) diagnostics.errors.push("sessions: 服务缺失，useCurrentWorkspace 将返回 undefined");
  });

  const slots = view.slots;
  if (slots === undefined) {
    diagnostics.errors.push("slots: 服务缺失，页面未注册");
  } else {
    step("panel", () => disposers.push(registerCapabilityHubPanel(slots, layout)));
    step("row-config", () => disposers.push(registerRowConfig(slots, layout)));
  }

  const cleanup = (): void => {
    setRuntimeTranslate(undefined);
    setSessionSource(undefined);
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 解绑失败不影响其他部件 */
      }
    }
  };

  // 开发期诊断入口：无头/控制台里可以直接跑
  //   globalThis.__dshCapabilityHubDiagnostics()
  // 看客户端每一步是否成功（steps）以及哪些服务缺失（errors）。见 docs/CLIENT-GUIDE.md。
  step("diagnostics-hook", () => {
    (globalThis as { __dshCapabilityHubDiagnostics?: () => unknown }).__dshCapabilityHubDiagnostics = () =>
      clientDiagnostics();
  });

  if (typeof view.effect === "function") {
    step("effect", () => {
      view.effect?.(() => cleanup, "capability-hub: ui mounts");
    });
  } else {
    // 没有 effect 时也要保证能解绑：挂到全局，页面重载自然清空。
    step("no-effect", () => {
      const globalFace = globalThis as { __dshCapabilityHubDispose?: () => void };
      globalFace.__dshCapabilityHubDispose = cleanup;
    });
  }
}
