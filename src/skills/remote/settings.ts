/**
 * 插件自己的技能设置（D-B18）：<hubHome>/skills/settings.json。
 *
 * 目前只有一项 —— GitHub 镜像（前缀式）：实际请求 = 镜像前缀 + 原始完整 URL
 * （例：https://ghfast.top/https://raw.githubusercontent.com/...）。
 * 只作用于下载类地址（raw.githubusercontent.com / codeload.github.com）；
 * api.github.com 与 skills.sh 永不走镜像。
 *
 * 与 .skill-lock.json 无关：本文件是插件自己的存储，不写进 lock。
 */

import path from "node:path";
import { readJsonFile, writeJsonFile } from "./fsx.ts";
import { validation } from "../../shared/errors.ts";
import type { HubContext } from "../../platform/contract/host.ts";
import type { SkillsRemoteSettings } from "../contract/remote.ts";

export const SETTINGS_VERSION = 1;

export function settingsFilePath(ctx: HubContext): string {
  return path.join(ctx.hubHome, "skills", "settings.json");
}

/**
 * 校验用户填的镜像前缀（纯函数，便于单测）：
 *   - 空串（或只有空白）= 清除镜像 → undefined；
 *   - 必须 https:// 开头、且能被 URL 解析 → 否则返回中文原因；
 *   - 合法时补齐结尾 "/"（拼接时直接前缀 + 原始 URL）。
 */
export function normalizeMirror(input: string): { mirror?: string } | { error: string } {
  const trimmed = (input ?? "").trim();
  if (trimmed === "") return {};
  if (!/^https:\/\//i.test(trimmed)) return { error: "GitHub 镜像必须以 https:// 开头。" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: `GitHub 镜像 "${trimmed}" 不是合法地址，请填形如 https://ghfast.top/ 的前缀。` };
  }
  if (parsed.hostname === "") return { error: "GitHub 镜像缺少主机名。" };
  const normalized = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  return { mirror: normalized };
}

/** 非法就抛 VALIDATION(422)（details 带字段路径，界面能标到输入框上）。 */
export function assertMirrorInput(input: string): string | undefined {
  const normalized = normalizeMirror(input);
  if ("error" in normalized) {
    throw validation(normalized.error, [{ path: "githubMirror", message: normalized.error }]);
  }
  return normalized.mirror;
}

/** 读设置（文件缺失 / 不是合法 JSON / 字段形态不对都按「没设置」处理，绝不报错）。 */
export async function readSettings(ctx: HubContext): Promise<SkillsRemoteSettings> {
  const raw = await readJsonFile<SkillsRemoteSettings>(settingsFilePath(ctx));
  if (!raw || typeof raw !== "object") return { version: SETTINGS_VERSION };
  const out: SkillsRemoteSettings = { version: SETTINGS_VERSION };
  if (typeof raw.githubMirror === "string" && raw.githubMirror.trim() !== "")
    out.githubMirror = raw.githubMirror.trim();
  return out;
}

/** 当前镜像前缀（没设置或设置非法时 undefined）。 */
export async function readMirror(ctx: HubContext): Promise<string | undefined> {
  const settings = await readSettings(ctx);
  if (settings.githubMirror === undefined) return undefined;
  const normalized = normalizeMirror(settings.githubMirror);
  return "error" in normalized ? undefined : normalized.mirror;
}

/** 写入设置；mirror 为 undefined 表示清除这一项。 */
export async function writeSettings(ctx: HubContext, mirror: string | undefined): Promise<SkillsRemoteSettings> {
  const next: SkillsRemoteSettings = { version: SETTINGS_VERSION };
  if (mirror !== undefined) next.githubMirror = mirror;
  await writeJsonFile(settingsFilePath(ctx), next);
  return next;
}
