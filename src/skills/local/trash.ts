/**
 * 回收站：hubHome/skills/trash/<trashId>/ 下放 payload（技能目录或平铺 .md 文件）+ meta.json。
 * 整目录移动（跨盘时 copy+delete，失败回滚）；meta.json 记录 lock 条目以便恢复时放回。
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { TrashReason } from "../contract/local.ts";
import { atomicWriteFile, copyPath, movePath, pathExists, readFileText, removePath, statOrUndefined } from "./fsx.ts";

export interface TrashMeta {
  version: 1;
  trashId: string;
  skillId: string;
  rootId: string;
  dirName: string;
  originalPath: string;
  /** 删除时该技能所属根的路径（恢复时用于定位与重建根） */
  rootPath: string;
  name?: string;
  reason: TrashReason;
  deletedAt: string;
  hasLockEntry: boolean;
  /** npx skills 的 lock 条目原文（不透明，恢复时原样放回） */
  lockEntry?: unknown;
  /** payload 是目录还是平铺文件 */
  kind: "dir" | "file";
}

export const TRASH_PAYLOAD = "payload";
export const TRASH_META = "meta.json";

export class TrashStore {
  private readonly root: string;

  constructor(hubHome: string) {
    this.root = path.join(hubHome, "skills", "trash");
  }

  get rootDir(): string {
    return this.root;
  }

  dirOf(trashId: string): string {
    return path.join(this.root, trashId);
  }

  payloadOf(trashId: string): string {
    return path.join(this.dirOf(trashId), TRASH_PAYLOAD);
  }

  metaOf(trashId: string): string {
    return path.join(this.dirOf(trashId), TRASH_META);
  }

  async readMeta(trashId: string): Promise<TrashMeta | undefined> {
    const read = await readFileText(this.metaOf(trashId));
    if (read === undefined) return undefined;
    try {
      return JSON.parse(read.text) as TrashMeta;
    } catch {
      return undefined;
    }
  }

  async writeMeta(meta: TrashMeta): Promise<void> {
    await atomicWriteFile(this.metaOf(meta.trashId), JSON.stringify(meta, null, 2));
  }

  /**
   * 把 sourcePath 整条移入回收站，并落 meta.json。
   * 返回 trashId 与 payload 路径；失败时回滚（payload 移回原位、临时目录删除）。
   */
  async stash(
    sourcePath: string,
    meta: Omit<TrashMeta, "version" | "trashId" | "deletedAt"> & { trashId?: string; deletedAt?: string },
  ): Promise<TrashMeta> {
    const trashId = meta.trashId ?? newTrashId();
    const dir = this.dirOf(trashId);
    const payload = this.payloadOf(trashId);
    const full: TrashMeta = {
      ...meta,
      version: 1,
      trashId,
      deletedAt: meta.deletedAt ?? new Date().toISOString(),
    } as TrashMeta;

    await fs.mkdir(dir, { recursive: true });
    let moved = false;
    try {
      await movePath(sourcePath, payload);
      moved = true;
      await this.writeMeta(full);
    } catch (error) {
      if (moved) {
        try {
          await movePath(payload, sourcePath);
        } catch {
          /* 回滚失败：保留回收站内容，避免数据丢失 */
        }
      }
      await removePath(dir);
      throw error;
    }
    return full;
  }

  /** payload 存在时把它移回 targetPath。 */
  async unstash(trashId: string, targetPath: string): Promise<void> {
    await movePath(this.payloadOf(trashId), targetPath);
  }

  async listMeta(): Promise<TrashMeta[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: TrashMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await this.readMeta(entry.name);
      if (meta === undefined) continue;
      out.push(meta);
    }
    out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
    return out;
  }

  async drop(trashId: string): Promise<void> {
    await removePath(this.dirOf(trashId));
  }

  async hasPayload(trashId: string): Promise<boolean> {
    return await pathExists(this.payloadOf(trashId));
  }

  /** 跨盘复制回退时使用的辅助（保留导出以便测试）。 */
  async copyBack(trashId: string, targetPath: string): Promise<void> {
    await copyPath(this.payloadOf(trashId), targetPath);
    await removePath(this.dirOf(trashId));
  }

  async payloadStat(trashId: string): Promise<import("node:fs").Stats | undefined> {
    return await statOrUndefined(this.payloadOf(trashId));
  }
}

export function newTrashId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return stamp + "-" + rand;
}

/**
 * FIX-5：trashId 的合法性判据 —— 必须是「安全单段名」。
 *
 * newTrashId 的输出（形如 `20261004T230239123Z-ab12cd`，匹配 /^[0-9TZ]+-[a-z0-9]{1,12}$/）
 * 天然满足；这里刻意**不**把时间戳形态当硬门槛，以兼容历史 / 手工写下的条目
 * （例如伪造的 meta.json，或旧版本留下的 id）—— 只要仍是安全单段就必须能恢复/清理。
 *
 * 拒绝：`.` / `..`、以点开头的名字、含 `/` `\` NUL 或其它控制字符、空串、超长（>64）。
 * 这样 `trash.dirOf(id)` 只可能是回收站根下的一个直接子目录，绝无路径穿越。
 */
export const TRASH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidTrashId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "." || value === "..") return false;
  return TRASH_ID_PATTERN.test(value);
}

/** JSON 往返，确保 lockEntry 可持久化；不可序列化时抛出（绝不静默丢数据）。 */
export function normalizeLockEntry(entry: unknown): unknown {
  if (entry === undefined) return undefined;
  return JSON.parse(JSON.stringify(entry));
}
