/**
 * 检查更新与应用更新（D-B9 / D-B10 / D-B18，与 CC Switch 的语义一致）。
 *
 * 检查：仅在请求时执行；按 repo+ref 分组、**各组并行**（并发上限 4），每个仓库只发一次
 *       trees API；比较「上游目录哈希」与「条目记录值」，返回
 *       up-to-date / update-available / no-source / error。
 *
 * D-B18 的省流量规则（顺序即优先级）：
 *   1. 目录指纹命中（fingerprints.json 里的 treeSha 与上游当前目录 sha 相同，且
 *      contentHash 仍等于 lock/sources 里的 skillFolderHash）→ 直接返回**上次的结论**
 *      （up-to-date 或 update-available），**不下载任何文件**；
 *   2. 否则只下载**该技能目录下**的文件（raw），拼成 TarEntry[] 后套用既有哈希口径；
 *   3. 树被截断或技能在仓库根 → 回退下载整份 tar.gz（旧路径）。
 *
 * 应用（PLAN §3.4 顺序，任一步失败都要把目录恢复原状）：
 *   1. 记录原启停状态（modelInvocationDisabled）
 *   2. deps.skills.moveToTrash(id, { reason:'update', lockEntry: 更新前条目 })  ← 旧版本进回收站可恢复
 *   3. 放入上游新目录（写入失败则从回收站拿回旧目录）
 *   4. 原来是停用 → deps.skills.setEnabled(id, false)
 *   5. 写回来源（新 skillFolderHash、updatedAt；installedAt 不变）
 * 不做本地改动提醒，直接覆盖（与 CC Switch 一致）。
 */

import path from "node:path";
import { mkdir, rename } from "node:fs/promises";
import { describeUnsafePath } from "./safepath.ts";
import { hashesEqual, recordedHash } from "./hash.ts";
import { upstreamSkillHash } from "./rootskill.ts";
import { writeDirectoryFiles } from "./fsx.ts";
import { pathExists, removePath } from "../../shared/node/fsx.ts";
import { locateSkill, type LocatedSkill } from "./install.ts";
import { skillDirOf, skillMdPathOf } from "./sourceurl.ts";
import { FLAT_SKILL_UNSUPPORTED_MESSAGE, isFlatSkill } from "./skillshape.ts";
import { planRepoContents, type RepoContentsPlan, type SkillContent } from "./skilltree.ts";
import { createLimiter, mapLimited } from "./limited.ts";
import { OPERATION_CONCURRENCY } from "./github.ts";
import type { GitHubClient } from "./github.ts";
import type { AuthMode } from "../contract/remote.ts";
import type { SkillsLocalPort } from "./types.ts";
import type { UpdateApplyItem, UpdateApplyResult, UpdateCheckItem, UpdateCheckResult } from "../contract/remote.ts";
import type { SourceStore } from "./lockstore.ts";
import type { FingerprintStore } from "./fingerprints.ts";
import type { HubLogger } from "../../platform/contract/host.ts";

/** 同一批里最多同时请求几个仓库（每个仓库一次 trees API） */
export const UPDATE_CONCURRENCY = 4;

export interface UpdateDeps {
  github: GitHubClient;
  skills: SkillsLocalPort;
  sources: SourceStore;
  /** 目录指纹存档（D-B18）；不注入则退化为「每次都比内容」 */
  fingerprints?: FingerprintStore;
  /** 记「回退下载整份归档」这类诊断信息用；不注入就不记 */
  logger?: HubLogger;
  now?: () => Date;
}

interface DownloadGroup {
  key: string;
  repo: string;
  ref?: string;
  /** 该组里每个技能的 lock 键（repo+ref+skillPath）→ 技能 id 列表 */
  targets: { skillId: string; skillPath: string; contentHash?: string }[];
}

function groupKey(repo: string, ref: string | undefined): string {
  return `${repo.toLowerCase()}@${ref ?? ""}`;
}

/** 上游技能目录路径为空串 = 技能就在仓库根（FIX-6 / D-1 的根级 skillPath）；消息里说人话 */
function displayDir(dirPath: string): string {
  return dirPath === "" ? "仓库根" : dirPath;
}

