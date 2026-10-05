/**
 * 检查更新与应用更新（D-B9 / D-B10，与 CC Switch 的语义一致）。
 *
 * 检查：仅在请求时执行；按 repo+ref 分组，每个仓库只下载一次；
 *       比较「上游目录哈希」与「条目记录值」，返回
 *       up-to-date / update-available / no-source / error。
 *
 * 应用（PLAN §3.4 顺序，任一步失败都要把目录恢复原状）：
 *   1. 记录原启停状态（modelInvocationDisabled）
 *   2. deps.skills.moveToTrash(id, { reason:'update', lockEntry: 更新前条目 })  ← 旧版本进回收站可恢复
 *   3. 放入上游新目录（写入失败则从回收站拿回旧目录）
 *   4. 原来是停用 → deps.skills.setEnabled(id, false)
 *   5. 写回来源（新 skillFolderHash、updatedAt；installedAt 不变）
 * 不做本地改动提醒，直接覆盖（与 CC Switch 一致）。
 */

import path from 'node:path';
import { mkdir, rename } from 'node:fs/promises';
import { locateSkillDirectory } from './tar.ts';
import { describeUnsafePath } from './safepath.ts';
import { hashesEqual, recordedHash, type FolderHash } from './hash.ts';
import { upstreamSkillFiles, upstreamSkillHash } from './rootskill.ts';
import { pathExists, removePath, writeDirectoryFiles } from './fsx.ts';
import { locateSkill, type LocatedSkill } from './install.ts';
import { skillMdPathOf } from './sourceurl.ts';
import { FLAT_SKILL_UNSUPPORTED_MESSAGE, isFlatSkill } from './skillshape.ts';
import type { AuthMode, GitHubClient, TarballResult } from './github.ts';
import type {
  SkillsLocalApi,
  UpdateApplyItem,
  UpdateApplyResult,
  UpdateCheckItem,
  UpdateCheckResult,
} from './types.ts';
import type { SourceStore } from './lockstore.ts';

export interface UpdateDeps {
  github: GitHubClient;
  skills: SkillsLocalApi;
  sources: SourceStore;
  now?: () => Date;
}

interface DownloadGroup {
  key: string;
  repo: string;
  ref?: string;
  ids: string[];
}

function groupKey(repo: string, ref: string | undefined): string {
  return `${repo.toLowerCase()}@${ref ?? ''}`;
}

/** 上游技能目录路径为空串 = 技能就在仓库根（FIX-6 / D-1 的根级 skillPath）；消息里说人话 */
function displayDir(dirPath: string): string {
  return dirPath === '' ? '仓库根' : dirPath;
}

