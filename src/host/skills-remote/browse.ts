/**
 * 浏览仓库：下载 tar.gz → 找出所有含 SKILL.md 的技能目录 → 解析 name/description →
 * 标出本机已安装的（按 dirName / name 匹配 deps.skills.list）。
 *
 * FIX-7：根级 SKILL.md（dirPath === ''，技能 = 仓库根）算一个技能，skillPath = "SKILL.md"
 * —— 与 POST skills/install 接受的同一个值；内容选择与安装端共用 rootskill.ts。
 */

import { filesUnderDirectory } from './tar.ts';
import { rootSkillFiles, sanitizeName } from './rootskill.ts';
import { safeRelativePath, safeSegmentName } from './safepath.ts';
import { parseMiniFrontmatter } from './frontmatter.ts';
import { skillDirOf, skillMdPathOf } from './sourceurl.ts';
import { upstream } from './errors.ts';
import type { GitHubClient } from './github.ts';
import type { BrowseResult, BrowseSkill, SkillsLocalApi } from './types.ts';

/** 与 npx skills 的 copyDirectory 排除清单对齐（快照与安装都不带这些） */
const BROWSE_SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '__pypackages__']);

/** 扫描深度上限：SKILL.md 的路径段数不超过 6（与 blob.ts 的 fallback 一致） */
const MAX_DEPTH = 6;

export interface BrowseOptions {
  repo: string;
  ref?: string;
  /** 只在子路径下查找（来自 /tree/<ref>/<path>） */
  subPath?: string;
  workspace?: string;
  signal?: AbortSignal;
}

export interface BrowseDeps {
  github: GitHubClient;
  skills: SkillsLocalApi;
}

export async function browseRepo(deps: BrowseDeps, options: BrowseOptions): Promise<BrowseResult> {
  const tarball = await deps.github.downloadTarball(options.repo, options.ref, options.signal);
  const entries = tarball.entries;
  const prefix = options.subPath ? `${options.subPath.replace(/\/+$/, '')}/` : '';

  const skillMdPaths = entries
    .filter((e) => e.type === 'file' && /(^|\/)SKILL\.md$/i.test(e.path))
    .map((e) => e.path);

  const candidates = skillMdPaths
    .filter((p) => (prefix === '' ? true : p.startsWith(prefix)))
    .filter((p) => p.split('/').length <= MAX_DEPTH)
    .filter((p) => p.split('/').slice(0, -1).every((part) => !BROWSE_SKIP_DIRS.has(part)))
    .filter((p) => {
      // 祖先目录若已有 SKILL.md，则不再向下（与 npx skills 的「不下探」一致）
      const dirs = p.split('/').slice(0, -1);
      return !dirs.slice(0, -1).some((_, i) => {
        const ancestor = dirs.slice(0, i + 1).join('/');
        return entries.some((e) => e.type === 'file' && e.path.toLowerCase() === `${ancestor}/skill.md`.toLowerCase());
      });
    });

  // 本机已安装映射：目录名 → skillId；name → skillId
  let installedByDir = new Map<string, string>();
  let installedByName = new Map<string, string>();
  try {
    const listed = await deps.skills.list({ workspace: options.workspace });
    installedByDir = new Map(listed.skills.map((s) => [s.dirName.toLowerCase(), s.id]));
    installedByName = new Map(
      listed.skills.filter((s) => typeof s.name === 'string').map((s) => [String(s.name).toLowerCase(), s.id])
    );
  } catch {
    // 本机扫描失败不影响浏览（只少一个「已安装」标记）
  }

  const skills: BrowseSkill[] = [];
  const seenDirs = new Set<string>();
  const repoBase = options.repo.split('/').pop() ?? options.repo;
  for (const skillPath of candidates.sort()) {
    const parsed = skillDirOf(skillPath);
    const dirPath = parsed.dirPath;
    // 根级 SKILL.md（dirPath === ''）也是一个技能，目录名回退成仓库名
    const dirName = parsed.dirName === '' ? repoBase : parsed.dirName;
    if (seenDirs.has(dirPath)) continue;
    seenDirs.add(dirPath);
    // FIX-5（要求 B/C）：浏览结果里的目录名/目录路径同样按「不安全就整体拒绝」处理 ——
    // 与安装端同一个判据，避免 UI 列出装不进去（或不安全）的技能。
    safeSegmentName(dirName, '上游仓库里的技能目录名');
    if (dirPath !== '') safeRelativePath(dirPath, '上游仓库里的技能目录路径');
    // FIX-7：根级技能（dirPath === ''）的内容选择与安装端同一套判据（排除 .github/.git 等
    // 仓库元数据目录），保证「浏览列得出」与「装得进、装出来的东西一样」。
    const files = dirPath === '' ? rootSkillFiles(entries) : filesUnderDirectory(entries, dirPath);
    const skillMd = files.find((f) => f.rel.toLowerCase() === 'skill.md') ?? files.find((f) => /^SKILL\.md$/i.test(f.rel));
    const fm = skillMd ? parseMiniFrontmatter(skillMd.data.toString('utf8')) : { keys: [] as string[] };
    const item: BrowseSkill = { skillPath: skillMdPathOf(dirPath), dirName };
    if (fm.name !== undefined) item.name = fm.name;
    if (fm.description !== undefined) item.description = fm.description;
    // FIX-7：根级技能没有目录段 —— 装出来的目录名是 sanitizeName(frontmatter name)（取不到名字时
    // 用仓库名），所以这里还要按「安装时会用的那个目录名」查一次；否则根级技能装完仍显示「未安装」。
    const installed =
      installedByName.get((fm.name ?? dirName).toLowerCase()) ??
      (dirPath === '' ? installedByDir.get(sanitizeName(fm.name ?? dirName).toLowerCase()) : undefined) ??
      installedByDir.get(dirName.toLowerCase());
    if (installed !== undefined) item.installedId = installed;
    skills.push(item);
  }

  if (skills.length === 0) {
    throw upstream(
      `在 ${options.repo}@${tarball.ref} 里没有找到任何技能（含 SKILL.md 的目录）${options.subPath ? `（子路径 ${options.subPath}）` : ''}。`
    );
  }

  skills.sort((a, b) => a.dirName.localeCompare(b.dirName));
  return { repo: options.repo, ref: tarball.ref, skills };
}
