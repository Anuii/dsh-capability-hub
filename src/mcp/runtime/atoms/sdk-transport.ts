/**
 * SDK 访问的唯一入口。
 *
 * 两个理由：
 * 1. **测试注入** —— 单测用的是内存假 SDK（假 Client / 假 Transport），
 *    不能 import 任何真实包；真实包只在集成测试里通过 createRequire 进 asar 加载。
 * 2. **契约形状** —— PLAN §3.6 的 McpSdk 由平台层注入；这里做一次防御性校验，
 *    并在缺字段时给出中文的、可执行的报错（而不是等到 undefined 上调用才崩）。
 *
 * 注意：真正被调用时优先用注入对象上的字段（可能是 SDK 的真实导出），
 * 本文件顶部的 fallback 只是为了给「未注入 getDefaultEnvironment」这种情况兜底。
 */
import { fallbackDefaultEnvironment } from './sandbox-env.ts';
import type { McpSdk } from '../contract.ts';

/** 注入 SDK 的形状校验。缺少必需字段时报出中文、可操作的错误。 */
export function assertSdk(sdk: McpSdk | undefined): McpSdk {
  if (!sdk || typeof sdk !== 'object') {
    throw new Error('MCP 运行时缺少 SDK：平台层必须注入 { Client, StdioClientTransport, StreamableHTTPClientTransport }');
  }
  const missing: string[] = [];
  if (typeof sdk.Client !== 'function') missing.push('Client');
  if (typeof sdk.StdioClientTransport !== 'function') missing.push('StdioClientTransport');
  if (typeof sdk.StreamableHTTPClientTransport !== 'function') missing.push('StreamableHTTPClientTransport');
  if (missing.length > 0) {
    throw new Error('MCP 运行时注入的 SDK 不完整，缺少：' + missing.join('、'));
  }
  return sdk;
}

/**
 * getDefaultEnvironment 的取值：注入优先，否则用内置白名单等价实现。
 * 只在这一个地方决定，其它模块一律从这里取。
 */
export function getDefaultEnvironment(): Record<string, string> {
  return fallbackDefaultEnvironment();
}

void 0;
