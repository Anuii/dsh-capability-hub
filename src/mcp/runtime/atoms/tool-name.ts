/**
 * 工具名限定与 include/exclude 过滤（F3-Q4 naming.ts）。
 *
 * 三处要点：
 * 1. qualifiedName = \`<server>__<originalName>\`，模型可以用原名、限定名、或 \`__\` 之后的尾巴寻址；
 * 2. include 先查、exclude 后赢；pattern 是名字或 glob（\`*\` 匹配任意长字符），大小写不敏感；
 * 3. **过滤只发生在读侧，永不写入缓存** —— 缓存了过滤后的集合，一个被后来删掉的 excludeTools
 *    丢掉过的工具就永远回不来了。
 */

import { createHash } from "node:crypto";

/** 构造限定名。 */
export function qualify(serverName: string, toolName: string): string {
  return serverName + "__" + toolName;
}

/** DeepSeek 的函数名约束：最多 64 个字符，只允许 [A-Za-z0-9_-]。 */
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;

/**
 * 模型看到的工具名（与 DSH 自带 dsh-mcp-client 的 publicToolName 同一算法）：干净的情况就是
 * `mcp__<server>__<tool>`；有不合规字符或超长时替换、截断，并接上身份的 12 位 SHA-256，保证不同工具不会撞名。
 */
export function publicToolName(serverName: string, toolName: string): string {
  const joined = "mcp__" + serverName + "__" + toolName;
  const normalized = joined.replace(INVALID_NAME_CHARS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
  const hash = createHash("sha256")
    .update(serverName + "\0" + toolName)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  return normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1) + "_" + hash;
}

const STAR = "\u0000STAR\u0000";

/** glob → 正则（只有 * 是元字符，其余字面量）。 */
export function globToRegExp(pattern: string): RegExp {
  const parts = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, (ch) => "\\" + ch));
  return new RegExp("^(?:" + parts.join(".*") + ")$", "i");
}

const globCache = new Map<string, RegExp>();

export function matchesPattern(pattern: string, candidate: string): boolean {
  if (pattern === candidate) return true;
  if (!pattern.includes("*")) return pattern.toLowerCase() === candidate.toLowerCase();
  let regexp = globCache.get(pattern);
  if (regexp === undefined) {
    regexp = globToRegExp(pattern);
    if (globCache.size > 512) globCache.clear();
    globCache.set(pattern, regexp);
  }
  return regexp.test(candidate);
}

/** include / exclude 的 pattern 可以对上的几种拼写：原名、`<server>__<原名>`、模型看到的名字。 */
export function toolCandidates(serverName: string, originalName: string): string[] {
  const qualified = qualify(serverName, originalName);
  const tail = qualified.slice(qualified.indexOf("__") + 2);
  const list = [originalName, qualified];
  if (tail !== originalName) list.push(tail);
  list.push(publicToolName(serverName, originalName));
  return list;
}

export function matchesAny(patterns: string[], serverName: string, originalName: string): boolean {
  if (patterns.length === 0) return false;
  const candidates = toolCandidates(serverName, originalName);
  for (const pattern of patterns) {
    for (const candidate of candidates) {
      if (matchesPattern(pattern, candidate)) return true;
    }
  }
  return false;
}

/** include 先查、exclude 后赢。两者都为空 ⇒ 全部通过。 */
export function isToolIncluded(
  server: { serverName: string; includeTools?: string[]; excludeTools?: string[] },
  originalName: string,
): boolean {
  const include = server.includeTools ?? [];
  const exclude = server.excludeTools ?? [];
  if (include.length > 0 && !matchesAny(include, server.serverName, originalName)) return false;
  if (exclude.length > 0 && matchesAny(exclude, server.serverName, originalName)) return false;
  return true;
}
