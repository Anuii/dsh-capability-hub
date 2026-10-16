/**
 * 提示词的测试夹具：全部在 os.tmpdir() 下自建，绝不触碰真实用户目录。
 *
 * 清理**不用递归删除**（仓库硬规则）：逐个 unlink 文件、再自底向上 rmdir 空目录；
 * 符号链接只 unlink 链接本身，绝不跟随。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultPromptSettings, type PromptSettings } from "../../src/prompts/files/settings.ts";
import type { HubContext, HubLogger } from "../../src/platform/contract/host.ts";

export const QUIET_LOGGER: HubLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface PromptArea {
  root: string;
  homeDir: string;
  dshHome: string;
  hubHome: string;
  /** 默认工作区（root/workspace），测试可以另建 */
  workspace: string;
  cleanup(): Promise<void>;
}

/** 非递归删除：先删文件、再删空目录；符号链接只 unlink 链接本身。 */
export async function removeTreeNonRecursive(dir: string): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) await removeTreeNonRecursive(full);
    else await fs.unlink(full).catch(() => undefined);
  }
  await fs.rmdir(dir).catch(() => undefined);
}

export async function makePromptArea(label: string): Promise<PromptArea> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chub-prompts-" + label + "-"));
  const homeDir = path.join(root, "home");
  const dshHome = path.join(homeDir, ".dsh");
  const hubHome = path.join(dshHome, "storages", "dsh-capability-hub");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(dshHome, { recursive: true });
  await fs.mkdir(hubHome, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  return {
    root,
    homeDir,
    dshHome,
    hubHome,
    workspace,
    async cleanup() {
      await removeTreeNonRecursive(root);
    },
  };
}

export function makeCtx(area: PromptArea, overrides: Partial<HubContext> = {}): HubContext {
  const ctx: HubContext = {
    homeDir: area.homeDir,
    dshHome: area.dshHome,
    hubHome: area.hubHome,
    profileName: "test",
    logger: QUIET_LOGGER,
    customSkillDirs: [],
  };
  return { ...ctx, ...overrides };
}

/** 测试用的设置：默认走 DSH 的默认值，但把「加载已关闭」关掉（单测关心的是发现与读写）。 */
export function makeSettings(overrides: Partial<PromptSettings> = {}): PromptSettings {
  return { ...defaultPromptSettings(), loaderDisabled: false, ...overrides };
}

/** 写一个提示词文件（相对 area.root）。 */
export async function writeAt(area: PromptArea, rel: string, content: string | Buffer): Promise<string> {
  const full = path.join(area.root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

export async function readBytes(file: string): Promise<Buffer> {
  return await fs.readFile(file);
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 收集发现结果里全部文件的 id（含全局与项目各层）。 */
export function allIds(layers: { files: { id: string }[] }[]): string[] {
  return layers.flatMap((layer) => layer.files.map((file) => file.id));
}

export async function mkdirp(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}
