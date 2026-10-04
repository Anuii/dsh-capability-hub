/**
 * mcp-config 测试的公共夹具。
 * 所有落盘一律在 os.tmpdir() 下的临时目录里，绝不触碰真实用户目录（PLAN §4）。
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HubContext, HubLogger, RouteRequest } from '../../src/host/mcp-config/types.ts';

export interface TempDir {
  path: string;
  cleanup(): Promise<void>;
}

export async function makeTempDir(prefix = 'mcp-config-test-'): Promise<TempDir> {
  const path = await fs.mkdtemp(join(tmpdir(), prefix));
  return {
    path,
    async cleanup() {
      await fs.rm(path, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

export interface RecordingLogger extends HubLogger {
  entries: { level: string; args: unknown[] }[];
  text(): string;
}

export function recordingLogger(): RecordingLogger {
  const entries: { level: string; args: unknown[] }[] = [];
  const push = (level: string) => (...args: unknown[]) => {
    entries.push({ level, args });
  };
  return {
    entries,
    text: () => entries.map((e) => e.level + ' ' + e.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')).join('\n'),
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

export function makeContext(hubHome: string, homeDir: string, logger: HubLogger = recordingLogger()): HubContext & { logger: HubLogger } {
  return {
    homeDir,
    dshHome: join(hubHome, '..'),
    hubHome,
    profileName: 'test',
    logger,
    customSkillDirs: [],
  };
}

export function makeRequest(body: unknown = undefined, query: Record<string, string> = {}): RouteRequest {
  return { query, body, signal: new AbortController().signal };
}

/** 直接调用一个路由 handler 并把返回的 data 取出来。 */
export async function callRoute(
  routes: Record<string, (req: RouteRequest) => Promise<unknown>>,
  key: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<unknown> {
  const handler = routes[key];
  if (handler === undefined) throw new Error('路由不存在：' + key);
  return await handler(makeRequest(body, query));
}

/** 断言抛出的错误带指定 status/code（PLAN §3.1）。 */
export interface AssertedError {
  status?: number;
  code?: string;
  message: string;
  details?: unknown;
}

export async function expectRejection(fn: () => Promise<unknown>): Promise<AssertedError> {
  try {
    await fn();
  } catch (error) {
    const e = error as { status?: number; code?: string; message?: string; details?: unknown };
    return { status: e.status, code: e.code, message: e.message ?? '', details: e.details };
  }
  throw new Error('预期抛出错误，但调用成功返回了。');
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
