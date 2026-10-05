/**
 * 可注入的时钟与定时器。
 *
 * 存在的唯一理由：空闲回收 / 退避冷却 / stale 判定都依赖真实时间，
 * 测试里必须能把时间推快，否则只能靠 sleep（慢且抖）。
 * 生产环境一律走真实实现（src/mcp/runtime/module.ts 里不传即可）。
 */
export interface Clock {
  /** 当前时间（epoch ms）。 */
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
