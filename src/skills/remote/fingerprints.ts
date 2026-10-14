/**
 * 目录指纹存档（D-B18）：<hubHome>/skills/fingerprints.json。
 *
 * 检查更新的成本从「下载整个仓库」降到「一次 trees API」的关键在于：把上次核对过的
 * **git tree sha** 记下来，下次只比 sha —— 一样就一个字节都不下载。
 *
 * 但 git tree sha 与 lock 里的 skillFolderHash（npx skills 口径的内容 SHA-256）不是一回事，
 * 单独比 tree sha 会漏掉「上游内容没变、只是 rebase 了」这类情况。因此每条指纹同时记
 * contentHash = **核对当时 lock/sources 里的 skillFolderHash**，并约定：
 *
 *   - contentHash 与当前记录的 skillFolderHash 不同 → 指纹失效（npx skills 在外面更新过，
 *     我们的 tree sha 已经对不上那个内容），重新下载该目录核对；
 *   - treeSha 与上游当前目录的 tree sha 相同 → 直接返回**上次核对出来的结论**，不下载任何文件。
 *
 * 结论（upToDate）也要记：只说「这个目录的 sha 没变」是不够的 —— 目录没变但上次核出来
 * 「与记录值不一致」时，结论就是「有更新」，下次命中指纹应当照样报「有更新」而不是重新下载。
 * 反过来，上游或本地任一方变了（treeSha 变 / contentHash 对不上）就重新核对。
 *
 * 键 = repo 小写 + "\u0000" + ref + "\u0000" + skillPath（ref 缺省时空串）。
 * 这是插件自己的存储，**绝不写进 .skill-lock.json**。
 */

import path from "node:path";
import { readJsonFile, writeJsonFile } from "./fsx.ts";
import type { HubContext } from "../../platform/contract/host.ts";

export const FINGERPRINTS_VERSION = 1;

export function fingerprintsFilePath(ctx: HubContext): string {
  return path.join(ctx.hubHome, "skills", "fingerprints.json");
}

/** 一条指纹 */
export interface SkillFingerprint {
  /** 核对当时 lock/sources 里的 skillFolderHash（与当前记录不同即失效） */
  contentHash: string;
  /** 该技能目录（或仓库根）在那一刻的 git tree sha */
  treeSha: string;
  /** 核对结论：true = 当时判定「最新」；false = 当时判定「有更新」 */
  upToDate: boolean;
  /** 写入 / 刷新的时刻（ISO） */
  verifiedAt: string;
}

export interface FingerprintsFile {
  version: number;
  /** key = fingerprintKey(repo, ref, skillPath) */
  entries: Record<string, SkillFingerprint>;
  [key: string]: unknown;
}

/** 键：仓库小写 + ref + skillPath，用 NUL 分隔（三者都不会含 NUL） */
export function fingerprintKey(repo: string, ref: string | undefined, skillPath: string): string {
  return `${repo.toLowerCase()}\u0000${ref ?? ""}\u0000${skillPath}`;
}

function readShape(raw: unknown): FingerprintsFile {
  if (!raw || typeof raw !== "object") return { version: FINGERPRINTS_VERSION, entries: {} };
  const file = raw as { entries?: unknown };
  const entries: Record<string, SkillFingerprint> = {};
  if (file.entries && typeof file.entries === "object" && !Array.isArray(file.entries)) {
    for (const [key, value] of Object.entries(file.entries as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (typeof record["contentHash"] !== "string" || typeof record["treeSha"] !== "string") continue;
      entries[key] = {
        contentHash: record["contentHash"],
        treeSha: record["treeSha"],
        // 兼容：0.7.1 之前的指纹文件里没有这个字段，当时只有「核对过且最新」才会写指纹，
        // 因此缺失一律按 true 读（否则老用户的指纹会在升级后集体失效，白下载一轮）。
        upToDate: record["upToDate"] === undefined ? true : record["upToDate"] === true,
        verifiedAt: typeof record["verifiedAt"] === "string" ? record["verifiedAt"] : "",
      };
    }
  }
  return { version: FINGERPRINTS_VERSION, entries };
}

export interface FingerprintStore {
  /** 读一条（文件缺失 / 损坏都返回 undefined） */
  get(repo: string, ref: string | undefined, skillPath: string): Promise<SkillFingerprint | undefined>;
  /** 写入 / 覆盖一条 */
  put(
    repo: string,
    ref: string | undefined,
    skillPath: string,
    value: { contentHash: string; treeSha: string; upToDate: boolean; verifiedAt?: string },
  ): Promise<void>;
}

/**
 * 同一进程内用一条 Promise 链串行化「读 - 改 - 写」：检查更新与应用更新可能并发写同一份文件。
 * 写失败只记一条 warn，绝不抛 —— 指纹是纯缓存，写不进去最多下次多下载一次。
 */
export function createFingerprintStore(ctx: HubContext): FingerprintStore {
  let chain: Promise<unknown> = Promise.resolve();

  async function read(): Promise<FingerprintsFile> {
    return readShape(await readJsonFile<FingerprintsFile>(fingerprintsFilePath(ctx)));
  }

  return {
    async get(repo, ref, skillPath) {
      const file = await read();
      return file.entries[fingerprintKey(repo, ref, skillPath)];
    },
    put(repo, ref, skillPath, value) {
      const next = chain.then(async () => {
        const file = await read();
        file.entries[fingerprintKey(repo, ref, skillPath)] = {
          contentHash: value.contentHash,
          treeSha: value.treeSha,
          upToDate: value.upToDate,
          verifiedAt: value.verifiedAt ?? new Date().toISOString(),
        };
        await writeJsonFile(fingerprintsFilePath(ctx), { ...file, version: FINGERPRINTS_VERSION });
      });
      chain = next.catch((error: unknown) => {
        ctx.logger.warn("写入目录指纹失败（不影响本次结果）", (error as Error).message);
      });
      return chain.then(() => undefined);
    },
  };
}
