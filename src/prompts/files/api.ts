/**
 * prompts-files 的核心实现。
 *
 * 安全红线（契约注释最后一段）：
 *   - **所有接受 id 的路由，先按当前 workspace 重新发现一遍**，id 必须是发现结果里某个文件的 id；
 *     否则 404，绝不读写。这样 `..\` 拼接、绝对路径到别的文件、工作区外的 AGENTS.md 全部被拒。
 *   - create 的位置只能是三个枚举值（global / project-root / workspace），绝不接受任意路径。
 *   - restore 写回的路径只能来自本次发现（该 fileId 的当前路径）；fileId 不在发现范围 → 409。
 *   - 删除一律非递归（回收站 drop 逐个 unlink 再 rmdir）。
 *
 * 写入一律走 shared/node 的原子写（同目录临时文件 → rename）；保存的是界面给的完整文本，按原样写，
 * 不做行尾转换，BOM 与行尾原样保留（读的时候 Buffer.toString("utf8") 不会吃掉 U+FEFF）。
 */

import path from "node:path";
import fs from "node:fs/promises";
import { badRequest, conflict, internal, notFound } from "../../shared/errors.ts";
import { atomicWriteFile, pathExists } from "../../shared/node/fsx.ts";
import { DISABLED_SUFFIX, CREATE_FILE_NAME } from "../rules/names.ts";
import { isValidTrashId } from "../rules/trash-id.ts";
import { discoverPrompts, type DiscoveryContext } from "./discover.ts";
import { isRegularFile, readRaw, sha256Hex } from "./fsx.ts";
import { PromptsTrashStore, newTrashId, type PromptsTrashMeta } from "./trash.ts";
import type { HubContext, HubError } from "../../platform/contract/host.ts";
import type {
  PromptCreateLocation,
  PromptFile,
  PromptsListResult,
  PromptTrashItem,
  PromptView,
} from "../contract/prompts.ts";
import type { PromptSettings } from "./settings.ts";

/** 本模块需要外壳注入的东西。 */
export interface PromptsFilesDeps {
  /**
   * 读 DSH 的提示词设置（组合配置）。是**活值**（函数）：每次请求重新读一次，
   * 与 ctx.customSkillDirs 的口径一致 —— 配置在运行期变化时界面能跟上。
   */
  settings(): PromptSettings;
}

export interface PromptsFilesImpl {
  list(opts?: { workspace?: string }): Promise<PromptsListResult>;
  view(id: string, opts?: { workspace?: string }): Promise<PromptView>;
  save(input: { id: string; content: string; baseVersion: string; workspace?: string }): Promise<{ file: PromptFile }>;
  create(location: PromptCreateLocation, opts?: { workspace?: string }): Promise<{ file: PromptFile }>;
  setEnabled(id: string, enabled: boolean, opts?: { workspace?: string }): Promise<{ file: PromptFile }>;
  trashList(): Promise<PromptTrashItem[]>;
  restore(trashId: string, opts?: { workspace?: string }): Promise<{ file: PromptFile }>;
  purge(trashId?: string): Promise<number>;
}

/** 413：文件超过 DSH 的单文件上限，界面不展示正文（见契约 PromptView 的说明）。 */
export function tooLargeError(size: number, limit: number): HubError {
  const error = new Error(
    "该提示词文件 " +
      size +
      " 字节，超过 DSH 的单文件上限（" +
      limit +
      " 字节），DSH 不会加载它；本插件不展示它的正文。",
  ) as HubError;
  error.name = "HubError";
  error.code = "PAYLOAD_TOO_LARGE";
  error.status = 413;
  return error;
}

const LOCATIONS: readonly PromptCreateLocation[] = ["global", "project-root", "workspace"];

export function isCreateLocation(value: unknown): value is PromptCreateLocation {
  return typeof value === "string" && (LOCATIONS as readonly string[]).includes(value);
}

function toTrashItem(meta: PromptsTrashMeta): PromptTrashItem {
  return {
    trashId: meta.trashId,
    fileId: meta.fileId,
    displayPath: meta.displayPath,
    reason: meta.reason,
    savedAt: meta.savedAt,
    size: meta.size,
  };
}

