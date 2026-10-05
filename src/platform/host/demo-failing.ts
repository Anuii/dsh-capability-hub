/**
 * 「故意失败」的演示模块（可由插件配置 devOverrides.failureDemo 打开）。
 *
 * 用途：证明 F1/D-F1 的「永不失败外壳」真的成立 —— 一个模块抛错时，
 *   - DSH 照常启动、页面照常可用；
 *   - GET health 里该模块显示 degraded 并带中文原因；
 *   - 其他模块与路由不受影响。
 *
 * 覆盖同步抛与异步 reject 两种失败方式。
 */
import type { HubModule } from "./types.ts";

/** 立即同步抛错。 */
export function createThrowingModule(): HubModule {
  throw new Error("故意失败演示（同步）：这个模块在加载时抛错，用于验证降级不影响 DSH");
}

/** 返回 rejected Promise（异步失败）。 */
export function createRejectingModule(): HubModule | Promise<HubModule> {
  return Promise.reject(new Error("故意失败演示（异步）：这个模块返回 rejected Promise，用于验证降级不影响 DSH"));
}

/** 先注册一条路由，再在注册中途冲突失败（用于验证回滚）。 */
export function createPartialModule(existingKey: string): HubModule {
  return {
    routes: {
      [existingKey]: async () => ({ never: true }),
    },
  };
}
