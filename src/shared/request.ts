/**
 * 路由处理器读请求参数的小工具，两类：
 *   - 程序传的参数（id、开关、名字……）：requireString / optionalString / requireBoolean …
 *     不合要求是调用方的错，抛 BAD_REQUEST(400)；字符串原样返回，不做 trim。
 *   - 用户在表单里填的字段（仓库、分支、路径……）：requireInput / optionalInput / optionalInputList / patchInput
 *     去掉首尾空白；不合要求抛 VALIDATION(422)，details 带字段路径，界面能把错误标到那个输入框上。
 * message 都是可以直接展示的中文。
 */

import { badRequest, validation } from "./errors.ts";

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

/** 不是对象就当空对象（查询串、可省略的请求体）。 */
export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 必填的用户输入：非空字符串，去掉首尾空白。 */
export function requireInput(body: Record<string, unknown>, key: string, label: string): string {
  const raw = body[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw validation("参数 " + key + "（" + label + "）不能为空。", [{ path: key, message: "必须是非空字符串" }]);
  }
  return raw.trim();
}

/** 可选的用户输入：去掉首尾空白，空串当作没填。 */
export function optionalInput(body: Record<string, unknown>, key: string): string | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string")
    throw validation("参数 " + key + " 必须是字符串。", [{ path: key, message: "必须是字符串" }]);
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 可选的用户输入列表：每项去掉首尾空白，丢掉空项。 */
export function optionalInputList(body: Record<string, unknown>, key: string): string[] | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw))
    throw validation("参数 " + key + " 必须是字符串数组。", [{ path: key, message: "必须是数组" }]);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      throw validation("参数 " + key + " 里只能放字符串。", [{ path: key, message: "元素必须是字符串" }]);
    }
    const trimmed = item.trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

/** 修改时的用户输入：与 optionalInput 不同，空串有意义（= 清除该字段）。 */
export function patchInput(body: Record<string, unknown>, key: string): string | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string")
    throw validation("参数 " + key + " 必须是字符串。", [{ path: key, message: "必须是字符串" }]);
  return raw.trim();
}