export async function checkUpdates(
  deps: UpdateDeps,
  options: { ids?: string[]; workspace?: string }
): Promise<UpdateCheckResult> {
  const listed = await deps.skills.list({ workspace: options.workspace });
  const wanted = options.ids && options.ids.length > 0 ? new Set(options.ids) : undefined;
  const targets = listed.skills.filter((s) => (wanted ? wanted.has(s.id) : true));

  const results: UpdateCheckItem[] = [];
  const groups = new Map<string, DownloadGroup>();

  for (const skill of targets) {
    // FIX-2（调度者决定）：平铺 .md 技能一律 no-source，且**绝不下载** ——
    // 即使历史数据里有它的来源条目也不去比对（比较基准本身不可信）。
    if (await isFlatSkill(skill)) {
      results.push({
        skillId: skill.id,
        status: 'no-source',
        message: FLAT_SKILL_UNSUPPORTED_MESSAGE,
      });
      continue;
    }
    const record = await deps.sources.get(
      { rootId: skill.rootId, dirName: skill.dirName, path: skill.path },
      skill.name ?? skill.dirName
    );
    if (record === undefined || record.entry.repo === '' || !record.entry.skillFolderHash) {
      results.push({
        skillId: skill.id,
        status: 'no-source',
        message: '该技能没有来源记录，无法检查更新。可以先做「来源推测」或手动登记来源。',
      });
      continue;
    }
    const key = groupKey(record.entry.repo, record.entry.ref);
    const group = groups.get(key);
    if (group) group.ids.push(skill.id);
    else groups.set(key, { key, repo: record.entry.repo, ref: record.entry.ref, ids: [skill.id] });
  }

  const auth = await deps.github.auth();
  const tarballs = new Map<string, TarballResult | Error>();
  for (const group of groups.values()) {
    try {
      // 按 repo+ref 分组，每个仓库只下载一次
      tarballs.set(group.key, await deps.github.downloadTarball(group.repo, group.ref));
    } catch (error) {
      tarballs.set(group.key, error instanceof Error ? error : new Error(String(error)));
    }
  }

  for (const skill of targets) {
    if (results.some((r) => r.skillId === skill.id)) continue;
    const record = await deps.sources.get(
      { rootId: skill.rootId, dirName: skill.dirName, path: skill.path },
      skill.name ?? skill.dirName
    );
    if (record === undefined) continue;
    const entry = record.entry;
    const downloaded = tarballs.get(groupKey(entry.repo, entry.ref));
    if (downloaded === undefined) continue;
    if (downloaded instanceof Error) {
      results.push({ skillId: skill.id, status: 'error', message: downloaded.message });
      continue;
    }
    // FIX-6（D-1）：lock 的 skillPath 可以是根级 "SKILL.md"（npx skills 就是这么写的），
    // 这时技能目录就是仓库根 —— 只有检查/应用更新允许这种形态（安装不允许，见 tar.ts）。
    const located = locateSkillDirectory(downloaded.entries, entry.skillPath, { allowRoot: true });
    if (located === undefined) {
      results.push({
        skillId: skill.id,
        status: 'error',
        message: `在上游 ${entry.repo}@${downloaded.ref} 里找不到 ${entry.skillPath}（上游可能改名或删除了这个技能）。`,
      });
      continue;
    }
    // FIX-5：上游目录里有不安全路径时，只把这一项报成 error，其余技能照常检查
    let upstreamHash: FolderHash;
    try {
      // FIX-7：根级技能（located.path === ''）的上游哈希按「实际会写盘的那批文件」算 ——
      // 与安装侧 upstreamSkillHash 同一口径，安装完立刻检查必然是「最新」。
      upstreamHash = upstreamSkillHash(downloaded.entries, located.path);
    } catch (error) {
      results.push({
        skillId: skill.id,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (hashesEqual(upstreamHash, entry.skillFolderHash)) {
      results.push({ skillId: skill.id, status: 'up-to-date' });
    } else {
      results.push({
        skillId: skill.id,
        status: 'update-available',
        message: `上游 ${entry.repo}@${downloaded.ref} 的 ${displayDir(located.path)} 与登记的内容哈希不一致，可以更新。`,
      });
    }
  }

  const rate = deps.github.lastKnownRateLimit;
  const payload: UpdateCheckResult = {
    results,
    auth: auth.mode as AuthMode,
  };
  if (rate?.remaining !== undefined) payload.rateLimitRemaining = rate.remaining;
  return payload;
}

export async function applyUpdates(
  deps: UpdateDeps,
  options: { ids: string[]; workspace?: string }
): Promise<UpdateApplyResult> {
  const ids = Array.isArray(options.ids) ? options.ids : [];
  const results: UpdateApplyItem[] = [];

  const locatedList: LocatedSkill[] = [];
  for (const id of ids) {
    const located = await locateSkill({ skills: deps.skills, sources: deps.sources }, id, options.workspace);
    if (located === undefined) {
      results.push({ skillId: id, ok: false, message: `找不到技能 ${id}。` });
      continue;
    }
    // FIX-2（调度者决定）：平铺 .md 技能不更新。必须在这里拦下 —— 再往下走会先删旧文件、
    // 再把上游 SKILL.md 目录 rename 到这个路径，把「文件」变成「目录」（技能 id 随之改变）。
    if (located.flat) {
      results.push({ skillId: id, ok: false, message: FLAT_SKILL_UNSUPPORTED_MESSAGE });
      continue;
    }
    if (located.source === undefined || !located.source.skillFolderHash) {
      results.push({ skillId: id, ok: false, message: '该技能没有来源记录，无法更新。请先登记来源。' });
      continue;
    }
    locatedList.push(located);
  }

  const groups = new Map<string, DownloadGroup>();
  for (const located of locatedList) {
    const entry = located.source!;
    const key = groupKey(entry.repo, entry.ref);
    const group = groups.get(key);
    if (group) group.ids.push(located.id);
    else groups.set(key, { key, repo: entry.repo, ref: entry.ref, ids: [located.id] });
  }

  const tarballs = new Map<string, TarballResult | Error>();
  for (const group of groups.values()) {
    try {
      tarballs.set(group.key, await deps.github.downloadTarball(group.repo, group.ref));
    } catch (error) {
      tarballs.set(group.key, error instanceof Error ? error : new Error(String(error)));
    }
  }

  for (const located of locatedList) {
    const entry = located.source!;
    const downloaded = tarballs.get(groupKey(entry.repo, entry.ref));
    if (downloaded === undefined) {
      results.push({ skillId: located.id, ok: false, message: '内部错误：没有对应的下载结果。' });
      continue;
    }
    if (downloaded instanceof Error) {
      results.push({ skillId: located.id, ok: false, message: downloaded.message });
      continue;
    }
    const locatedUpstream = locateSkillDirectory(downloaded.entries, entry.skillPath, { allowRoot: true });
    if (locatedUpstream === undefined) {
      results.push({
        skillId: located.id,
        ok: false,
        message: `在上游 ${entry.repo}@${downloaded.ref} 里找不到 ${entry.skillPath}，未做任何改动。`,
      });
      continue;
    }
    // FIX-5（要求 B/C）：上游目录路径不安全（".." 段 / 反斜杠 / 盘符 …）→ 这一项直接拒绝，
    // 在 moveToTrash 之前返回，技能目录一个字节都不动。
    // FIX-6（D-1）：空串是「技能就在仓库根」的合法形态（没有路径可穿越），跳过这项判定。
    const unsafeDir = locatedUpstream.path === '' ? undefined : describeUnsafePath(locatedUpstream.path);
    if (unsafeDir !== undefined) {
      results.push({
        skillId: located.id,
        ok: false,
        message: `上游 ${entry.repo}@${downloaded.ref} 的技能目录路径 "${displayDir(locatedUpstream.path)}" 不安全（${unsafeDir}），未做任何改动。`,
      });
      continue;
    }
    // FIX-5：目录里任何一条文件路径不安全 → 整体拒绝本次更新（逐项，不影响其他技能）
    let files: { rel: string; data: Buffer }[];
    try {
      files = upstreamSkillFiles(downloaded.entries, locatedUpstream.path);
    } catch (error) {
      results.push({
        skillId: located.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (files.length === 0) {
      results.push({ skillId: located.id, ok: false, message: `上游 ${displayDir(locatedUpstream.path)} 里没有任何文件，未做任何改动。` });
      continue;
    }

    const applied = await applyOneUpdate(deps, located, downloaded, locatedUpstream.path, files, options.workspace);
    results.push(applied);
  }

  return { results };
}

async function applyOneUpdate(
  deps: UpdateDeps,
  located: LocatedSkill,
  tarball: TarballResult,
  upstreamDir: string,
  files: { rel: string; data: Buffer }[],
  workspace: string | undefined
): Promise<UpdateApplyItem> {
  const entry = located.source!;
  const wasDisabled = located.modelInvocationDisabled;
  const targetDir = located.path;

  // 1) 记录原启停状态 → 旧版本进回收站（lockEntry = 更新前的条目）
  let trashId: string | undefined;
  try {
    const trashed = await deps.skills.moveToTrash(located.id, {
      ...(workspace !== undefined ? { workspace } : {}),
      reason: 'update',
      lockEntry: entry,
    });
    trashId = trashed.trashId;
  } catch (error) {
    return {
      skillId: located.id,
      ok: false,
      message: `移入回收站失败，未做任何改动：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 2) 放入上游新目录
  const staging = `${targetDir}.capability-hub-incoming-${Date.now().toString(36)}`;
  try {
    await writeDirectoryFiles(staging, files);
    const parent = path.dirname(targetDir);
    await mkdir(parent, { recursive: true });
    // 先尝试原子 rename；Windows 上目标刚被删除时偶发 EPERM/ENOTEMPTY，退回复制。
    try {
      await rename(staging, targetDir);
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw renameError;
      await writeDirectoryFiles(targetDir, files);
      await removePath(staging).catch(() => {});
    }
  } catch (error) {
    await removePath(staging).catch(() => {});
    const rollback = await rollbackFromTrash(deps, trashId, targetDir, workspace);
    return {
      skillId: located.id,
      ok: false,
      message: `写入新版本失败：${error instanceof Error ? error.message : String(error)}。${rollback}`,
      ...(trashId !== undefined ? { trashId } : {}),
    };
  }

  // 3) 恢复启停状态
  if (wasDisabled) {
    try {
      await deps.skills.setEnabled(located.id, false, workspace !== undefined ? { workspace } : {});
    } catch (error) {
      const rollback = await rollbackFromTrash(deps, trashId, targetDir, workspace);
      return {
        skillId: located.id,
        ok: false,
        message: `恢复「停用」状态失败：${error instanceof Error ? error.message : String(error)}。${rollback}`,
        ...(trashId !== undefined ? { trashId } : {}),
      };
    }
  }

  // 4) 写回来源（新 skillFolderHash、updatedAt；installedAt 不变）
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const newHash = recordedHash(upstreamSkillHash(tarball.entries, upstreamDir));
  try {
    await deps.sources.upsert(
      { rootId: located.rootId, dirName: located.dirName, path: targetDir },
      {
        ...entry,
        skillId: located.id,
        // FIX-6（D-2 防护）：根级上游目录（upstreamDir === ''）必须写成 "SKILL.md"，
        // 旧写法会拼出 "/SKILL.md"（绝对路径形态），写进 lock 就成了坏数据。
        skillPath: skillMdPathOf(upstreamDir),
        store: entry.store,
        updatedAt: nowIso,
        skillFolderHash: newHash,
      },
      located.name ?? located.dirName
    );
  } catch (error) {
    const rollback = await rollbackFromTrash(deps, trashId, targetDir, workspace);
    return {
      skillId: located.id,
      ok: false,
      message: `写回来源记录失败：${error instanceof Error ? error.message : String(error)}。${rollback}`,
      ...(trashId !== undefined ? { trashId } : {}),
    };
  }

  const suffix = wasDisabled ? '（已保持停用状态）' : '';
  return {
    skillId: located.id,
    ok: true,
    message: `已更新到上游最新版本${suffix}。旧版本仍在回收站，可随时恢复。`,
    ...(trashId !== undefined ? { trashId } : {}),
  };
}

/** 更新失败时把目录恢复原状：优先从回收站拿回，拿不回就清掉半成品并说明。 */
async function rollbackFromTrash(
  deps: UpdateDeps,
  trashId: string | undefined,
  targetDir: string,
  workspace: string | undefined
): Promise<string> {
  try {
    if (await pathExists(targetDir)) await removePath(targetDir);
  } catch (error) {
    return `另外：清理未完成的新目录也失败了（${error instanceof Error ? error.message : String(error)}），请手动检查 ${targetDir}。`;
  }
  if (trashId === undefined) return '原目录已移入回收站，请到回收站手动恢复。';
  try {
    await deps.skills.restore(trashId, { replace: true, ...(workspace !== undefined ? { workspace } : {}) });
    return '已从回收站恢复原目录。';
  } catch (error) {
    return `原目录仍在回收站（${trashId}），自动恢复失败（${error instanceof Error ? error.message : String(error)}），请到回收站手动恢复。`;
  }
}


