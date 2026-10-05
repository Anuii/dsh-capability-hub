/**
 * 可注入时钟：让「空闲回收 / 退避冷却 / 7 天过期」这类时间策略可以被测试精确驱动。
 *
 * 分工（重要）：
 * - **策略时间**走这个时钟（advance 推快）；
 * - **I/O 模拟的延迟**（假服务器"慢响应"）走真实 setTimeout —— 十几毫秒，
 *   既能让并发窗口真实存在，又不会让测试变慢。
 */
import type { Clock } from "../../../../src/mcp/runtime/atoms/clock.ts";

interface FakeTimer {
  id: number;
  due: number;
  fn: () => void;
  cleared: boolean;
}

async function drain(): Promise<void> {
  // 让出若干轮事件循环：关闭链路是多个 await 串起来的，一轮 setImmediate 不够。
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export class FakeClock implements Clock {
  #now: number;
  #timers: FakeTimer[] = [];
  #nextId = 1;

  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimer(fn: () => void, ms: number): unknown {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#timers.push({ id, due: this.#now + Math.max(0, ms), fn, cleared: false });
    return id;
  }

  clearTimer(handle: unknown): void {
    const timer = this.#timers.find((item) => item.id === handle);
    if (timer) timer.cleared = true;
  }

  /**
   * 只把时间推快，**不执行**定时器。
   * 用于「只想让空闲窗口过期」的断言：走 advance 会把每 30 秒一次的巡检也真实跑一遍，
   * 24 小时就是 2880 次巡检 + 文件 IO，测试会白白变慢。
   */
  jump(ms: number): void {
    this.#now += ms;
  }

  /** 推进时间并执行到期的定时器（含它们触发的异步收尾）。 */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const due = this.#timers
        .filter((timer) => !timer.cleared && timer.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      due.cleared = true;
      this.#now = Math.max(this.#now, due.due);
      due.fn();
      await drain();
    }
    this.#now = target;
    await drain();
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待条件成立（用于等后台任务）。 */
export async function waitFor(condition: () => boolean, timeoutMs = 3000, label = "条件"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(5);
  }
  if (!condition()) throw new Error("等待超时：" + label);
}
