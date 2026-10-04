/**
 * 来源推测（D-B8）：为没有来源记录的技能找候选。只返回候选，不登记。
 *
 * 候选来源（按可信度）：
 *   1. lock 中已出现的仓库 + 预置仓库 + 用户添加的仓库 → 目录名/name 同名匹配
 *   2. 技能目录内文本文件里出现的 github.com/<owner>/<repo> 与 raw.githubusercontent.com 链接
 * 给出 confidence 与中文 reason。
 */

import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { walkFiles } from './fsx.ts';
import { repoRelativeSkillPath, skillMdPathOf } from './sourceurl.ts';
import { isFlatSkill } from './skillshape.ts';
import type { DiscoverCandidate, RepoRecord, SkillsLocalApi, SourceEntry } from './types.ts';
import type { SourceStore } from './lockstore.ts';

/** 扫描链接时只看这些小体积文本文件，避免读大二进制 */
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.ps1', '.sh', '.bash', '.cmd', '.bat',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.toml', '.ini', '.cfg', '.conf', '.html',
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 400;

const GITHUB_URL_PATTERN = /(?:https?:\/\/)?(?:raw\.githubusercontent\.com|github\.com)\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)/g;

/**
 * 这些 owner 是普通链接目标 / GitHub 的保留一级路径，不是技能来源。
 * FIX-6（D-4）：补上 GitHub 的保留路径（github.com/sponsors/<name> 曾被当成仓库
 * `sponsors/<name>` 推荐给用户）。清单取「至少覆盖」的保守集合，宁多勿少。
 */
const IGNORED_OWNERS = new Set([
  // 链接目标（原本就有）
  'github', 'www', 'docs', 'gist', 'api', 'codeload', 'raw', 'objects', 'avatars', 'user-images', 'assets',
  // GitHub 保留路径（FIX-6 / D-4）
  'sponsors', 'orgs', 'apps', 'marketplace', 'settings', 'features', 'topics', 'collections', 'explore',
  'login', 'about', 'pricing', 'enterprise', 'issues', 'pulls', 'notifications', 'search', 'users', 'site',
  'security', 'customer-stories', 'readme',
]);

export interface DiscoverOptions {
  ids?: string[];
  workspace?: string;
}

export interface DiscoverDeps {
  skills: SkillsLocalApi;
  sources: SourceStore;
  repos: { list(): Promise<RepoRecord[]>; presets(): { repo: string; ref?: string; note: string }[] };
}

/**
 * 本机技能目录所在的 git 工作区（D-2 用：把「本机布局」翻译成「仓库内路径」）。
 * 只有本机目录确实是**候选仓库**的克隆时，这个布局才等于上游布局。
 */
interface LocalCheckout {
  /** 技能目录的真实路径（跟随链接 / junction） */
  dir: string;
  /** 仓库根绝对路径 */
  root: string;
  /** .git/config 里的 origin（owner/name，小写）；没有 origin 时 undefined */
  origin?: string;
  /** 技能目录在仓库内的 SKILL.md 路径（正斜杠）；算不出来时 undefined */
  skillPath?: string;
}

/** 技能目录在仓库根之下的 SKILL.md 路径；目录不在仓库里 / 结果不安全 → undefined */
function skillMdPathUnder(root: string, dir: string): string | undefined {
  const rel = path.relative(root, dir).split(path.sep).join('/');
  if (rel === '') return 'SKILL.md';
  if (rel === '..' || rel.startsWith('../')) return undefined;
  return repoRelativeSkillPath(`${rel}/SKILL.md`);
}

/** dir 的 git 目录（.git 目录，或 worktree/submodule 的 `.git` 文件里记的路径） */
async function gitDirOf(dir: string): Promise<string | undefined> {
  const marker = path.join(dir, '.git');
  try {
    const stats = await stat(marker);
    if (stats.isDirectory()) return marker;
    if (!stats.isFile()) return undefined;
    const text = await readFile(marker, 'utf8');
    const match = /^gitdir:\s*(.+)$/im.exec(text);
    if (match === null) return undefined;
    const target = match[1]!.trim();
    return path.isAbsolute(target) ? target : path.resolve(dir, target);
  } catch {
    return undefined;
  }
}

