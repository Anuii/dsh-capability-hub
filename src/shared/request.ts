/**
 * 路由处理器读请求参数的小工具（本地技能与 MCP 配置两个模块共用）：
 * 不合要求时抛 BAD_REQUEST，message 是可以直接展示的中文。字符串原样返回，不做 trim。
 */

import { badRequest } from "./errors.ts";

/** 请求体必须是 JSON 对象。 */
export function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("请求体必须是一个 JSON 对象。");
  }
  return body as Record<string, unknown>;
}

/** 可选字符串：undefined / null / 空串都当作没给。 */
export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw badRequest("参数 " + name + " 必须是字符串。");
  return value;
}

export function requireString(value: unknown, name: string): string {
  const out = optionalString(value, name);
  if (out === undefined) throw badRequest("缺少必填参数 " + name + "。");
  return out;
}

export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw badRequest("参数 " + name + " 必须是布尔值（true/false）。");
  return value;
}

export function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return requireBoolean(value, name);
}

export function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw badRequest("参数 " + name + " 必须是字符串数组。");
  }
  return value as string[];
}
