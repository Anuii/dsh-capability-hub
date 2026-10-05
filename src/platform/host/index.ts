/**
 * dsh-capability-hub 宿主半的 cordis 插件入口。
 *
 * 这个文件只做三件事：
 *   1. declare 插件名与 inject（保持 inject = [] —— 外壳不依赖任何服务，
 *      因此永远不会因为缺服务而 pending/失败）；
 *   2. apply() 里组装外壳，并把 HTTP 路由交给 ctx.connection.fetch（已鉴权通道）；
 *   3. 把外壳注册进 ctx.effect，让 fiber 卸载时干净回收。
 *
 * 条目 id 由 cordis.patch.yml 声明为 capability-hub，刻意避开 DSH 硬编码的 7 个
 * 启动关键 id（agent-loop / webserver / modules / connection / headless-runner /
 * acp / sdk-jsonrpc-server），所以本插件任何失败都不会终止 dsh web 启动。
 */
import { createShell, type Shell } from "./shell.ts";
import type { PlatformConfig } from "./hub-context.ts";

/** 稳定插件名。 */
export const name = "capability-hub";

/** 不依赖任何服务：外壳自己按需、按 try/catch 取服务。 */
export const inject: string[] = [];

/**
 * 刻意**不导出 `Config`**。
 *
 * cordis 的 resolveConfig（cordis/lib/index.js:956-962）只在插件导出 Config 时把它当
 * standard-schema 用：`runtime.Config["~standard"].validate(config)`。导出普通对象（例如
 * `{}`）会让 `Config["~standard"]` 是 undefined，于是在 `.validate` 上抛
 * `TypeError: Cannot read properties of undefined (reading 'validate')`，整个 fiber 直接
 * failed（实测：.dev/logs/probe-run.log.err 与 .dsh/logs/startup-2026-10-04T07-42-49*.log）。
 * 若改为导出 schemastery schema，则要静态依赖 @deepseek-ai/schemastery。
 *
 * 不导出 Config 时 cordis 走 `if (!runtime.Config) return config` 分支，把
 * cordis.patch.yml 里的 config 原样交给 apply()；校验由 hub-context.ts 自己做
 * （宽松、永不抛）。阶段 A 也不需要 DSH 的配置表单。
 */
export type { PlatformConfig };

/**
 * 挂载能力中心宿主半。
 * @param ctx DSH 根上下文
 * @param config 插件配置（cordis.patch.yml 里那一节）
 */
export function apply(ctx: unknown, config: PlatformConfig = {}): void {
  const packageRoot = import.meta.dirname ?? "";
  const face = ctx as {
    logger?: unknown;
    effect?: (callback: () => unknown, label?: string) => unknown;
    connection?: unknown;
    on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  };
  // 这里刻意用 console 兜底：外壳还没建起来之前 logger 可能拿不到。
  const logger = {
    debug: (...a: unknown[]) =>
      Reflect.get(face.logger ?? console, "debug")?.call(face.logger ?? console, "[capability-hub]", ...a),
    info: (...a: unknown[]) =>
      Reflect.get(face.logger ?? console, "info")?.call(face.logger ?? console, "[capability-hub]", ...a),
    warn: (...a: unknown[]) =>
      Reflect.get(face.logger ?? console, "warn")?.call(face.logger ?? console, "[capability-hub]", ...a),
    error: (...a: unknown[]) =>
      Reflect.get(face.logger ?? console, "error")?.call(face.logger ?? console, "[capability-hub]", ...a),
  };

  let shell: Shell | undefined;

  const boot = async (): Promise<void> => {
    try {
      shell = await createShell(ctx, config ?? {}, packageRoot);
    } catch (error) {
      logger.error("外壳组装失败（已降级，不影响 DSH）：", error instanceof Error ? error.message : error);
      return;
    }
    // 路由注册由外壳负责（createShell 的第 5 步，必须是「模块加载之后」）：
    // 注册进 ctx.connection.fetch 的 exact Fetch 路由表，继承 DSH 的信任闸与 browser-auth。
    const registered = shell.registeredPaths();
    if (registered.length === 0) {
      logger.error(`没有成功注册任何已鉴权路由：${shell.registrationError() ?? "未知原因"}`);
    } else {
      logger.info(`已鉴权路由 ${registered.length} 条：${registered.join(", ")}`);
    }
  };

  // 异步启动：不阻塞 apply（apply 返回的 Promise 会被 loader 等待，但我们的失败
  // 都在 boot() 内部被吞掉了，不会变成 fiber 失败）。
  if (typeof face.effect === "function") {
    try {
      face.effect(() => {
        void boot().catch((error: unknown) => {
          logger.error(
            "外壳异步启动未捕获异常（已降级，不影响 DSH）：",
            error instanceof Error ? error.message : error,
          );
        });
        return async () => {
          try {
            await shell?.dispose();
          } catch {
            /* 卸载失败不影响 DSH */
          }
        };
      }, "capability-hub: shell");
    } catch (error) {
      logger.error(`注册 fiber effect 失败：${error instanceof Error ? error.message : error}`);
    }
  } else {
    void boot().catch((error: unknown) => {
      logger.error("外壳异步启动未捕获异常（已降级，不影响 DSH）：", error instanceof Error ? error.message : error);
    });
  }
}
