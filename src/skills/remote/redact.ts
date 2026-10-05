/**
 * 令牌防护：包装 HubLogger，把已知的敏感值从任何输出里抹掉（PLAN §4.4）。
 *
 * 用法：令牌只在 GitHubClient 内部持有；所有日志经由 createRedactingLogger 输出，
 * 一旦令牌字符串出现在日志参数里就被替换成 ***。响应与文件从不写令牌（代码层面没有路径）。
 */

import type { HubLogger } from '../../platform/contract/host.ts';

export const REDACTED = '***';

export class Redactor {
  private secrets = new Set<string>();

  add(secret: string | undefined): void {
    if (!secret) return;
    const trimmed = secret.trim();
    if (trimmed.length < 8) return;
    this.secrets.add(trimmed);
    // 常见包装形式也一并遮蔽
    this.secrets.add(`Bearer ${trimmed}`);
    this.secrets.add(`token ${trimmed}`);
  }

  has(secret: string | undefined): boolean {
    if (!secret) return false;
    return this.secrets.has(secret.trim());
  }

  /** 递归抹掉字符串里出现的敏感值 */
  scrubValue(value: unknown, depth = 0): unknown {
    if (depth > 6) return value;
    if (typeof value === 'string') return this.scrub(value);
    if (Array.isArray(value)) return value.map((v) => this.scrubValue(v, depth + 1));
    if (value instanceof Error) {
      const clone = new Error(this.scrub(value.message));
      return clone;
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[this.scrub(k)] = this.scrubValue(v, depth + 1);
      }
      return out;
    }
    return value;
  }

  scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    // 兜底：任何 ghp_/github_pat_/gho_ 形态的令牌
    out = out.replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED);
    return out;
  }
}

export function createRedactingLogger(logger: HubLogger, redactor: Redactor): HubLogger {
  const wrap =
    (fn: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      fn(...args.map((a) => redactor.scrubValue(a)));
    };
  return {
    debug: wrap(logger.debug.bind(logger)),
    info: wrap(logger.info.bind(logger)),
    warn: wrap(logger.warn.bind(logger)),
    error: wrap(logger.error.bind(logger)),
  };
}
