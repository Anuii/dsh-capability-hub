/**
 * 安装与来源登记。
 *
 * 安装（D-B6）：下载 → 复制选中的技能目录到目标根 → 写来源。
 *   - 目标目录已存在 → 该项失败并说明，绝不覆盖
 *   - project-* 目标需要 workspace（由路由层校验后传入）
 *   - 写入 lock 的 skillFolderHash = **上游目录内容哈希**（与 npx skills 同源，F6-Q3.6 第 3 条）
 *   - **FIX-7**：skillPath = "SKILL.md"（技能 = 仓库根，单技能仓库）也支持安装 ——
 *     lock 键 = 原始技能名（取不到用仓库名）、目录名 = sanitizeName(键)，
 *     内容 = 仓库根文件（排除 .git/.github 等元数据目录），哈希按 npx 口径对**上游仓库根**算
 *     （与检查更新同一口径）。见 rootskill.ts 与文档 §11
 *
 * 登记（D-B8）：写来源条目；skillFolderHash = **本地目录当前哈希**
 *   （这样若上游不同就会显示有更新，且与 npx skills 的语义一致）。
 */

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { pathExists, writeDirectoryFiles } from './fsx.ts';
import { recordedHash } from './hash.ts';
import { locateSkillDirectory } from './tar.ts';
import { rootSkillNameOf, skillMdTextOf, upstreamSkillFiles, upstreamSkillHash } from './rootskill.ts';
import { assertPathInsideDirectory, describeUnsafePath, safeRelativePath, safeSegmentName } from './safepath.ts';
import { skillDirOf, skillMdPathOf } from './sourceurl.ts';
import { assertRepoShape } from './repos.ts';
import { badRequest, conflict, notFound, validation } from './errors.ts';
import { localFolderHash, type SourceStore } from './lockstore.ts';
import { FLAT_SKILL_UNSUPPORTED_MESSAGE, isFlatSkill } from './skillshape.ts';
import type { GitHubClient } from './github.ts';
import type { SkillsLocalPort } from './types.ts';
import type { HubContext } from '../../platform/contract/host.ts';
import type { InstallItemResult, InstallTarget, SourceEntry } from '../contract/remote.ts';
import { PROJECT_TARGETS } from './types.ts';

export interface InstallDeps {
  ctx: HubContext;
  github: GitHubClient;
  skills: SkillsLocalPort;
  sources: SourceStore;
  now?: () => Date;
}

export interface InstallOptions {
  repo: string;
  ref?: string;
  skillPaths: string[];
  target: InstallTarget;
  workspace?: string;
}

/**
 * FIX-5（要求 C）：用户提交的技能路径先过路径安全校验 —— 反斜杠、"." / ".." 段、
 * 盘符、控制字符一律拒绝（BAD_REQUEST）。必须在任何网络请求与落盘之前完成，整批拒绝。
 */
function assertUserSkillPath(raw: string): string {
  const reason = describeUnsafePath(raw);
  if (reason !== undefined) {
    throw badRequest(`技能路径 "${raw}" 不安全（${reason}），已拒绝。技能路径只能是不含 ".."、反斜杠或盘符的相对路径。`);
  }
  return raw;
}

export function assertInstallTarget(target: string): InstallTarget {
  const allowed: InstallTarget[] = ['user-agents', 'user-dsh', 'project-agents', 'project-dsh'];
  if (!allowed.includes(target as InstallTarget)) {
    throw validation(`安装目标 "${target}" 不合法，只能是 ${allowed.join(' / ')}。`, [
      { path: 'target', message: '未知的安装目标' },
    ]);
  }
  return target as InstallTarget;
}

export function targetRootPath(deps: InstallDeps, target: InstallTarget, workspace?: string): string {
  if (PROJECT_TARGETS.includes(target) && (workspace === undefined || workspace.trim() === '')) {
    throw badRequest('安装到项目级目录需要当前会话的工作区路径（workspace），当前没有可用工作区。');
  }
  const resolved = deps.skills.rootPath(target, { workspace });
  if (resolved === undefined || resolved.trim() === '') {
    throw badRequest(`找不到目标技能根 "${target}"${workspace ? `（工作区 ${workspace}）` : ''}。`);
  }
  return resolved;
}

