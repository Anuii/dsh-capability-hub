/**
 * 测试夹具：在内存里生成 tar / tar.gz（含 ustar 长路径前缀与 pax 扩展头），
 * 用于验证自写的最小 tar 读取器。不写入任何真实用户目录。
 */

import { gzipSync } from 'node:zlib';

export interface FixtureEntry {
  path: string;
  data?: string | Buffer;
  type?: 'file' | 'dir';
}

export function octal(value: number, length: number): Buffer {
  const text = value.toString(8).padStart(length - 1, '0');
  return Buffer.from(`${text}\0`, 'latin1');
}

function header(entry: { name: string; prefix: string; size: number; type: string }): Buffer {
  const block = Buffer.alloc(512, 0);
  block.write(entry.name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'latin1');
  block.write('0000000\0', 108, 8, 'latin1');
  block.write('0000000\0', 116, 8, 'latin1');
  octal(entry.size, 12).copy(block, 124);
  block.write('00000000000\0', 136, 12, 'latin1');
  block.write('        ', 148, 8, 'latin1'); // checksum 占位（读取端不校验）
  block.write(entry.type, 156, 1, 'latin1');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  block.write(entry.prefix, 345, 155, 'utf8');
  return block;
}

function pad(data: Buffer): Buffer {
  const remainder = data.length % 512;
  if (remainder === 0) return Buffer.alloc(0);
  return Buffer.alloc(512 - remainder, 0);
}

/** 生成 ustar 归档；路径超过 100 字节时自动切分到 prefix 字段。 */
export function buildTar(entries: FixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const isDir = entry.type === 'dir' || entry.path.endsWith('/');
    const data = isDir ? Buffer.alloc(0) : Buffer.from(entry.data ?? '');
    const pathBytes = Buffer.from(entry.path, 'utf8');
    let name = entry.path;
    let prefix = '';
    if (pathBytes.length > 100) {
      const slash = entry.path.lastIndexOf('/');
      prefix = entry.path.slice(0, slash);
      name = entry.path.slice(slash + 1);
    }
    blocks.push(
      header({ name, prefix, size: data.length, type: isDir ? '5' : '0' })
    );
    if (!isDir) {
      blocks.push(data, pad(data));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

/** 生成带 pax 扩展头的归档：pax 记录写在同名条目之前。 */
export function buildTarWithPax(entries: FixtureEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = entry.type === 'dir' ? Buffer.alloc(0) : Buffer.from(entry.data ?? '');
    const record = `path=${entry.path}\n`;
    const bodyLength = Buffer.byteLength(record, 'utf8');
    // "<len> <record>" 中 len 含自身长度，迭代到稳定
    let len = bodyLength + 2;
    while (String(len).length + 1 + bodyLength !== len) len = String(len).length + 1 + bodyLength;
    const paxData = Buffer.from(`${len} ${record}`, 'utf8');
    blocks.push(header({ name: 'PaxHeader/entry', prefix: '', size: paxData.length, type: 'x' }));
    blocks.push(paxData, pad(paxData));
    blocks.push(header({ name: 'truncated-name', prefix: '', size: data.length, type: entry.type === 'dir' ? '5' : '0' }));
    if (entry.type !== 'dir') blocks.push(data, pad(data));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

export function buildTarGz(entries: FixtureEntry[]): Buffer {
  return gzipSync(buildTar(entries));
}

/** 造一个仓库归档：带 codeload 风格的 <repo>-<ref>/ 根前缀。 */
export function repoArchive(
  entries: FixtureEntry[],
  options: { root?: string } = {}
): Buffer {
  const root = options.root ?? 'demo-main';
  const prefixed: FixtureEntry[] = [
    { path: `${root}/`, type: 'dir' },
    ...entries.map((entry) => ({ ...entry, path: `${root}/${entry.path.replace(/^\/+/, '')}` })),
  ];
  return buildTarGz(prefixed);
}

/** 构造一个典型的技能仓库：skills/<category>/<name>/SKILL.md + 附属文件 */
export function skillFixture(
  category: string,
  name: string,
  options: { description?: string; extraFiles?: Record<string, string>; frontmatterName?: string } = {}
): FixtureEntry[] {
  const fmName = options.frontmatterName ?? name;
  const description = options.description ?? `${name} 的说明`;
  const entries: FixtureEntry[] = [
    {
      path: `skills/${category}/${name}/SKILL.md`,
      data: `---\nname: ${fmName}\ndescription: ${description}\n---\n\n# ${fmName}\n\n正文。\n`,
    },
    { path: `skills/${category}/${name}/agents/openai.yaml`, data: `name: ${fmName}\n` },
  ];
  for (const [rel, content] of Object.entries(options.extraFiles ?? {})) {
    entries.push({ path: `skills/${category}/${name}/${rel}`, data: content });
  }
  return entries;
}