/** git remote URL → owner/name（小写）；不是 github.com 的一律 undefined */
export function repoOfGitUrl(url: string): string | undefined {
  const match = /github\.com[/:]([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (match === null) return undefined;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

/** .git/config 里的 origin 仓库（只读；读不到就 undefined） */
async function originOfGitDir(gitDir: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path.join(gitDir, 'config'), 'utf8');
  } catch {
    return undefined;
  }
  let inOrigin = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/i.exec(line);
    if (match !== null) return repoOfGitUrl(match[1]!);
  }
  return undefined;
}

/** 从 dir 向上找 .git 得到仓库根（跟随链接），并读出 origin 与仓库内位置 */
async function localCheckoutOf(dir: string): Promise<LocalCheckout | undefined> {
  let current: string;
  try {
    current = await realpath(dir);
  } catch {
    return undefined;
  }
  const start = current;
  for (;;) {
    const gitDir = await gitDirOf(current);
    if (gitDir !== undefined) {
      const checkout: LocalCheckout = { dir: start, root: current };
      const origin = await originOfGitDir(gitDir);
      if (origin !== undefined) checkout.origin = origin;
      const skillPath = skillMdPathUnder(current, start);
      if (skillPath !== undefined) checkout.skillPath = skillPath;
      return checkout;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function discoverSources(deps: DiscoverDeps, options: DiscoverOptions): Promise<DiscoverCandidate[]> {
  const listed = await deps.skills.list({ workspace: options.workspace });
  const wanted = options.ids && options.ids.length > 0 ? new Set(options.ids) : undefined;
  const existing = new Set((await deps.sources.list()).map((e: SourceEntry) => e.skillId));

  const repoPool = new Map<string, { repo: string; ref?: string; note: string }>();
  for (const preset of deps.repos.presets()) {
    repoPool.set(preset.repo.toLowerCase(), { repo: preset.repo, ref: preset.ref, note: '预置仓库' });
  }
  for (const repo of await deps.repos.list()) {
    if (!repoPool.has(repo.repo.toLowerCase())) {
      repoPool.set(repo.repo.toLowerCase(), { repo: repo.repo, ref: repo.ref, note: '你添加的仓库' });
    }
  }
  for (const entry of await deps.sources.list()) {
    const key = entry.repo.toLowerCase();
    if (!repoPool.has(key)) repoPool.set(key, { repo: entry.repo, ref: entry.ref, note: 'lock 中已出现过的仓库' });
  }

  const candidates: DiscoverCandidate[] = [];
  for (const skill of listed.skills) {
    if (wanted && !wanted.has(skill.id)) continue;
    if (existing.has(skill.id)) continue;
    if (!skill.writable) continue;
    // FIX-2（调度者决定）：平铺 .md 技能不参与来源推测 —— 显式跳过，明确不给出候选，
    // 而不是依赖 walkFiles 对文件恰好返回空数组这种「碰巧不崩」的行为。
    if (await isFlatSkill(skill)) continue;

    // D-2：本机目录若正好是某个仓库的 git 工作区（技能目录是指向本地克隆的链接时
    // 就是这样），那它的目录布局就能翻译成「技能在仓库内的位置」；否则只能按目录名猜。
    const local = await localCheckoutOf(skill.path);
    const verifiedSkillPath = (repo: string): string | undefined =>
      local?.origin !== undefined && local.origin === repo.toLowerCase() ? local.skillPath : undefined;

    const key = (skill.name ?? skill.dirName).toLowerCase();
    const dirKey = skill.dirName.toLowerCase();
    for (const pooled of repoPool.values()) {
      const repoName = pooled.repo.split('/')[1] ?? '';
      const repoBase = repoName.toLowerCase();
      if (repoBase === key || repoBase === dirKey) {
        const skillPath = repoRelativeSkillPath(verifiedSkillPath(pooled.repo) ?? skillMdPathOf(skill.dirName));
        if (skillPath === undefined) continue;
        candidates.push({
          skillId: skill.id,
          repo: pooled.repo,
          ref: pooled.ref,
          skillPath,
          confidence: 'medium',
          reason: `仓库 ${pooled.repo} 的名字与技能名「${skill.name ?? skill.dirName}」相同（${pooled.note}），可能就是这个技能的来源，需要拉取上游后才能确认。`,
        });
      }
    }

    const files = await walkFiles(skill.path);
    const links = await scanLinks(files);
    for (const link of links) {
      const pooled = repoPool.get(link.repo.toLowerCase());
      const verified = verifiedSkillPath(link.repo);
      // D-2：绝不能把本机绝对路径当 skillPath。能确定仓库内位置就用它（high），
      // 不能就退回本机目录名（相对路径，updates 会按目录名在上游唯一匹配）并降为 low + 说明。
      const skillPath = repoRelativeSkillPath(verified ?? skillMdPathOf(skill.dirName));
      if (skillPath === undefined) continue;
      candidates.push({
        skillId: skill.id,
        repo: link.repo,
        ref: pooled?.ref ?? link.ref,
        skillPath,
        confidence: verified !== undefined ? 'high' : 'low',
        reason:
          verified !== undefined
            ? `技能目录内的文件里出现了 ${link.repo} 的链接（${link.where}），来源很可能就是它。`
            : `技能目录内的文件里出现了 ${link.repo} 的链接（${link.where}），来源很可能就是它；但本机技能目录不在（或不是）这个仓库的 git 工作区里，无法确定它在仓库内的位置，路径按本机目录名「${skill.dirName}」推测，写入后请再核对一次。`,
      });
    }
  }

  // 去重（同一 skillId + repo 只留置信度最高的一条）
  const deduped = new Map<string, DiscoverCandidate>();
  const rank: Record<DiscoverCandidate['confidence'], number> = { high: 0, medium: 1, low: 2 };
  for (const candidate of candidates) {
    const key = `${candidate.skillId}|${candidate.repo.toLowerCase()}|${candidate.skillPath}`;
    const prev = deduped.get(key);
    if (!prev || rank[candidate.confidence] < rank[prev.confidence]) deduped.set(key, candidate);
  }
  return [...deduped.values()].sort(
    (a, b) => rank[a.confidence] - rank[b.confidence] || a.skillId.localeCompare(b.skillId)
  );
}

interface ScannedLink {
  repo: string;
  ref: string;
  where: string;
}

async function scanLinks(files: { rel: string; abs: string }[]): Promise<ScannedLink[]> {
  const out: ScannedLink[] = [];
  const seen = new Set<string>();
  let inspected = 0;
  for (const file of files) {
    if (inspected >= MAX_FILES || out.length >= 10) break;
    const ext = path.extname(file.rel).toLowerCase();
    if (ext !== '' && !TEXT_EXTENSIONS.has(ext)) continue;
    inspected += 1;
    let buffer: Buffer;
    try {
      buffer = await readFile(file.abs);
    } catch {
      continue;
    }
    if (buffer.length > MAX_FILE_BYTES) continue;
    const text = buffer.toString('utf8');
    GITHUB_URL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = GITHUB_URL_PATTERN.exec(text)) !== null) {
      const owner = match[1]!;
      const repoName = match[2]!.replace(/\.git$/i, '');
      if (IGNORED_OWNERS.has(owner.toLowerCase())) continue;
      const repo = `${owner}/${repoName}`;
      const key = `${repo.toLowerCase()}|${file.rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ repo, ref: 'main', where: file.rel });
    }
  }
  return out;
}
