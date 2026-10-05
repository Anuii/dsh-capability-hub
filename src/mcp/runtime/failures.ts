/**
 * 失败与冷却（D-D7）：服务器失败后进入冷却期，期间不自动重试；connect 带 force 可以绕过；
 * 取消不算失败；任何一次成功（探测或调用）清空失败记录。
 */

import type { Clock } from "./atoms/clock.ts";

export interface FailureRecord {
  message: string;
  at: number;
}

/** 毫秒 → 整秒（不小于 0）。 */
export function seconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000));
}

/** 用户取消 / 中止不算失败。 */
export function isCancellation(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return typeof err === "string" && /cancel|abort|取消/i.test(err);
  }
  const value = err as { name?: string; message?: string; code?: string };
  if (value.name === "AbortError" || value.code === "ABORT_ERR") return true;
  const message = value.message ?? "";
  return /已被取消|operation was aborted|aborted|cancel/i.test(message);
}

export class FailureBook {
  readonly #records = new Map<string, FailureRecord>();
  readonly #clock: Clock;
  /** 当前的退避时长（来自全局设置，随配置变化） */
  readonly #backoffMs: () => number;

  constructor(clock: Clock, backoffMs: () => number) {
    this.#clock = clock;
    this.#backoffMs = backoffMs;
  }

  record(serverName: string, message: string): void {
    this.#records.set(serverName, { message, at: this.#clock.now() });
  }

  clear(serverName: string): void {
    this.#records.delete(serverName);
  }

  get(serverName: string): FailureRecord | undefined {
    return this.#records.get(serverName);
  }

  entries(): [string, FailureRecord][] {
    return [...this.#records];
  }

  get size(): number {
    return this.#records.size;
  }

  /** 冷却还剩多少毫秒（不在冷却中为 0）。 */
  remaining(serverName: string): number {
    const failure = this.#records.get(serverName);
    if (!failure) return 0;
    const elapsed = this.#clock.now() - failure.at;
    const backoff = this.#backoffMs();
    return elapsed >= backoff ? 0 : backoff - elapsed;
  }

  /** 冷却期结束的时刻（不在冷却中为 undefined）。 */
  cooldownUntil(serverName: string): number | undefined {
    const failure = this.#records.get(serverName);
    return failure !== undefined && this.remaining(serverName) > 0 ? failure.at + this.#backoffMs() : undefined;
  }

  /** 冷却期内直接返回给模型的说明与剩余时间；force 只对 connect 生效。 */
  blockedMessage(serverName: string, force: boolean): string | undefined {
    if (force) return undefined;
    const remaining = this.remaining(serverName);
    if (remaining <= 0) return undefined;
    const failure = this.#records.get(serverName);
    const now = this.#clock.now();
    const ago = seconds(now - (failure?.at ?? now));
    return (
      '服务器 "' +
      serverName +
      '" 在 ' +
      ago +
      " 秒前失败，冷却还剩 " +
      seconds(remaining) +
      " 秒，这期间不会自动重试。\n" +
      "最近一次失败：" +
      (failure?.message ?? "（无详情）") +
      "\n" +
      '如果配置已经修好，用 mcp({ connect: "' +
      serverName +
      '", force: true }) 立即重试。'
    );
  }
}