/**
 * 「可以更新」的统一文案。
 *
 * 两条路径（指纹命中 / 现下载核对）必须给出**逐字相同**的一句 —— 指纹命中的那次
 * 没有下载内容，拿不到实际 ref，用 group.ref ?? "HEAD" 顶上（也就是请求时用的那个 ref）。
 */
function updateAvailableMessage(repo: string, ref: string | undefined, dir: string): string {
  return `上游 ${repo}@${ref ?? "HEAD"} 的 ${displayDir(dir)} 与登记的内容哈希不一致，可以更新。`;
}

/** 读取技能内容：先看计划，计划是 Error 就直接抛 */
async function loadContent(plan: RepoContentsPlan, skillPath: string): Promise<SkillContent> {
  const planned = plan.plans.get(skillPath);
  if (planned === undefined) throw new Error("内部错误：没有该技能的内容计划。");
  if (planned instanceof Error) throw planned;
  return await planned.load();
}

export async function checkUpdates(
  deps: UpdateDeps,
  options: { ids?: string[]; workspace?: string },
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
        status: "no-source",
        message: FLAT_SKILL_UNSUPPORTED_MESSAGE,
      });
      continue;
    }
    const record = await deps.sources.get(
      { rootId: skill.rootId, dirName: skill.dirName, path: skill.path },
      skill.name ?? skill.dirName,
    );
    if (record === undefined || record.entry.repo === "" || !record.entry.skillFolderHash) {
      results.push({
        skillId: skill.id,
        status: "no-source",
        message: "该技能没有来源记录，无法检查更新。请先手动登记来源。",
      });
      continue;
    }
    const key = groupKey(record.entry.repo, record.entry.ref);
    const target = { skillId: skill.id, skillPath: record.entry.skillPath, contentHash: record.entry.skillFolderHash };
    const group = groups.get(key);
    if (group) group.targets.push(target);
    else groups.set(key, { key, repo: record.entry.repo, ref: record.entry.ref, targets: [target] });
  }

  const auth = await deps.github.auth();
  // D-B18：整次检查共用一个并发闸门（上限 12）—— 多组并行时每组的 raw 都从这里过，
  // 因此「在途请求数」是全局上限而不是「组数 × 每组上限」。
  const limiter = createLimiter(OPERATION_CONCURRENCY);
  // 各组并行（上限 4），每个仓库一次 trees API。同一批里任何一组的失败只影响它自己。
  const plans = await mapLimited([...groups.values()], UPDATE_CONCURRENCY, async (group) => {
    const plan = await planRepoContents(
      { github: deps.github },
      {
        repo: group.repo,
        ref: group.ref,
        skillPaths: group.targets.map((target) => target.skillPath),
        limiter,
      },
    ).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    return [group.key, plan] as const;
  });
  const planByGroup = new Map<string, RepoContentsPlan | Error>(plans);

  // 技能之间也并行：多个仓库的技能一起排队过同一个闸门（上限 12），
  // 而不是「一组一组串着来」。结果按 groups 的插入顺序摊平，因此返回顺序与串行时一致。
  const groupList = [...groups.values()];
  const perGroup = await mapLimited(groupList, UPDATE_CONCURRENCY, async (group) => {
    const plan = planByGroup.get(group.key);
    const items: UpdateCheckItem[] = [];
    for (const target of group.targets) {
      if (plan === undefined) {
        items.push({ skillId: target.skillId, status: "error", message: "内部错误：没有对应的目录树结果。" });
        continue;
      }
      if (plan instanceof Error) {
        items.push({ skillId: target.skillId, status: "error", message: plan.message });
        continue;
      }
      if (plan.fallbackReason !== undefined) deps.logger?.debug(plan.fallbackReason, { repo: group.repo });
      const planned = plan.plans.get(target.skillPath);
      const dir =
        planned === undefined || planned instanceof Error ? skillDirOf(target.skillPath).dirPath : planned.dir;
      // 1) 指纹快速路径：目录没变、且内容基准没被外部改过 → 一个字节都不下载，
      //    直接返回上次核对出来的结论（有更新也照样报「有更新」）。
      if (
        planned !== undefined &&
        !(planned instanceof Error) &&
        planned.treeSha !== undefined &&
        target.contentHash !== undefined &&
        deps.fingerprints !== undefined
      ) {
        const saved = await deps.fingerprints.get(group.repo, group.ref, target.skillPath);
        if (saved !== undefined && saved.treeSha === planned.treeSha && saved.contentHash === target.contentHash) {
          if (saved.upToDate) {
            items.push({ skillId: target.skillId, status: "up-to-date" });
          } else {
            items.push({
              skillId: target.skillId,
              status: "update-available",
              message: updateAvailableMessage(group.repo, group.ref, dir),
            });
          }
          continue;
        }
      }
      let loaded: SkillContent;
      try {
        loaded = await loadContent(plan, target.skillPath);
      } catch (error) {
        items.push({
          skillId: target.skillId,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      // FIX-5：上游目录里有不安全路径时，只把这一项报成 error，其余技能照常检查
      const upToDate = hashesEqual(loaded.hash, target.contentHash);
      // 核对过就记指纹（结论一并记下）：下次命中就只剩一次 trees 请求，
      // 「有更新」的那些不再每次重新下载整目录。
      if (loaded.treeSha !== undefined && target.contentHash !== undefined) {
        await deps.fingerprints?.put(group.repo, group.ref, target.skillPath, {
          contentHash: target.contentHash,
          treeSha: loaded.treeSha,
          upToDate,
        });
      }
      if (upToDate) {
        items.push({ skillId: target.skillId, status: "up-to-date" });
      } else {
        items.push({
          skillId: target.skillId,
          status: "update-available",
          message: updateAvailableMessage(group.repo, loaded.ref, dir),
        });
      }
    }
    return items;
  });
  for (const items of perGroup) results.push(...items);

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
  options: { ids: string[]; workspace?: string },
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
      results.push({ skillId: id, ok: false, message: "该技能没有来源记录，无法更新。请先登记来源。" });
      continue;
    }
    locatedList.push(located);
  }

  const groups = new Map<string, DownloadGroup>();
  for (const located of locatedList) {
    const entry = located.source!;
    const key = groupKey(entry.repo, entry.ref);
    const target = { skillId: located.id, skillPath: entry.skillPath, contentHash: entry.skillFolderHash };
    const group = groups.get(key);
    if (group) group.targets.push(target);
    else groups.set(key, { key, repo: entry.repo, ref: entry.ref, targets: [target] });
  }

  // D-B18：同一仓库多个技能共用一次 trees 调用；各组并行（上限 4）；
  // 整次更新共用一个并发闸门（上限 12），多个技能的 raw 一起排队。
  const limiter = createLimiter(OPERATION_CONCURRENCY);
  const plans = await mapLimited([...groups.values()], UPDATE_CONCURRENCY, async (group) => {
    const plan = await planRepoContents(
      { github: deps.github },
      {
        repo: group.repo,
        ref: group.ref,
        skillPaths: group.targets.map((target) => target.skillPath),
        limiter,
      },
    ).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    return [group.key, plan] as const;
  });
  const planByGroup = new Map<string, RepoContentsPlan | Error>(plans);

  // 逐项处理，但**先并行把内容取回来**（一次更新里多个技能的 raw 一起过闸门），
  // 再按原顺序串行落盘 —— 写盘与回收站操作必须保持确定性顺序，只有下载并行。
  const prepared = await mapLimited(locatedList, OPERATION_CONCURRENCY, async (located) => {
    const entry = located.source!;
    const plan = planByGroup.get(groupKey(entry.repo, entry.ref));
    if (plan === undefined) {
      return { located, failure: "内部错误：没有对应的目录树结果。" } as const;
    }
    if (plan instanceof Error) return { located, failure: plan.message } as const;
    const planned = plan.plans.get(entry.skillPath);
    if (planned instanceof Error) {
      return { located, failure: `${planned.message.replace(/。$/, "")}，未做任何改动。` } as const;
    }
    // FIX-5（要求 B/C）：上游目录路径不安全（".." 段 / 反斜杠 / 盘符 …）→ 这一项直接拒绝，
    // 在 moveToTrash 之前返回，技能目录一个字节都不动。
    // FIX-6（D-1）：空串是「技能就在仓库根」的合法形态（没有路径可穿越），跳过这项判定。
    const upstreamDir = planned === undefined ? skillDirOf(entry.skillPath).dirPath : planned.dir;
    const unsafeDir = upstreamDir === "" ? undefined : describeUnsafePath(upstreamDir);
    if (unsafeDir !== undefined) {
      return {
        located,
        failure: `上游 ${entry.repo}@${entry.ref ?? "HEAD"} 的技能目录路径 "${displayDir(upstreamDir)}" 不安全（${unsafeDir}），未做任何改动。`,
      } as const;
    }
    // FIX-5：目录里任何一条文件路径不安全 → 整体拒绝本次更新（逐项，不影响其他技能）
    let loaded: SkillContent;
    try {
      loaded = await loadContent(plan, entry.skillPath);
    } catch (error) {
      return {
        located,
        failure: `${error instanceof Error ? error.message : String(error)}未做任何改动。`,
      } as const;
    }
    if (loaded.files.length === 0) {
      return {
        located,
        failure: `上游 ${displayDir(upstreamDir)} 里没有任何文件，未做任何改动。`,
      } as const;
    }
    return { located, upstreamDir, loaded } as const;
  });

  for (const item of prepared) {
    if ("failure" in item) {
      results.push({ skillId: item.located.id, ok: false, message: item.failure });
      continue;
    }
    const entry = item.located.source!;
    const applied = await applyOneUpdate(
      deps,
      item.located,
      item.loaded,
      item.upstreamDir,
      item.loaded.files,
      options.workspace,
      { repo: entry.repo, ref: entry.ref },
    );
    results.push(applied);
  }

  return { results };
}

