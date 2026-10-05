/**
 * 仓库列表：<hubHome>/skills/repos.json。
 *
 * 默认预置（参考 CC Switch 的 SkillStore::default，均经 GitHub 只读 API 确认存在，见 docs）：
 *   - anthropics/skills            （默认分支 main）
 *   - ComposioHQ/awesome-claude-skills（默认分支 master）
 *   - mattpocock/skills            （默认分支 main）
 *   - vercel-labs/skills           （默认分支 main）
 * 另提供一个「已内置确认、但默认不添加」的候选：JimLiu/baoyu-skills。
 *
 * 首次读取时若文件不存在则落盘预置列表；用户删空后写成 { repos: [] } 时不再复活预置。
 */

import path from 'node:path';
import { pathExists, readJsonFile, writeJsonFile } from './fsx.ts';
import { badRequest, conflict, notFound, validation } from './errors.ts';
import { describeUnsafePath } from './safepath.ts';
import type { RepoReposFile } from './types.ts';
import type { HubContext } from '../../platform/contract/host.ts';
import type { RepoRecord } from '../contract/remote.ts';

const REPOS_VERSION = 1;

export interface PresetRepo {
  repo: string;
  ref?: string;
  /** 中文说明，供 UI 展示 */
  note: string;
}

export const PRESET_REPOS: PresetRepo[] = [
  { repo: 'anthropics/skills', ref: 'main', note: 'Anthropic 官方技能库' },
  { repo: 'ComposioHQ/awesome-claude-skills', ref: 'master', note: '社区精选技能合集' },
  { repo: 'mattpocock/skills', ref: 'main', note: 'mattpocock 的工程技能集' },
  { repo: 'vercel-labs/skills', ref: 'main', note: 'npx skills 官方工具仓库' },
];

export function reposFilePath(ctx: HubContext): string {
  return path.join(ctx.hubHome, 'skills', 'repos.json');
}

const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

/** 校验 owner/name 形态（GitHub 用户名与仓库名的宽松版） */
export function assertRepoShape(repo: string): string {
  const trimmed = repo.trim();
  if (trimmed === '') throw badRequest('仓库不能为空，请填写 owner/name。');
  if (!REPO_PATTERN.test(trimmed)) {
    throw validation(`仓库格式不正确（"${trimmed}"），应为 owner/name，例如 anthropics/skills。`, [
      { path: 'repo', message: '应为 owner/name' },
    ]);
  }
  const [owner, name] = trimmed.split('/');
  if (owner!.startsWith('.') || name!.startsWith('.')) {
    throw validation('仓库名不能以点开头。', [{ path: 'repo', message: '不能以点开头' }]);
  }
  return trimmed;
}

/**
 * 校验并归一化仓库子目录：去掉首尾斜杠；空串表示「整个仓库」（返回 undefined）。
 * 必须是安全的相对路径（不许 ..、绝对路径、盘符、反斜杠），否则 VALIDATION。
 */
export function normalizeSubPath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return undefined;
  const reason = describeUnsafePath(trimmed);
  if (reason !== undefined) {
    throw validation(`子目录 "${trimmed}" 不合法（${reason}），应为仓库内的相对路径，例如 skills。`, [
      { path: 'subPath', message: reason },
    ]);
  }
  return trimmed;
}

export interface RepoPatch {
  /** 空串 = 改回默认分支 */
  ref?: string;
  /** 空串 = 整个仓库 */
  subPath?: string;
}

export interface RepoStore {
  list(): Promise<RepoRecord[]>;
  add(repo: string, ref?: string, subPath?: string): Promise<RepoRecord>;
  /** 改分支 / 子目录；返回新记录与「是否真的变了」 */
  update(repo: string, patch: RepoPatch): Promise<{ record: RepoRecord; changed: boolean }>;
  remove(repo: string): Promise<void>;
  /** 预置仓库清单（用于 discover 的候选池；不写盘） */
  presets(): PresetRepo[];
}

/** 只保留认识的字段（旧文件没有 subPath 照常读） */
function cleanRecord(r: RepoRecord): RepoRecord {
  const record: RepoRecord = { repo: r.repo, preset: r.preset === true };
  if (typeof r.ref === 'string' && r.ref !== '') record.ref = r.ref;
  if (typeof r.subPath === 'string' && r.subPath !== '') record.subPath = r.subPath;
  return record;
}

export function createRepoStore(ctx: HubContext): RepoStore {
  async function read(): Promise<RepoReposFile> {
    const file = reposFilePath(ctx);
    if (!(await pathExists(file))) {
      const seeded: RepoReposFile = {
        version: REPOS_VERSION,
        repos: PRESET_REPOS.map((p) => {
          const record: RepoRecord = { repo: p.repo, preset: true };
          if (p.ref !== undefined) record.ref = p.ref;
          return record;
        }),
      };
      await writeJsonFile(file, seeded);
      return seeded;
    }
    const raw = await readJsonFile<RepoReposFile>(file);
    if (!raw || !Array.isArray(raw.repos)) return { version: REPOS_VERSION, repos: [] };
    return {
      version: typeof raw.version === 'number' ? raw.version : REPOS_VERSION,
      repos: raw.repos.filter((r): r is RepoRecord => Boolean(r) && typeof r.repo === 'string'),
    };
  }

  async function write(file: RepoReposFile): Promise<void> {
    await writeJsonFile(reposFilePath(ctx), { ...file, version: REPOS_VERSION });
  }

  return {
    presets: () => PRESET_REPOS.map((p) => ({ ...p })),
    async list() {
      const file = await read();
      return file.repos.map(cleanRecord);
    },
    async add(repo, ref, subPath) {
      const normalized = assertRepoShape(repo);
      const sub = normalizeSubPath(subPath);
      const file = await read();
      const exists = file.repos.find((r) => r.repo.toLowerCase() === normalized.toLowerCase());
      if (exists) throw conflict(`仓库 ${normalized} 已在列表中。`);
      const record: RepoRecord = { repo: normalized, preset: false };
      if (ref !== undefined && ref.trim() !== '') record.ref = ref.trim();
      if (sub !== undefined) record.subPath = sub;
      file.repos.push(record);
      await write(file);
      return record;
    },
    async update(repo, patch) {
      const normalized = repo.trim();
      const file = await read();
      const index = file.repos.findIndex((r) => r.repo.toLowerCase() === normalized.toLowerCase());
      if (index === -1) throw notFound(`仓库 ${normalized} 不在列表中。`);
      const before = cleanRecord(file.repos[index]!);
      const next: RepoRecord = { ...before };
      if (patch.ref !== undefined) {
        const ref = patch.ref.trim();
        if (ref === '') delete next.ref;
        else next.ref = ref;
      }
      if (patch.subPath !== undefined) {
        const sub = normalizeSubPath(patch.subPath);
        if (sub === undefined) delete next.subPath;
        else next.subPath = sub;
      }
      const changed = next.ref !== before.ref || next.subPath !== before.subPath;
      if (changed) {
        file.repos[index] = next;
        await write(file);
      }
      return { record: next, changed };
    },
    async remove(repo) {
      const normalized = repo.trim();
      const file = await read();
      const index = file.repos.findIndex((r) => r.repo.toLowerCase() === normalized.toLowerCase());
      if (index === -1) throw notFound(`仓库 ${normalized} 不在列表中。`);
      file.repos.splice(index, 1);
      await write(file);
    },
  };
}
