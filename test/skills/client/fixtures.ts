/**
 * 客户端技能页单测用的夹具工厂（纯数据，不碰 DOM / React）。
 */
import type { Diagnostic, ListResult, RootInfo, SkillSummary, TrashItem } from "../../../src/skills/contract/local.ts";

export function makeSkill(overrides: Partial<SkillSummary> & { id: string }): SkillSummary {
  const base: SkillSummary = {
    id: overrides.id,
    rootId: overrides.rootId ?? "user-agents",
    dirName: overrides.dirName ?? overrides.id.split(":")[1] ?? overrides.id,
    path: overrides.path ?? "C:\\fixture\\skills\\" + overrides.id.split(":")[1],
    writable: true,
    modelInvocationDisabled: false,
    userInvocable: null,
    loadable: true,
    modelVisible: true,
    diagnostics: [],
    format: { eol: "lf", bom: false, safeToToggle: true },
    extraKeys: [],
    mtimeMs: 1_700_000_000_000,
  };
  return { ...base, ...overrides };
}

export function diag(level: Diagnostic["level"], code: string, message?: string): Diagnostic {
  return { level, code, message: message ?? code + " 的中文说明" };
}

export function root(rootId: string, overrides: Partial<RootInfo> = {}): RootInfo {
  return {
    rootId,
    path: "C:\\fixture\\" + rootId,
    exists: true,
    writable: true,
    precedence: 500,
    ...overrides,
  };
}

export function makeList(roots: RootInfo[], skills: SkillSummary[], warnings: string[] = []): ListResult {
  return { roots, skills, warnings };
}

export function makeTrashItem(overrides: Partial<TrashItem> & { trashId: string }): TrashItem {
  return {
    trashId: overrides.trashId,
    skillId: overrides.skillId ?? "user-agents:demo",
    rootId: overrides.rootId ?? "user-agents",
    dirName: overrides.dirName ?? "demo",
    originalPath: overrides.originalPath ?? "C:\\fixture\\skills\\demo",
    reason: overrides.reason ?? "delete",
    deletedAt: overrides.deletedAt ?? "2026-10-04T12:00:00.000Z",
    hasLockEntry: overrides.hasLockEntry ?? false,
  };
}