/** 版本：内容字节的 sha256 前 16 位十六进制。 */
function versionOf(buffer: Buffer): string {
  return sha256Hex(buffer).slice(0, 16);
}

export function createPromptsFilesImpl(ctx: HubContext, deps: PromptsFilesDeps): PromptsFilesImpl {
  const trash = new PromptsTrashStore(ctx.hubHome);

  const discover = async (workspace: string | undefined): Promise<DiscoveryContext> => {
    const settings = deps.settings();
    return await discoverPrompts(ctx, workspace === undefined ? { settings } : { workspace, settings });
  };

  /**
   * 把 id 落到本次发现里；找不到一律 404（绝不按 id 拼路径去读）。
   */
  async function locate(
    id: string,
    workspace: string | undefined,
  ): Promise<{ snap: DiscoveryContext; file: PromptFile }> {
    if (typeof id !== "string" || id.trim() === "") throw badRequest("缺少必填参数 id。");
    const snap = await discover(workspace);
    const file = snap.fileById.get(id);
    if (file === undefined) {
      throw notFound(
        "这个路径不是当前工作区下 DSH 会加载的提示词文件，本插件不会读写它：" +
          id +
          "（只能操作全局层或项目根到工作区各层里的提示词文件）。",
      );
    }
    return { snap, file };
  }

  /** 重新读一遍这个文件（写完/改完名之后返回给界面的形状）。 */
  async function refresh(id: string, workspace: string | undefined): Promise<PromptFile> {
    const snap = await discover(workspace);
    const file = snap.fileById.get(id);
    if (file === undefined) throw internal("操作已完成，但重新发现时找不到该提示词文件：" + id);
    return file;
  }

  async function currentBuffer(file: PromptFile): Promise<Buffer | undefined> {
    const read = await readRaw(file.path);
    return read?.buffer;
  }

  const api: PromptsFilesImpl = {
    async list(opts = {}) {
      const settings = deps.settings();
      const snap = await discover(opts.workspace);
      const result: PromptsListResult = {
        layers: snap.discovery.layers,
        budget: { maxBytes: settings.maxBytes, usedBytes: snap.usedBytes, source: settings.source },
        warnings: [...snap.discovery.warnings, ...settings.notes],
      };
      if (snap.discovery.projectRoot !== undefined) result.projectRoot = snap.discovery.projectRoot;
      if (settings.loaderDisabled) result.loaderDisabled = true;
      return result;
    },

    async view(id, opts = {}) {
      const settings = deps.settings();
      const { file } = await locate(id, opts.workspace);
      if (file.tooLarge === true || file.size > settings.maxSourceBytes) {
        throw tooLargeError(file.size, settings.maxSourceBytes);
      }
      const read = await readRaw(file.path);
      if (read === undefined) throw notFound("读不到该提示词文件（可能刚被删除或改名）：" + file.path);
      return { file, content: read.text };
    },

    async save(input) {
      const { file } = await locate(input.id, input.workspace);
      if (typeof input.content !== "string") throw badRequest("参数 content 必须是字符串。");
      if (typeof input.baseVersion !== "string" || input.baseVersion === "") {
        throw badRequest("缺少必填参数 baseVersion（界面带回来的当前版本）。");
      }
      const buffer = await currentBuffer(file);
      if (buffer === undefined) throw notFound("读不到该提示词文件（可能刚被删除或改名）：" + file.path);
      const currentVersion = versionOf(buffer);
      if (currentVersion !== input.baseVersion) {
        throw conflict(
          "这个提示词文件在别处被改过了（磁盘上是 " +
            currentVersion +
            "，界面拿的是 " +
            input.baseVersion +
            "），本插件不覆盖，请重新加载后再改。",
        );
      }
      // 覆盖前的内容先进回收站（reason "save"）
      await trash.stash(buffer.toString("utf8"), {
        fileId: file.id,
        displayPath: file.displayPath,
        reason: "save",
      });
      await atomicWriteFile(file.path, input.content);
      return { file: await refresh(file.id, input.workspace) };
    },

    async create(location, opts = {}) {
      if (!isCreateLocation(location)) {
        throw badRequest("location 只能是 global / project-root / workspace 之一。");
      }
      const settings = deps.settings();
      if (!settings.fileNames.includes(CREATE_FILE_NAME)) {
        throw conflict("当前 DSH 的提示词候选文件名里没有 " + CREATE_FILE_NAME + "（组合配置改过），本插件不新建。");
      }
      const snap = await discover(opts.workspace);
      let dir: string | undefined;
      if (location === "global") dir = ctx.dshHome;
      else if (location === "project-root") dir = snap.discovery.projectRoot;
      else dir = snap.discovery.workspace;
      if (dir === undefined) {
        throw badRequest(
          location === "global"
            ? "全局提示词目录不可用。"
            : "没有工作区（或工作区目录不存在），不能在这个位置新建：" + location + "。",
        );
      }
      const target = path.join(dir, CREATE_FILE_NAME);
      const disabledTarget = path.join(dir, CREATE_FILE_NAME + DISABLED_SUFFIX);
      if ((await isRegularFile(target)) || (await isRegularFile(disabledTarget))) {
        throw conflict("这个位置已经有 " + CREATE_FILE_NAME + " 了（含停用态），不能重复新建：" + dir);
      }
      if (!(await pathExists(dir))) throw badRequest("目录不存在：" + dir);
      await atomicWriteFile(target, "");
      const file = await refresh(target, opts.workspace);
      return { file };
    },

    async setEnabled(id, enabled, opts = {}) {
      const { file } = await locate(id, opts.workspace);
      if (typeof enabled !== "boolean") throw badRequest("参数 enabled 必须是布尔值。");
      if (file.disabled === !enabled) return { file };
      const dir = path.dirname(file.path);
      const target = path.join(dir, enabled ? file.name : file.name + DISABLED_SUFFIX);
      if (target !== file.path && (await pathExists(target))) {
        throw conflict("目标文件名已存在，本插件什么都不动：" + target);
      }
      try {
        await fs.rename(file.path, target);
      } catch (error) {
        throw internal("改名失败（" + file.path + " → " + target + "）：" + String((error as Error).message));
      }
      return { file: await refresh(file.id, opts.workspace) };
    },

    async trashList() {
      return (await trash.list()).map(toTrashItem);
    },

    async restore(trashId, opts = {}) {
      if (!isValidTrashId(trashId)) {
        throw badRequest(
          "trashId 非法：必须是形如 20261016T224300123Z-ab12cd 的单段标识（不能是 . 或 ..，也不能含 / 与 \\）。",
        );
      }
      const meta = await trash.readMeta(trashId);
      if (meta === undefined) throw notFound("回收站里找不到条目：" + trashId);
      const content = await trash.readContent(trashId);
      if (content === undefined) throw notFound("回收站条目缺少内容文件，无法恢复：" + trashId);

      // 写回路径只能来自本次发现（该 fileId 的当前路径）
      const snap = await discover(opts.workspace);
      const file = snap.fileById.get(meta.fileId);
      if (file === undefined) {
        throw conflict(
          "这个回收站条目对应的提示词文件不在当前工作区的发现范围里（可能换了工作区，或文件已被删除），" +
            "本插件不会凭记录里的路径往别处写：" +
            meta.fileId,
        );
      }
      const target = file.path;
      // 写回前，当前内容同样先进回收站
      const existing = await currentBuffer(file);
      if (existing !== undefined) {
        await trash.stash(existing.toString("utf8"), {
          fileId: file.id,
          displayPath: file.displayPath,
          reason: "restore",
        });
      }
      await atomicWriteFile(target, content);
      await trash.drop(trashId);
      return { file: await refresh(file.id, opts.workspace) };
    },

    async purge(trashId) {
      if (trashId === undefined) return await trash.purgeAll();
      if (!isValidTrashId(trashId)) {
        throw badRequest(
          "trashId 非法：必须是形如 20261016T224300123Z-ab12cd 的单段标识（不能是 . 或 ..，也不能含 / 与 \\）。",
        );
      }
      const meta = await trash.readMeta(trashId);
      if (meta === undefined) throw notFound("回收站里找不到条目：" + trashId);
      await trash.drop(trashId);
      return 1;
    },
  };

  return api;
}

export { newTrashId };