async function applyOneUpdate(
  deps: UpdateDeps,
  located: LocatedSkill,
  loaded: SkillContent,
  upstreamDir: string,
  files: { rel: string; data: Buffer }[],
  workspace: string | undefined,
  origin: { repo: string; ref?: string },
): Promise<UpdateApplyItem> {
  const entry = located.source!;
  const wasDisabled = located.modelInvocationDisabled;
  const targetDir = located.path;

  // 1) 记录原启停状态 → 旧版本进回收站（lockEntry = 更新前的条目）
  let trashId: string | undefined;
  try {
    const trashed = await deps.skills.moveToTrash(located.id, {
      ...(workspace !== undefined ? { workspace } : {}),
      reason: "update",
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
      if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTEMPTY" && code !== "EEXIST") throw renameError;
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
  const newHash = recordedHash(loaded.hash);
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
      located.name ?? located.dirName,
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

  // 5) 刷新目录指纹（D-B18）：记录值与上游一致了（upToDate: true），下次检查只剩一次 trees 请求
  if (loaded.treeSha !== undefined) {
    await deps.fingerprints?.put(origin.repo, origin.ref, skillMdPathOf(upstreamDir), {
      contentHash: newHash,
      treeSha: loaded.treeSha,
      upToDate: true,
    });
  }

  const suffix = wasDisabled ? "（已保持停用状态）" : "";
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
  workspace: string | undefined,
): Promise<string> {
  try {
    if (await pathExists(targetDir)) await removePath(targetDir);
  } catch (error) {
    return `另外：清理未完成的新目录也失败了（${error instanceof Error ? error.message : String(error)}），请手动检查 ${targetDir}。`;
  }
  if (trashId === undefined) return "原目录已移入回收站，请到回收站手动恢复。";
  try {
    await deps.skills.restore(trashId, { replace: true, ...(workspace !== undefined ? { workspace } : {}) });
    return "已从回收站恢复原目录。";
  } catch (error) {
    return `原目录仍在回收站（${trashId}），自动恢复失败（${error instanceof Error ? error.message : String(error)}），请到回收站手动恢复。`;
  }
}