export async function installSkills(deps: InstallDeps, options: InstallOptions): Promise<InstallItemResult[]> {
  const repo = assertRepoShape(options.repo);
  const target = assertInstallTarget(options.target);
  if (!Array.isArray(options.skillPaths) || options.skillPaths.length === 0) {
    throw badRequest('请至少选择一个要安装的技能。');
  }

  const rootPath = targetRootPath(deps, target, options.workspace);
  // FIX-5：先校验全部用户提交的 skillPath（整批拒绝），再下载 —— 坏输入不产生任何网络请求。
  for (const requested of options.skillPaths) assertUserSkillPath(String(requested));

  const tarball = await deps.github.downloadTarball(repo, options.ref);
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const results: InstallItemResult[] = [];
  /** 根级技能取不到 frontmatter name 时的目录名回退值（= 仓库名的最后一段） */
  const repoBase = repo.split('/').pop() ?? repo;

  for (const requested of options.skillPaths) {
    const skillPath = skillMdPathOf(skillDirOf(String(requested)).dirPath);
    try {
      // FIX-7：allowRoot —— 单技能仓库（SKILL.md 就在仓库根，npx skills 的 skillPath = "SKILL.md"
      // 形态）也要能装。该开关只在 skillPath 没有目录段时起作用，非根级行为完全不变。
      const located = locateSkillDirectory(tarball.entries, skillPath, { allowRoot: true });
      if (located === undefined) {
        throw notFound(`仓库 ${repo}@${tarball.ref} 里找不到技能 ${skillPath}。`);
      }
      // 内容文件 = 真正会写盘的那一批（根级会排除 .git/.github 等元数据目录）；哈希与它同源。
      const files = upstreamSkillFiles(tarball.entries, located.path);
      let dirName: string;
      /** 写进 lock / sources.json 的键（npx 语义：技能名；普通技能仍是 tar 里的目录名） */
      let storeName: string;
      if (located.path === '') {
        // FIX-7：技能 = 仓库根。lock 键 = 原始技能名（取不到就用仓库名），
        // 目录名 = sanitizeName(键)（与 npx skills 的 getInstallPath 一致）；仍须通过 safeSegmentName 校验。
        const named = rootSkillNameOf(skillMdTextOf(files), repoBase);
        safeSegmentName(named.dirName, `上游 ${repo}@${tarball.ref} 的技能目录名（技能名 ${named.key}）`);
        dirName = named.dirName;
        storeName = named.key;
      } else {
        // FIX-5（要求 C）：目录名必须是安全单段名、目录路径必须是安全相对路径；
        // 目标目录再按 resolve/relative 确认落在技能根之内（纵深防御）。
        safeSegmentName(located.dirName, `上游 ${repo}@${tarball.ref} 的技能目录名`);
        safeRelativePath(located.path, `上游 ${repo}@${tarball.ref} 的技能目录路径`);
        dirName = located.dirName;
        storeName = located.dirName;
      }
      const destDir = path.join(rootPath, dirName);
      assertPathInsideDirectory(rootPath, destDir, '安装目标目录');
      if (await pathExists(destDir)) {
        throw conflict(`目标位置已存在同名技能目录 ${dirName}（${destDir}），未做任何改动。请先删除或改名后再安装。`);
      }

      await mkdir(rootPath, { recursive: true });
      await writeDirectoryFiles(destDir, files);

      const folderHash = recordedHash(upstreamSkillHash(tarball.entries, located.path));
      const entry: SourceEntry = {
        skillId: `${target}:${dirName}`,
        repo,
        skillPath: skillMdPathOf(located.path),
        store: target === 'user-agents' ? 'skill-lock' : 'hub',
        installedAt: nowIso,
        updatedAt: nowIso,
        skillFolderHash: folderHash,
      };
      if (tarball.ref !== undefined) entry.ref = tarball.ref;
      const stored = await deps.sources.upsert(
        { rootId: target, dirName, path: destDir },
        entry,
        storeName
      );
      results.push({ skillPath: skillMdPathOf(located.path), ok: true, skillId: stored.skillId });
    } catch (error) {
      results.push({
        skillPath,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/* ---------- 来源登记 / 注销 ---------- */

export interface RegisterOptions {
  skillId: string;
  repo: string;
  ref?: string;
  skillPath?: string;
  workspace?: string;
  /** 覆盖记录的哈希（discover → register 时不传，走本地目录哈希） */
  skillFolderHash?: string;
}

export interface RegisterDeps {
  ctx: HubContext;
  skills: SkillsLocalPort;
  sources: SourceStore;
  now?: () => Date;
}

export async function registerSource(deps: RegisterDeps, options: RegisterOptions): Promise<SourceEntry> {
  const repo = assertRepoShape(options.repo);
  const skill = await deps.skills.get(options.skillId, { workspace: options.workspace });
  if (skill === undefined) throw notFound(`找不到技能 ${options.skillId}。`);
  // FIX-2（调度者决定）：平铺 .md 技能的 path 是文件，localFolderHash 对文件得到空集哈希
  // （e3b0c442…），会把错误的比较基准登记进来源。这里在任何落盘动作之前直接拒绝。
  if (await isFlatSkill(skill)) throw badRequest(FLAT_SKILL_UNSUPPORTED_MESSAGE);
  if (!skill.writable) throw badRequest(`技能 ${options.skillId} 所在目录是只读的，无法登记来源。`);

  const dirPath = skill.path;
  if (!(await pathExists(dirPath))) throw notFound(`技能目录不存在：${dirPath}`);

  // FIX-5：登记的 skillPath 也是用户输入，同样先过路径安全校验（否则会把穿越路径写进 lock，
  // 成为后续「检查更新 / 应用更新」的输入）。
  const skillPath = options.skillPath !== undefined && options.skillPath.trim() !== ''
    ? skillMdPathOf(skillDirOf(assertUserSkillPath(options.skillPath.trim())).dirPath)
    : skillMdPathOf('');

  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const folderHash = options.skillFolderHash ?? (await localFolderHash(dirPath));

  const entry: SourceEntry = {
    skillId: skill.id,
    repo,
    skillPath,
    store: skill.rootId === 'user-agents' ? 'skill-lock' : 'hub',
    installedAt: nowIso,
    updatedAt: nowIso,
    skillFolderHash: folderHash,
  };
  if (options.ref !== undefined && options.ref.trim() !== '') entry.ref = options.ref.trim();

  const stored = await deps.sources.upsert(
    { rootId: skill.rootId, dirName: skill.dirName, path: dirPath },
    entry,
    skill.name ?? skill.dirName
  );
  return stored;
}

export interface UnregisterDeps {
  skills: SkillsLocalPort;
  sources: SourceStore;
}

export async function unregisterSource(
  deps: UnregisterDeps,
  options: { skillId: string; workspace?: string }
): Promise<{ removed: boolean }> {
  const skill = await deps.skills.get(options.skillId, { workspace: options.workspace });
  if (skill === undefined) throw notFound(`找不到技能 ${options.skillId}。`);
  const removed = await deps.sources.remove(
    { rootId: skill.rootId, dirName: skill.dirName, path: skill.path },
    skill.name ?? skill.dirName
  );
  if (!removed) throw notFound(`技能 ${options.skillId} 没有登记来源，无需注销。`);
  return { removed: true };
}

/** 供 updates/applicable 复用的定位：把技能 id 转成来源记录 + 位置 */
export interface LocatedSkill {
  id: string;
  rootId: string;
  dirName: string;
  path: string;
  name?: string;
  modelInvocationDisabled: boolean;
  /** FIX-2：平铺 .md 技能（path 是文件）—— 不支持来源登记与更新 */
  flat: boolean;
  source?: SourceEntry;
}

export async function locateSkill(
  deps: { skills: SkillsLocalPort; sources: SourceStore },
  id: string,
  workspace?: string
): Promise<LocatedSkill | undefined> {
  const skill = await deps.skills.get(id, { workspace });
  if (skill === undefined) return undefined;
  const record = await deps.sources.get(
    { rootId: skill.rootId, dirName: skill.dirName, path: skill.path },
    skill.name ?? skill.dirName
  );
  const located: LocatedSkill = {
    id: skill.id,
    rootId: skill.rootId,
    dirName: skill.dirName,
    path: skill.path,
    modelInvocationDisabled: skill.modelInvocationDisabled,
    flat: await isFlatSkill(skill),
  };
  if (skill.name !== undefined) located.name = skill.name;
  if (record !== undefined) located.source = record.entry;
  return located;
}
