/**
 * 最小 frontmatter 读取（浏览仓库用；只读取不写回，因此不需要 skills-local 那套字节保真改写）。
 *
 * 只实现浏览需要的部分：取 name / description 两个顶层键，支持单双引号、折叠块 >、
 * 字面块 |、嵌套映射跳过、CRLF、BOM 容错。解析失败不抛错，返回空对象。
 */

export interface MiniFrontmatter {
  name?: string;
  description?: string;
  /** 顶层键名清单（调试用） */
  keys: string[];
}

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** 取 SKILL.md 文本的 frontmatter 块（首行裸 --- 到下一行裸 ---），没有则返回 undefined。 */
export function extractFrontmatterBlock(text: string): string | undefined {
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = normalized.split(/\r?\n/);
  if (lines.length === 0 || lines[0]!.trim() !== '---') return undefined;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') return lines.slice(1, i).join('\n');
  }
  return undefined;
}

export function parseMiniFrontmatter(text: string): MiniFrontmatter {
  const block = extractFrontmatterBlock(text);
  if (block === undefined) return { keys: [] };
  const lines = block.split('\n');
  const result: MiniFrontmatter = { keys: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '' || /^\s/.test(line)) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const inline = match[2]!;
    result.keys.push(key);

    if (inline === '>' || inline === '>-' || inline === '>+' || inline === '|' || inline === '|-' || inline === '|+') {
      const chunks: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.trim() !== '' && !/^\s/.test(next)) break;
        chunks.push(next.replace(/^\s+/, ''));
      }
      i = j - 1;
      const folded = inline.startsWith('>')
        ? chunks.join(' ').replace(/\s+/g, ' ').trim()
        : chunks.join('\n').trim();
      if (key === 'name') result.name = folded;
      if (key === 'description') result.description = folded;
      continue;
    }
    if (inline === '') continue; // 嵌套映射或块序列，浏览不需要
    const value = unquote(inline);
    if (key === 'name' && result.name === undefined) result.name = value;
    if (key === 'description' && result.description === undefined) result.description = value;
  }

  return result;
}
