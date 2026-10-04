/**
 * 技能根解析与技能扫描（PLAN §3.2）。
 *
 * 与官方 @deepseek-ai/dsh-skill-filesystem 对齐：
 *  - 根与优先级 100/200/300/400/500/600；
 *  - projectRoot 由 workspace 向上找最近含 .git 的祖先，找不到用 workspace 本身；
 *  - user-dsh 跳过 .system；
 *  - 一层深：<dir>/SKILL.md 或 <name>.md；
 *  - 根不存在不报错。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Diagnostic, HubContext, RootId, RootInfo, SkillSummary } from './types.ts';
import { evaluateFrontmatter } from './frontmatter.ts';
import { isDirectory, pathExists, readFileText, statOrUndefined } from './fsx.ts';

export interface RootSpec {
  rootId: RootId;
  path: string;
  writable: boolean;
  precedence: number;
}

export const PROJECT_DSH_ROOT: RootId = 'project-dsh';
export const PROJECT_AGENTS_ROOT: RootId = 'project-agents';
export const USER_DSH_ROOT: RootId = 'user-dsh';
export const USER_AGENTS_ROOT: RootId = 'user-agents';
export const BUNDLED_ROOT: RootId = 'bundled';
export const CUSTOM_ROOT_PREFIX = 'custom-';

export function customRootId(index: number): RootId {
  return CUSTOM_ROOT_PREFIX + String(index);
}

/** 从 workspace 向上找最近含 .git 的祖先；找不到用 workspace 本身（与 DSH 一致，F4-Q1）。 */
export async function findProjectRoot(workspace: string): Promise<string> {
  let current = path.resolve(workspace);
  for (;;) {
    if (await pathExists(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(workspace);
    current = parent;
  }
}

export async function resolveRoots(ctx: HubContext, workspace?: string): Promise<RootSpec[]> {
  const roots: RootSpec[] = [];
  if (typeof workspace === 'string' && workspace.trim() !== '') {
    const projectRoot = await findProjectRoot(workspace);
    roots.push({ rootId: PROJECT_DSH_ROOT, path: path.join(projectRoot, '.dsh', 'skills'), writable: true, precedence: 100 });
    roots.push({ rootId: PROJECT_AGENTS_ROOT, path: path.join(projectRoot, '.agents', 'skills'), writable: true, precedence: 200 });
  }
  const custom = Array.isArray(ctx.customSkillDirs) ? ctx.customSkillDirs : [];
  custom.forEach((dir, index) => {
    if (typeof dir !== 'string' || dir.trim() === '') return;
    roots.push({ rootId: customRootId(index), path: dir, writable: false, precedence: 300 });
  });
  roots.push({ rootId: USER_DSH_ROOT, path: path.join(ctx.dshHome, 'skills'), writable: true, precedence: 400 });
  roots.push({ rootId: USER_AGENTS_ROOT, path: path.join(ctx.homeDir, '.agents', 'skills'), writable: true, precedence: 500 });
  if (typeof ctx.bundledSkillDir === 'string' && ctx.bundledSkillDir.trim() !== '') {
    roots.push({ rootId: BUNDLED_ROOT, path: ctx.bundledSkillDir, writable: false, precedence: 600 });
  }
  return roots;
}

export function rootSpecOf(roots: RootSpec[], rootId: RootId): RootSpec | undefined {
  return roots.find((r) => r.rootId === rootId);
}

export function skillId(rootId: RootId, dirName: string): string {
  return rootId + ':' + dirName;
}

export interface ParsedSkillId {
  rootId: string;
  dirName: string;
}

/** 解析 "<rootId>:<dirName>"；rootId 自身不含冒号，故按第一个冒号切分。 */
export function parseSkillId(id: string): ParsedSkillId | undefined {
  const at = id.indexOf(':');
  if (at <= 0) return undefined;
  const rootId = id.slice(0, at);
  const dirName = id.slice(at + 1);
  if (dirName === '') return undefined;
  return { rootId, dirName };
}

/** 校验目录名（即 id 的右半段）不含路径穿越。 */
export function isSafeDirName(dirName: string): boolean {
  if (dirName === '' || dirName === '.' || dirName === '..') return false;
  if (dirName.includes('/') || dirName.includes('\\')) return false;
  if (dirName.includes(':')) return false;
  return true;
}

export interface ScannedRoot {
  spec: RootSpec;
  exists: boolean;
  /** 读取该根时遇到的问题（中文） */
  problems: string[];
  skills: SkillSummary[];
}

export interface ScanEnv {
  /** 技能根本身是符号链接/junction 的 rootId 集合 */
  linkedRoots: Set<string>;
  /** 技能目录是符号链接/junction 的 skillId 集合 */
  linkedSkills: Map<string, string>;
  /** skillId -> SKILL.md（或平铺 .md）的绝对路径 */
  skillFiles: Map<string, string>;
  /** skillId -> 该技能的文件形态 */
  skillKinds: Map<string, 'dir' | 'file'>;
}

export function newScanEnv(): ScanEnv {
  return { linkedRoots: new Set(), linkedSkills: new Map(), skillFiles: new Map(), skillKinds: new Map() };
}

interface Candidate {
  dirName: string;
  /**
   * SkillSummary.path 的来源：技能目录绝对路径；平铺 .md 技能为该 .md 文件本身的绝对路径
   * （与 types.ts 的契约一致 —— 修复前这里错填了所在根目录，会让删除动作把整个技能根移入回收站）。
   */
  path: string;
  /** SKILL.md（或平铺 .md）绝对路径 */
  file: string;
  isFlatFile: boolean;
}

async function readCandidates(spec: RootSpec, problems: string[], env: ScanEnv): Promise<Candidate[]> {
  const rootStat = await statOrUndefined(spec.path);
  if (rootStat === undefined || !rootStat.isDirectory()) return [];
  const rootLink = await fs.lstat(spec.path).catch(() => undefined);
  if (rootLink !== undefined && rootLink.isSymbolicLink()) env.linkedRoots.add(spec.rootId);

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(spec.path, { withFileTypes: true });
  } catch (error) {
    problems.push('技能根「' + spec.path + '」无法读取：' + String((error as Error).message));
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const candidates: Candidate[] = [];
  for (const entry of entries) {
    if (spec.rootId === USER_DSH_ROOT && entry.name === '.system') continue;
    const abs = path.join(spec.path, entry.name);
    const linkStat = entry.isSymbolicLink() ? await statOrUndefined(abs) : undefined;
    const isDir = entry.isDirectory() || (linkStat?.isDirectory() ?? false);
    const isFile = entry.isFile() || (linkStat?.isFile() ?? false);
    if (isDir) {
      const file = path.join(abs, 'SKILL.md');
      const fileStat = await statOrUndefined(file);
      if (fileStat === undefined || !fileStat.isFile()) {
        // 隐藏目录（如 .trash）没有 SKILL.md 时不列出来，避免噪音
        if (entry.name.startsWith('.')) continue;
        candidates.push({ dirName: entry.name, path: abs, file, isFlatFile: false });
        continue;
      }
      if (entry.isSymbolicLink()) env.linkedSkills.set(skillId(spec.rootId, entry.name), abs);
      candidates.push({ dirName: entry.name, path: abs, file, isFlatFile: false });
      continue;
    }
    if (isFile && entry.name.endsWith('.md')) {
      if (entry.isSymbolicLink()) env.linkedSkills.set(skillId(spec.rootId, entry.name), abs);
      // 平铺技能：path 必须是这个 .md 文件本身，绝不能是 spec.path（根目录），
      // 否则 moveToTrash 会把整个技能根移入回收站（FIX-1）。
      candidates.push({ dirName: entry.name, path: abs, file: abs, isFlatFile: true });
    }
  }
  return candidates;
}

async function summarize(spec: RootSpec, candidate: Candidate, env: ScanEnv): Promise<SkillSummary> {
  const id = skillId(spec.rootId, candidate.dirName);
  env.skillFiles.set(id, candidate.file);
  env.skillKinds.set(id, candidate.isFlatFile ? 'file' : 'dir');
  const read = await readFileText(candidate.file);
  const diagnostics: Diagnostic[] = [];
  if (read === undefined) {
    const targetStat = await statOrUndefined(candidate.path);
    diagnostics.push({
      level: 'error',
      code: 'SKILL_FILE_MISSING',
      message: candidate.isFlatFile
        ? '平铺技能文件「' + candidate.dirName + '」不存在或无法读取，DSH 会忽略它。'
        : '该技能目录下没有可读取的 SKILL.md，DSH 会忽略它。',
    });
    return {
      id,
      rootId: spec.rootId,
      dirName: candidate.dirName,
      path: candidate.path,
      writable: spec.writable,
      modelInvocationDisabled: false,
      userInvocable: null,
      loadable: false,
      modelVisible: false,
      diagnostics,
      format: { eol: 'lf', bom: false, safeToToggle: false },
      extraKeys: [],
      mtimeMs: targetStat?.mtimeMs ?? 0,
    };
  }

  const evaluated = evaluateFrontmatter(read.buffer);
  diagnostics.push(...evaluated.diagnostics);

  if (evaluated.doc !== undefined && evaluated.doc.eol === 'mixed') {
    diagnostics.push({
      level: 'warning',
      code: 'MIXED_EOL',
      message: '文件混用了 LF 与 CRLF 行尾（可能是历史改写工具留下的），本插件不会改写该文件。',
    });
  }
  if (evaluated.name !== undefined && evaluated.name !== candidate.dirName && !candidate.isFlatFile) {
    diagnostics.push({
      level: 'info',
      code: 'NAME_MISMATCH_DIR',
      message: '目录名「' + candidate.dirName + '」与 frontmatter 里的 name「' + evaluated.name + '」不同；DSH 以 frontmatter 的 name 为准。',
    });
  }
  const linked = env.linkedSkills.get(id);
  if (linked !== undefined) {
    diagnostics.push({
      level: 'warning',
      code: 'SYMLINKED_SKILL',
      message: '该技能目录是符号链接/目录联接（指向 ' + linked + '）；本插件会跟随链接写入真实文件，改动可能影响链接另一侧。',
    });
  }

  const extraKeys = evaluated.extraKeys.slice();
  const summary: SkillSummary = {
    id,
    rootId: spec.rootId,
    dirName: candidate.dirName,
    path: candidate.path,
    writable: spec.writable,
    modelInvocationDisabled: evaluated.modelInvocationDisabled,
    userInvocable: evaluated.userInvocable,
    loadable: evaluated.loadable,
    modelVisible: false,
    diagnostics,
    format: { eol: evaluated.doc?.eol ?? 'lf', bom: evaluated.doc?.bom ?? false, safeToToggle: evaluated.safeToToggle },
    extraKeys,
    mtimeMs: read.mtimeMs,
  };
  if (evaluated.name !== undefined) summary.name = evaluated.name;
  if (evaluated.description !== undefined) summary.description = evaluated.description;
  return summary;
}

export async function scanRoots(specs: RootSpec[], env: ScanEnv): Promise<ScannedRoot[]> {
  const out: ScannedRoot[] = [];
  for (const spec of specs) {
    const exists = await isDirectory(spec.path);
    const problems: string[] = [];
    const skills: SkillSummary[] = [];
    if (exists) {
      const candidates = await readCandidates(spec, problems, env);
      for (const candidate of candidates) skills.push(await summarize(spec, candidate, env));
    }
    out.push({ spec, exists, problems, skills });
  }
  return out;
}

/** 跨根同名遮蔽：按 frontmatter name 比对，优先级小者胜（PLAN §3.2）。 */
export function applyShadowing(skills: SkillSummary[], specs: RootSpec[]): void {
  const rank = new Map<string, number>();
  for (const spec of specs) rank.set(spec.rootId, spec.precedence);
  const winner = new Map<string, SkillSummary>();
  for (const skill of skills) {
    if (skill.name === undefined) continue;
    const current = winner.get(skill.name);
    if (current === undefined) {
      winner.set(skill.name, skill);
      continue;
    }
    const a = rank.get(skill.rootId) ?? 9999;
    const b = rank.get(current.rootId) ?? 9999;
    if (a < b) winner.set(skill.name, skill);
  }
  for (const skill of skills) {
    if (skill.name === undefined) {
      skill.modelVisible = false;
      continue;
    }
    const best = winner.get(skill.name);
    if (best !== undefined && best !== skill) {
      skill.shadowedBy = best.id;
      skill.diagnostics.push({
        level: 'warning',
        code: 'SHADOWED_BY_HIGHER_PRIORITY',
        message: '同名技能「' + skill.name + '」在更高优先级的根「' + best.rootId + '」中也存在，DSH 只会加载那一个（本条目不会对模型可见）。',
      });
    }
    skill.modelVisible = skill.loadable && !skill.modelInvocationDisabled && skill.shadowedBy === undefined;
  }
}

export function toRootInfos(scanned: ScannedRoot[]): RootInfo[] {
  return scanned.map((s) => ({
    rootId: s.spec.rootId,
    path: s.spec.path,
    exists: s.exists,
    writable: s.spec.writable,
    precedence: s.spec.precedence,
  }));
}
