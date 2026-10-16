/**
 * 提示词回收站：<hubHome>/prompts/trash/<trashId>/ 下放 content（被覆盖/写回前的原文）+ meta.json。
 *
 * 与技能回收站（skills/local/trash.ts）刻意分开：本模块不 import 其他功能模块（ADR-0001 规则 1）。
 * 删除一律**非递归**：先逐个 unlink 文件，再 rmdir 空目录；条目里出现子目录（被人为改过）就拒绝并报错，
 * 绝不 fs.rm({recursive:true}) —— 见仓库 AGENTS.md 的硬规则。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { internal, notFound } from "../../shared/errors.ts";
import { atomicWriteFile, pathExists } from "../../shared/node/fsx.ts";
import { isValidTrashId } from "../rules/trash-id.ts";

export const TRASH_CONTENT = "content";
export const TRASH_META = "meta.json";

/** 回收站条目的元数据（meta.json 的形状；比契约里的 PromptTrashItem 多存原文长度等实现细节）。 */
export interface PromptsTrashMeta {
  version: 1;
  trashId: string;
  /** 被覆盖的那个文件的 id（原名绝对路径） */
  fileId: string;
  displayPath: string;
  reason: "save" | "restore";
  /** ISO 时间 */
  savedAt: string;
  size: number;
}

/** 时间戳 + 随机后缀（形如 20261016T224300123Z-ab12cd，满足 isValidTrashId）。 */
export function newTrashId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return stamp + "-" + rand;
}

export class PromptsTrashStore {
  private readonly root: string;

  constructor(hubHome: string) {
    this.root = path.join(hubHome, "prompts", "trash");
  }

  get rootDir(): string {
    return this.root;
  }

  dirOf(trashId: string): string {
    return path.join(this.root, trashId);
  }

  contentOf(trashId: string): string {
    return path.join(this.dirOf(trashId), TRASH_CONTENT);
  }

  metaOf(trashId: string): string {
    return path.join(this.dirOf(trashId), TRASH_META);
  }

  async readMeta(trashId: string): Promise<PromptsTrashMeta | undefined> {
    try {
      const text = await fs.readFile(this.metaOf(trashId), "utf8");
      const parsed = JSON.parse(text) as PromptsTrashMeta;
      if (typeof parsed?.fileId !== "string" || typeof parsed?.trashId !== "string") return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  async readContent(trashId: string): Promise<string | undefined> {
    try {
      return await fs.readFile(this.contentOf(trashId), "utf8");
    } catch {
      return undefined;
    }
  }

  /** 把一段原文存进回收站，返回它的元数据。 */
  async stash(
    content: string,
    meta: Omit<PromptsTrashMeta, "version" | "trashId" | "savedAt" | "size"> & {
      trashId?: string;
      savedAt?: string;
      size?: number;
    },
  ): Promise<PromptsTrashMeta> {
    const trashId = meta.trashId ?? newTrashId();
    const full: PromptsTrashMeta = {
      version: 1,
      trashId,
      fileId: meta.fileId,
      displayPath: meta.displayPath,
      reason: meta.reason,
      savedAt: meta.savedAt ?? new Date().toISOString(),
      size: meta.size ?? Buffer.byteLength(content, "utf8"),
    };
    await atomicWriteFile(this.contentOf(trashId), content);
    await atomicWriteFile(this.metaOf(trashId), JSON.stringify(full, null, 2));
    return full;
  }

  /** 全部条目（按时间倒序）；读不出的条目跳过。 */
  async list(): Promise<PromptsTrashMeta[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: PromptsTrashMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidTrashId(entry.name)) continue;
      const meta = await this.readMeta(entry.name);
      if (meta === undefined) continue;
      out.push({ ...meta, trashId: entry.name });
    }
    out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
    return out;
  }

  /** 删掉一个条目：只删直接子文件，再删空目录（绝不递归）。 */
  async drop(trashId: string): Promise<void> {
    const dir = this.dirOf(trashId);
    if (!(await pathExists(dir))) throw notFound("回收站里找不到条目：" + trashId);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw internal("读取回收站条目失败：" + String((error as Error).message));
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        throw internal(
          "回收站条目 " + trashId + " 里出现了子目录 " + entry.name + "，本插件不递归删除，已停下；请手工处理。",
        );
      }
      await fs.unlink(path.join(dir, entry.name));
    }
    await fs.rmdir(dir);
  }

  /** 清空回收站，返回清掉的条目数。 */
  async purgeAll(): Promise<number> {
    const items = await this.list();
    for (const item of items) await this.drop(item.trashId);
    return items.length;
  }
}
