/**
 * 仓库引用解析：owner/name、完整 GitHub URL、带 /tree/<ref>/<path> 的形式。
 * 全部只接受 https/http 的 github.com，拒绝其它 host（避免把任意 URL 当仓库源）。
 */

import { validation } from './errors.ts';
import { describeUnsafePath } from './safepath.ts';

export interface ParsedRepoRef {
  /** owner/name */
  repo: string;
  ref?: string;
  /** 仓库内子路径（/tree/<ref>/<path> 形式时有值），不带前后斜杠 */
  subPath?: string;
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

export function parseRepoRef(input: string): ParsedRepoRef {
  const raw = (input ?? '').trim();
  if (raw === '') throw validation('仓库不能为空，请填写 owner/name 或 GitHub 链接。', [{ path: 'repo', message: '不能为空' }]);

  // 1) 裸 owner/name（可能带子路径的简写 a/b/c 不接受，避免歧义）
  if (!raw.includes('://') && !raw.startsWith('git@')) {
    const parts = raw.split('/').filter((p) => p !== '');
    if (parts.length === 2) return finish(parts[0]!, undefined, parts[1]!);
    if (parts.length > 2) {
      throw validation(`"${raw}" 无法解析：请使用 owner/name，或粘贴完整 GitHub 链接（可带 /tree/<分支>/<子目录>）。`, [
        { path: 'repo', message: 'owner/name 只允许两段' },
      ]);
    }
    throw validation(`"${raw}" 无法解析：应为 owner/name。`, [{ path: 'repo', message: '应为 owner/name' }]);
  }

  // 2) URL
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw validation(`"${raw}" 不是合法链接。`, [{ path: 'repo', message: '非法 URL' }]);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw validation('只支持 https://github.com/... 形式的链接。', [{ path: 'repo', message: '协议不支持' }]);
  }
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    throw validation(`只支持 github.com 的链接，收到的是 ${url.hostname}。`, [{ path: 'repo', message: 'host 不支持' }]);
  }
  const segments = url.pathname.split('/').filter((s) => s !== '');
  if (segments.length < 2) {
    throw validation(`"${raw}" 里没有 owner/name。`, [{ path: 'repo', message: '缺少 owner/name' }]);
  }
  const owner = segments[0]!;
  const name = segments[1]!.replace(/\.git$/i, '');
  if (segments.length === 2) return finish(owner, undefined, name);

  const marker = segments[2]!;
  if (marker === 'tree' || marker === 'blob') {
    if (segments.length < 4) {
      throw validation(`"${raw}" 缺少分支名：/tree/<分支>/<子目录>。`, [{ path: 'repo', message: '缺少 ref' }]);
    }
    const ref = decodeURIComponent(segments[3]!);
    let rest = segments.slice(4).map((s) => decodeURIComponent(s));
    if (marker === 'blob' && rest.length > 0) rest = rest.slice(0, -1); // blob 指向文件，只取目录
    const subPath = rest.join('/');
    return finish(owner, ref, name, subPath === '' ? undefined : subPath);
  }
  if (marker === 'releases' || marker === 'commit' || marker === 'issues' || marker === 'pull') {
    return finish(owner, undefined, name);
  }
  throw validation(`无法识别链接 "${raw}" 的结构，请使用 https://github.com/<owner>/<name> 或 .../tree/<分支>/<子目录>。`, [
    { path: 'repo', message: '不支持的链接形态' },
  ]);
}

function finish(owner: string, ref: string | undefined, name: string, subPath?: string): ParsedRepoRef {
  if (!OWNER_PATTERN.test(owner)) {
    throw validation(`owner "${owner}" 不合法。`, [{ path: 'repo', message: 'owner 不合法' }]);
  }
  if (!REPO_PATTERN.test(name)) {
    throw validation(`仓库名 "${name}" 不合法。`, [{ path: 'repo', message: '仓库名不合法' }]);
  }
  // FIX-5：REPO_PATTERN 会放行 "." 与 ".."，它们会把 codeload / api.github.com 的 URL
  // 路径改写到别处（例如 https://codeload.github.com/owner/../archive/main.tar.gz）—— 必须拒绝。
  if (name === '.' || name === '..') {
    throw validation(`仓库名不能是 "${name}"。`, [{ path: 'repo', message: '仓库名不能是 . 或 ..' }]);
  }
  const out: ParsedRepoRef = { repo: `${owner}/${name}` };
  if (ref !== undefined && ref !== '') out.ref = ref;
  if (subPath !== undefined && subPath !== '') out.subPath = subPath.replace(/^\/+/, '').replace(/\/+$/, '');
  return out;
}

/** 由 skillPath（仓库内 SKILL.md 路径）推出目录名与目录路径 */
export function skillDirOf(skillPath: string): { dirPath: string; dirName: string } {
  const normalized = skillPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  // 根级技能：整个仓库根就是这个技能目录
  if (/^SKILL\.md$/i.test(normalized)) return { dirPath: '', dirName: '' };
  const withoutFile = normalized.replace(/\/SKILL\.md$/i, '');
  const dirPath = withoutFile === normalized ? normalized : withoutFile;
  const dirName = dirPath.split('/').filter((p) => p !== '').pop() ?? dirPath;
  return { dirPath, dirName };
}

/** 把目录补成 SKILL.md 路径 */
export function skillMdPathOf(dirPath: string): string {
  const normalized = dirPath.replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized === '' ? 'SKILL.md' : `${normalized}/SKILL.md`;
}

/**
 * 归一化「仓库内 SKILL.md 路径」：必须是**相对**路径（正斜杠分隔）。
 *
 * FIX-6（D-2）：候选（discover）与已登记条目（lockstore）的 skillPath 都不允许是
 * 本机绝对路径或含盘符 —— 绝对路径（`/x`、`\\x`、`C:/x`）、反斜杠、"." / ".."
 * 段、Windows 保留名等一律返回 undefined，由调用方决定是丢弃候选、还是退回
 * `<目录名>/SKILL.md` 并说明原因（判据与 FIX-5 的 safepath.ts 同一套）。
 */
export function repoRelativeSkillPath(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (value === '') return undefined;
  if (describeUnsafePath(value) !== undefined) return undefined;
  return value;
}
