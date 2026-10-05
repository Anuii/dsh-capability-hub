/**
 * skills-local 的核心实现（SkillsLocalApi，PLAN §3.3）。
 *
 * 安全红线：本模块只写 ctx.homeDir / ctx.dshHome / hubHome / workspace 派生出来的路径，
 * 且写入前一律要求所在根 writable === true。测试与真实运行都只用注入的 ctx，绝不硬编码真实用户目录。
 */

import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { badRequest, conflict, internal, notFound, readOnly } from './errors.ts';
import { atomicWriteFile, isDirectory, readFileText, removePath, statOrUndefined, walkEntries } from './fsx.ts';
import { evaluateFrontmatter, rewriteDisableModelInvocation } from './frontmatter.ts';
import {
  applyShadowing,
  isSafeDirName,
  newScanEnv,
  parseSkillId,
  resolveRoots,
  rootSpecOf,
  scanRoots,
  skillId,
  toRootInfos,
  type RootSpec,
  type ScanEnv,
  type ScannedRoot,
} from './scan.ts';
import { TrashStore, isValidTrashId, normalizeLockEntry, type TrashMeta } from './trash.ts';
import { collectWarnings } from './warnings.ts';
import type {
  HubContext,
  ListResult,
  LockStash,
  MoveToTrashOptions,
  SkillSummary,
  SkillView,
  SkillViewFile,
  TrashItem,
} from './types.ts';

export const VIEW_MAX_FILES = 500;
const SKIP_DIRS = ['node_modules', '.git'];
const REASONS = new Set(['delete', 'update', 'replace']);

interface Snapshot {
  specs: RootSpec[];
  scanned: ScannedRoot[];
  env: ScanEnv;
  skills: SkillSummary[];
  warnings: string[];
}

export interface SkillsLocalImpl {
  list(opts?: { workspace?: string }): Promise<ListResult>;
  get(id: string, opts?: { workspace?: string }): Promise<SkillSummary | undefined>;
  setEnabled(id: string, enabled: boolean, opts?: { workspace?: string }): Promise<SkillSummary>;
  moveToTrash(id: string, opts: MoveToTrashOptions): Promise<TrashItem>;
  rootPath(rootId: string, opts?: { workspace?: string }): string | undefined;
  view(id: string, opts?: { workspace?: string }): Promise<SkillView>;
  trashList(): Promise<TrashItem[]>;
  restore(trashId: string, opts: { replace?: boolean; workspace?: string }): Promise<SkillSummary>;
  purge(trashId?: string): Promise<number>;
  bindLockStash(stash: LockStash): void;
}

function toTrashItem(meta: TrashMeta): TrashItem {
  const item: TrashItem = {
    trashId: meta.trashId,
    skillId: meta.skillId,
    rootId: meta.rootId,
    dirName: meta.dirName,
    originalPath: meta.originalPath,
    reason: meta.reason,
    deletedAt: meta.deletedAt,
    hasLockEntry: meta.hasLockEntry === true,
  };
  if (meta.name !== undefined) item.name = meta.name;
  return item;
}

/**
 * 回收站操作的路径防护（FIX-1）——两条硬不变式：
 *   1. 目标绝不能是技能根本身（否则「删除一个技能」会把整个技能根移入回收站）；
 *   2. 目标必须落在该技能根之内（防止被篡改的 meta.json 把内容恢复到任意路径）。
 *
 * 判定按词法路径（含 Windows 大小写不敏感）进行，**不解析符号链接**：
 * 根或技能目录本身是符号链接/目录联接时，链接指向的那一侧可能是技能根之外的真实位置，
 * 这是本模块明确支持的形态（见 SYMLINKED_SKILL 诊断），因此不能按 realpath 判定。
 */
export function assertTrashTargetInsideRoot(target: unknown, rootPath: unknown, actionLabel: string): void {
  if (typeof target !== 'string' || target.trim() === '') {
    throw internal('拒绝' + actionLabel + '：目标路径为空或不是字符串。');
  }
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    throw internal('拒绝' + actionLabel + '：无法确定技能根路径（为空），不做任何操作。');
  }
  const root = path.resolve(rootPath);
  const resolved = path.resolve(target);
  const rel = path.relative(root, resolved);
  if (rel === '') {
    throw conflict(
      '拒绝' + actionLabel + '：目标路径就是技能根本身（' + root + '）。' +
        '对该路径操作会把整个技能根连同其中所有技能一起移入回收站，本插件不会这样做。',
    );
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw internal('拒绝' + actionLabel + '：目标路径 ' + resolved + ' 不在技能根 ' + root + ' 之内。');
  }
}

