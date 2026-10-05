/**
 * 工具名限定与 include/exclude 过滤（F3-Q4 naming.ts）。
 *
 * 三处要点：
 * 1. qualifiedName = \`<server>__<originalName>\`，模型可以用原名、限定名、或 \`__\` 之后的尾巴寻址；
 * 2. include 先查、exclude 后赢；pattern 是名字或 glob（\`*\` 匹配任意长字符），大小写不敏感；
 * 3. **过滤只发生在读侧，永不写入缓存** —— 缓存了过滤后的集合，一个被后来删掉的 excludeTools
 *    丢掉过的工具就永远回不来了。
 */

/** 构造限定名。 */
export function qualify(serverName: string, toolName: string): string {
  return serverName + '__' + toolName;
}

const STAR = '\u0000STAR\u0000';

/** glob → 正则（只有 * 是元字符，其余字面量）。 */
export function globToRegExp(pattern: string): RegExp {
  const parts = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, (ch) => '\\' + ch));
  return new RegExp('^(?:' + parts.join('.*') + ')$', 'i');
}

const globCache = new Map<string, RegExp>();

export function matchesPattern(pattern: string, candidate: string): boolean {
  if (pattern === candidate) return true;
  if (!pattern.includes('*')) return pattern.toLowerCase() === candidate.toLowerCase();
  let regexp = globCache.get(pattern);
  if (regexp === undefined) {
    regexp = globToRegExp(pattern);
    if (globCache.size > 512) globCache.clear();
    globCache.set(pattern, regexp);
  }
  return regexp.test(candidate);
}

/** 一个工具可以被三种拼写寻址。 */
export function toolCandidates(serverName: string, originalName: string): string[] {
  const qualified = qualify(serverName, originalName);
  const tail = qualified.slice(qualified.indexOf('__') + 2);
  const list = [originalName, qualified];
  if (tail !== originalName) list.push(tail);
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

/** 按工具名收集 searchKeywords（key 按原名/限定名/glob 匹配，每个命中的 entry 都贡献，结果去重）。 */
export function keywordsFor(
  server: { serverName: string; searchKeywords: Record<string, string[]> },
  originalName: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [key, values] of Object.entries(server.searchKeywords ?? {})) {
    if (!Array.isArray(values)) continue;
    if (!matchesAny([key], server.serverName, originalName)) continue;
    for (const value of values) {
      if (typeof value === 'string' && value.length > 0 && !seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
    }
  }
  return out;
}
