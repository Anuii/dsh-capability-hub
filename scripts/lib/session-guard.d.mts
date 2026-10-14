/**
 * scripts/lib/session-guard.mjs 的类型声明（纯 JS 模块，供 test/scripts/session-guard.test.ts 使用）。
 * 只声明对外导出的形状，实现见同名 .mjs。
 */

/** 会话存储里一个会话目录的键：`<工作区目录名>/<会话目录名>`。 */
export type SessionKey = string;

export declare const SESSION_FILE: string;
export declare const SESSION_DIR_PREFIX: string;
export declare const DEFAULT_MIN_IDLE_MS: number;

export declare function sessionsRoot(env?: Record<string, string | undefined>): string;
export declare function snapshotSessions(root: string): Set<SessionKey>;
export declare function newSessions(before: Set<SessionKey>, after: Set<SessionKey>): SessionKey[];
export declare function redactSession(key: SessionKey): string;
export declare function pickViewTarget(
  root: string,
  options?: { now?: number; minIdleMs?: number },
): string | undefined;
export declare function selectionSeedScript(sessionId: string): string;