export function createSkillsLocalImpl(ctx: HubContext): SkillsLocalImpl {
  const trash = new TrashStore(ctx.hubHome);
  let lockStash: LockStash | undefined;

  async function snapshot(workspace: string | undefined, extraSpecs: RootSpec[] = []): Promise<Snapshot> {
    const specs = await resolveRoots(ctx, workspace);
    for (const extra of extraSpecs) {
      if (!specs.some((s) => s.rootId === extra.rootId)) specs.push(extra);
    }
    const env = newScanEnv();
    const scanned = await scanRoots(specs, env);
    const skills: SkillSummary[] = [];
    for (const root of scanned) skills.push(...root.skills);
    applyShadowing(skills, specs);
    const warnings = await collectWarnings({ ctx, specs, linkedRoots: env.linkedRoots, linkedSkills: env.linkedSkills });
    for (const root of scanned) {
      for (const problem of root.problems) warnings.push(problem);
    }
    return { specs, scanned, env, skills, warnings };
  }

  async function locate(id: string, snap: Snapshot): Promise<{ skill: SkillSummary; spec: RootSpec }> {
    const parsed = parseSkillId(id);
    if (parsed === undefined) throw badRequest('技能 id 格式非法（应为「rootId:目录名」）：' + id);
    const skill = snap.skills.find((s) => s.id === id);
    if (skill === undefined) throw notFound('找不到技能：' + id);
    const spec = rootSpecOf(snap.specs, parsed.rootId);
    if (spec === undefined) throw notFound('技能根不存在：' + parsed.rootId);
    return { skill, spec };
  }

  function assertWritable(spec: RootSpec, skill: SkillSummary): void {
    if (spec.writable && skill.writable) return;
    throw readOnly('技能根「' + spec.rootId + '」是只读的（' + spec.path + '），不能在此根上执行写操作。');
  }

  function assertToggleSafe(skill: SkillSummary): void {
    if (skill.format.safeToToggle) return;
    const detail = skill.diagnostics
      .filter((d) => d.level === 'error' || d.level === 'warning')
      .map((d) => d.message)
      .join('；');
    throw conflict(
      '该技能的 SKILL.md 无法安全地「只改一行」启停：' +
        (detail === '' ? '文件格式不安全。' : detail) +
        ' 请手工修正后再试（本插件不会对它做任何写回）。',
    );
  }

  const api: SkillsLocalImpl = {
    async list(opts = {}) {
      const snap = await snapshot(opts.workspace);
      return { roots: toRootInfos(snap.scanned), skills: snap.skills, warnings: snap.warnings };
    },

    async get(id, opts = {}) {
      const snap = await snapshot(opts.workspace);
      return snap.skills.find((s) => s.id === id);
    },

    async setEnabled(id, enabled, opts = {}) {
      const snap = await snapshot(opts.workspace);
      const { skill, spec } = await locate(id, snap);
      assertWritable(spec, skill);
      assertToggleSafe(skill);
      const file = snap.env.skillFiles.get(id);
      if (file === undefined) throw internal('内部错误：未记录技能文件路径。');
      const read = await readFileText(file);
      if (read === undefined) throw notFound('读不到技能文件：' + file);
      const result = rewriteDisableModelInvocation(read.buffer, enabled);
      if (!result.ok) throw conflict('无法改写该技能：' + (result.reason ?? '未知原因'));
      if (result.changed) await atomicWriteFile(file, result.content);
      const after = await api.get(id, opts);
      if (after === undefined) throw internal('改写完成但重新扫描时找不到该技能：' + id);
      return after;
    },

    async moveToTrash(id, opts) {
      const workspace = opts?.workspace;
      const reason = opts?.reason;
      if (reason === undefined || !REASONS.has(reason)) {
        throw badRequest('reason 必须是 delete / update / replace 之一。');
      }
      const snap = await snapshot(workspace);
      const { skill, spec } = await locate(id, snap);
      assertWritable(spec, skill);
      const source = skill.path;
      assertTrashTargetInsideRoot(source, spec.path, '删除');
      const kind: 'dir' | 'file' = (await isDirectory(source)) ? 'dir' : 'file';

      let lockEntry: unknown;
      let hasLockEntry = false;
      if (reason === 'delete') {
        if (lockStash !== undefined) {
          const taken = await lockStash.take({ rootId: skill.rootId, dirName: skill.dirName, path: source });
          if (taken !== undefined) {
            lockEntry = normalizeLockEntry(taken);
            hasLockEntry = true;
          }
        }
      } else if (opts?.lockEntry !== undefined) {
        lockEntry = normalizeLockEntry(opts.lockEntry);
        hasLockEntry = true;
      }

      const baseMeta: Omit<TrashMeta, 'version' | 'trashId' | 'deletedAt'> = {
        skillId: skill.id,
        rootId: skill.rootId,
        dirName: skill.dirName,
        originalPath: source,
        rootPath: spec.path,
        reason,
        hasLockEntry,
        kind,
      };
      if (skill.name !== undefined) baseMeta.name = skill.name;
      if (lockEntry !== undefined) baseMeta.lockEntry = lockEntry;

      try {
        const meta = await trash.stash(source, baseMeta);
        return toTrashItem(meta);
      } catch (error) {
        if (hasLockEntry && lockStash !== undefined) {
          try {
            await lockStash.put({ rootId: skill.rootId, dirName: skill.dirName, path: source }, lockEntry);
          } catch {
            /* 回滚 lock 失败：不掩盖原始错误 */
          }
        }
        const message = (error as Error).message;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('要删除的技能已不存在：' + source);
        throw internal('移入回收站失败：' + message);
      }
    },

    // 真实实现挂在下方（需要同步返回，契约签名不允许 async）
    rootPath(): string | undefined {
      return undefined;
    },

    async view(id, opts = {}) {
      const snap = await snapshot(opts.workspace);
      const { skill } = await locate(id, snap);
      const file = snap.env.skillFiles.get(id);
      if (file === undefined) throw internal('内部错误：未记录技能文件路径。');
      const read = await readFileText(file);
      const content = read === undefined ? '' : read.text;
      const kind = snap.env.skillKinds.get(id) ?? 'dir';
      let files: SkillViewFile[];
      if (kind === 'file') {
        const st = await statOrUndefined(file);
        files = [{ path: path.basename(file), size: st === undefined ? 0 : Number(st.size), isDir: false }];
      } else {
        const walked = await walkEntries(skill.path, { max: VIEW_MAX_FILES, skipDirs: SKIP_DIRS, maxDepth: 12 });
        files = walked.map((entry) => ({ path: entry.path, size: entry.size, isDir: entry.isDir }));
      }
      return { skill, content, files };
    },

    async trashList() {
      const metas = await trash.listMeta();
      return metas.map(toTrashItem);
    },

    async restore(trashId, opts = {}) {
      // FIX-5：格式校验（安全单段名）—— 拒绝 "." / ".." / 路径分隔符 / 控制字符，
      // 保证 trash.dirOf(trashId) 只能是回收站根下的一个直接子目录。
      if (!isValidTrashId(trashId)) {
        throw badRequest('trashId 非法：必须是形如 20261004T230239123Z-ab12cd 的单段标识（不能是 "." 或 ".."，也不能含 "/" 与 "\\"）。');
      }
      const meta = await trash.readMeta(trashId);
      if (meta === undefined) throw notFound('回收站里找不到条目：' + trashId);
      if (opts?.replace !== undefined && typeof opts.replace !== 'boolean') throw badRequest('replace 必须是布尔值。');

      const specs = await resolveRoots(ctx, opts?.workspace);
      const spec = rootSpecOf(specs, meta.rootId);
      if (spec !== undefined && !spec.writable) {
        throw readOnly('技能根「' + meta.rootId + '」是只读的，不能恢复到该位置。');
      }
      const extraSpec: RootSpec | undefined =
        spec === undefined && typeof meta.rootPath === 'string'
          ? { rootId: meta.rootId, path: meta.rootPath, writable: true, precedence: 999 }
          : undefined;

      const target = meta.originalPath;
      const targetRoot =
        typeof meta.rootPath === 'string' && meta.rootPath.trim() !== ''
          ? meta.rootPath
          : path.dirname(path.resolve(typeof target === 'string' && target !== '' ? target : '.'));
      assertTrashTargetInsideRoot(target, targetRoot, '恢复');
      const existing = await statOrUndefined(target);
      if (existing !== undefined) {
        if (opts?.replace !== true) {
          throw conflict('原路径已存在同名的目录/文件：' + target + '。若要覆盖，请勾选「覆盖恢复」。');
        }
        const replaceMeta: Omit<TrashMeta, 'version' | 'trashId' | 'deletedAt'> = {
          skillId: meta.skillId,
          rootId: meta.rootId,
          dirName: meta.dirName,
          originalPath: target,
          rootPath: meta.rootPath ?? path.dirname(target),
          reason: 'replace',
          hasLockEntry: false,
          kind: existing.isDirectory() ? 'dir' : 'file',
        };
        const existingName = await readSkillName(existing.isDirectory() ? path.join(target, 'SKILL.md') : target);
        if (existingName !== undefined) replaceMeta.name = existingName;
        try {
          await trash.stash(target, replaceMeta);
        } catch (error) {
          throw internal('覆盖恢复失败：无法把现有内容移入回收站（' + (error as Error).message + '）。');
        }
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await trash.unstash(trashId, target);
      } catch (error) {
        throw internal('从回收站恢复失败：' + (error as Error).message);
      }
      await trash.drop(trashId);

      if (meta.hasLockEntry && meta.lockEntry !== undefined && lockStash !== undefined) {
        await lockStash.put({ rootId: meta.rootId, dirName: meta.dirName, path: target }, meta.lockEntry);
      }

      const snap = await snapshot(opts?.workspace, extraSpec === undefined ? [] : [extraSpec]);
      const restored = snap.skills.find((s) => s.id === meta.skillId);
      if (restored === undefined) {
        throw internal('内容已恢复到 ' + target + '，但重新扫描时未能识别为技能；请刷新页面查看。');
      }
      return restored;
    },

    async purge(trashId) {
      if (trashId === undefined) {
        const metas = await trash.listMeta();
        let count = 0;
        for (const meta of metas) {
          await trash.drop(meta.trashId);
          count += 1;
        }
        return count;
      }
      // FIX-5：与 restore 同一道格式校验（见上）
      if (!isValidTrashId(trashId)) {
        throw badRequest('trashId 非法：必须是形如 20261004T230239123Z-ab12cd 的单段标识（不能是 "." 或 ".."，也不能含 "/" 与 "\\"）。');
      }
      const meta = await trash.readMeta(trashId);
      if (meta === undefined) throw notFound('回收站里找不到条目：' + trashId);
      await trash.drop(trashId);
      return 1;
    },

    bindLockStash(stash) {
      lockStash = stash;
    },
  };

  // rootPath 需要同步返回（契约签名），因此不能走异步解析：这里同步地按注入 ctx 推导。
  api.rootPath = (rootId, opts = {}) => {
    if (typeof rootId !== 'string' || rootId.trim() === '') return undefined;
    if (rootId === 'user-dsh') return path.join(ctx.dshHome, 'skills');
    if (rootId === 'user-agents') return path.join(ctx.homeDir, '.agents', 'skills');
    if (rootId === 'bundled') return ctx.bundledSkillDir;
    if (rootId.startsWith('custom-')) {
      const index = Number(rootId.slice('custom-'.length));
      if (!Number.isInteger(index) || index < 0) return undefined;
      return ctx.customSkillDirs[index];
    }
    if (rootId === 'project-dsh' || rootId === 'project-agents') {
      const workspace = opts.workspace;
      if (typeof workspace !== 'string' || workspace.trim() === '') return undefined;
      const projectRoot = findProjectRootSync(workspace);
      return rootId === 'project-dsh' ? path.join(projectRoot, '.dsh', 'skills') : path.join(projectRoot, '.agents', 'skills');
    }
    return undefined;
  };

  return api;
}

/** 同步版 projectRoot 解析（向上找最近含 .git 的祖先），供同步的 rootPath 使用。 */
function findProjectRootSync(workspace: string): string {
  let current = path.resolve(workspace);
  for (;;) {
    try {
      if (statSync(path.join(current, '.git')) !== undefined) return current;
    } catch {
      /* 不存在或不可读，继续向上 */
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(workspace);
    current = parent;
  }
}

async function readSkillName(file: string): Promise<string | undefined> {
  const read = await readFileText(file);
  if (read === undefined) return undefined;
  const evaluated = evaluateFrontmatter(read.buffer);
  return evaluated.name;
}
