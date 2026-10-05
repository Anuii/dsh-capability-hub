/**
 * 工具搜索排序（参考实现的简化版）。
 *
 * 字段权重：qualifiedName 12 > originalName 10 > server 8 > description 5 = keywords 5。
 * 分档：整字段精确 > 前缀 > 包含 > 逐 token 精确 > 词干 > 裸子串。
 * 收尾：覆盖率加成 + 首 token 命中限定名加成 + 整字段精确加成。
 * 排序：分数降序，并列按 qualifiedName 的 localeCompare —— 保证同一查询永远同一顺序。
 */
import { MAX_REGEX_QUERY_LENGTH } from "../constants.ts";

export interface RankDocument {
  qualifiedName: string;
  originalName: string;
  server: string;
  description: string;
  keywords: string[];
}

const FIELD_WEIGHTS = [
  ["qualifiedName", 12],
  ["originalName", 10],
  ["server", 8],
  ["description", 5],
  ["keywords", 5],
] as const;

/** camelCase 先切（必须在 toLowerCase 之前，否则边界被毁），再小写，再把非字母数字折成单空格。 */
export function normalize(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  const normalized = normalize(text);
  return normalized.length === 0 ? [] : normalized.split(" ").filter(Boolean);
}

const MIN_STEM_LENGTH = 4;

interface FieldScore {
  score: number;
  phraseMatched: boolean;
  wholeFieldExact: boolean;
  matchedTokens: Set<string>;
}

function scoreField(
  field: string,
  query: string,
  queryTokens: string[],
  queryNormalized: string,
  weight: number,
): FieldScore {
  const result: FieldScore = { score: 0, phraseMatched: false, wholeFieldExact: false, matchedTokens: new Set() };
  if (field.length === 0) return result;
  const normalized = normalize(field);

  if (queryNormalized.length > 0 && normalized === queryNormalized) {
    result.score += weight * 14;
    result.phraseMatched = true;
    result.wholeFieldExact = true;
  } else if (queryNormalized.length > 0 && normalized.startsWith(queryNormalized)) {
    result.score += weight * 9;
    result.phraseMatched = true;
  } else if (queryNormalized.length > 0 && normalized.includes(queryNormalized)) {
    result.score += weight * 6;
    result.phraseMatched = true;
  }

  const fieldTokens = normalized.length === 0 ? [] : normalized.split(" ");
  for (const token of queryTokens) {
    if (fieldTokens.includes(token)) {
      result.score += weight * 4;
      result.matchedTokens.add(token);
      continue;
    }
    let stemmed = false;
    for (const fieldToken of fieldTokens) {
      if (fieldToken.startsWith(token) || (fieldToken.length >= MIN_STEM_LENGTH && token.startsWith(fieldToken))) {
        stemmed = true;
        break;
      }
    }
    if (stemmed) {
      result.score += weight * 2;
      result.matchedTokens.add(token);
      continue;
    }
    if (normalized.includes(token)) {
      result.score += weight * 1;
      result.matchedTokens.add(token);
    }
  }
  return result;
}

export interface RankedMatch {
  doc: RankDocument;
  score: number;
  matchedTokens: string[];
}

export function scoreDocument(doc: RankDocument, query: string): RankedMatch | undefined {
  const queryTokens = tokenize(query);
  const queryNormalized = normalize(query);
  if (queryTokens.length === 0 && queryNormalized.length === 0) return undefined;

  let total = 0;
  let phraseMatched = false;
  let wholeFieldExact = false;
  const matchedTokens = new Set<string>();

  for (const [field, weight] of FIELD_WEIGHTS) {
    if (field === "keywords") {
      // keywords 特殊：逐短语算短语奖励取 max（绝不拼成一个长串，否则短语会跨两个无关关键词匹配）。
      let best = 0;
      let bestPhrase = false;
      const allKeywordTokens = new Set<string>();
      for (const keyword of doc.keywords) {
        const scored = scoreField(keyword, query, queryTokens, queryNormalized, weight);
        if (scored.score > best) best = scored.score;
        if (scored.phraseMatched) bestPhrase = true;
        for (const token of scored.matchedTokens) allKeywordTokens.add(token);
        if (scored.wholeFieldExact) wholeFieldExact = true;
      }
      total += best;
      if (bestPhrase) phraseMatched = true;
      for (const token of allKeywordTokens) matchedTokens.add(token);
      continue;
    }
    const value =
      field === "qualifiedName"
        ? doc.qualifiedName
        : field === "originalName"
          ? doc.originalName
          : field === "server"
            ? doc.server
            : doc.description;
    const scored = scoreField(value, query, queryTokens, queryNormalized, weight);
    total += scored.score;
    if (scored.phraseMatched) phraseMatched = true;
    if (scored.wholeFieldExact) wholeFieldExact = true;
    for (const token of scored.matchedTokens) matchedTokens.add(token);
  }

  const coverage = queryTokens.length === 0 ? 1 : matchedTokens.size / queryTokens.length;
  if (!phraseMatched) {
    if (queryTokens.length <= 2 ? coverage !== 1 : coverage < 0.6) return undefined;
  }

  total += coverage === 1 ? 25 : Math.round(coverage * 10);
  const firstToken = queryTokens[0];
  if (firstToken !== undefined && tokenize(doc.qualifiedName).includes(firstToken)) total += 8;
  if (wholeFieldExact) total += 20;

  return { doc, score: total, matchedTokens: [...matchedTokens] };
}

export function rankDocuments(docs: RankDocument[], query: string): RankedMatch[] {
  const matches: RankedMatch[] = [];
  for (const doc of docs) {
    const scored = scoreDocument(doc, query);
    if (scored) matches.push(scored);
  }
  matches.sort((a, b) => b.score - a.score || a.doc.qualifiedName.localeCompare(b.doc.qualifiedName));
  return matches;
}

export interface RegexSearchResult {
  ok: boolean;
  matches: RankDocument[];
  error?: string;
}

/**
 * 正则模式：所有命中 score 恒为 1，按名字排序。
 * 简化点：只有长度闸与语法错误透传 + 命中数上限（参考实现另有嵌套量词扫描与回溯上限）。
 */
export function searchByRegex(docs: RankDocument[], pattern: string, maxMatches: number): RegexSearchResult {
  if (pattern.length > MAX_REGEX_QUERY_LENGTH) {
    return { ok: false, matches: [], error: "正则太长（上限 " + MAX_REGEX_QUERY_LENGTH + " 个字符）" };
  }
  let regexp: RegExp;
  try {
    regexp = new RegExp(pattern, "i");
  } catch (err) {
    return { ok: false, matches: [], error: (err as Error).message };
  }
  const matches: RankDocument[] = [];
  for (const doc of docs) {
    const haystack = doc.qualifiedName + "\n" + doc.description + "\n" + doc.keywords.join("\n");
    regexp.lastIndex = 0;
    if (regexp.test(haystack)) {
      matches.push(doc);
      if (matches.length >= maxMatches) break;
    }
  }
  matches.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  return { ok: true, matches };
}
