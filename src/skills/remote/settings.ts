/**
 * 插件自己的技能设置（D-B18 / D-B19）：<hubHome>/skills/settings.json。
 *
 * 四项：
 *   - githubMirror：GitHub 镜像（前缀式）：实际请求 = 镜像前缀 + 原始完整 URL
 *     （例：https://ghfast.top/https://raw.githubusercontent.com/...）。
 *     作用于下载类地址（raw.githubusercontent.com / github.com）与 api.github.com 的降级重试。
 *   - mirrorCapabilities / directStatus：上次探测到的镜像能力与直连状态（0.10.0，D-B19）。
 *     只是「显示用」的缓存，坏数据一律按「没探测过」丢弃，绝不影响读取设置本身。
 *
 * 与 .skill-lock.json 无关：本文件是插件自己的存储，不写进 lock。
 */

import path from "node:path";
import { readJsonFile, writeJsonFile } from "./fsx.ts";
import { validation } from "../../shared/errors.ts";
import type { HubContext } from "../../platform/contract/host.ts";
import type { SkillsRemoteSettings } from "../contract/remote.ts";
import type { DirectStatus, MirrorCapabilities } from "../../shared/network.ts";

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

/* ---------- 探测结果的宽松读写（坏数据按「没探测过」处理） ---------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非空字符串才算数（时间戳只验形态，不验能不能解析 —— 显示的永远是「上次探测于 X」） */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 形状不对（不是对象 / configured 不是布尔）就整条丢弃 */
export function sanitizeMirrorCapabilities(raw: unknown): MirrorCapabilities | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw["configured"] !== "boolean") return undefined;
  const out: MirrorCapabilities = { configured: raw["configured"] };
  if (typeof raw["downloads"] === "boolean") out.downloads = raw["downloads"];
  if (typeof raw["api"] === "boolean") out.api = raw["api"];
  const probedAt = nonEmptyString(raw["probedAt"]);
  if (probedAt !== undefined) out.probedAt = probedAt;
  const error = nonEmptyString(raw["error"]);
  if (error !== undefined) out.error = error;
  return out;
}

/** 形状不对（不是对象 / ok 不是布尔 / 没有 checkedAt）就整条丢弃 */
export function sanitizeDirectStatus(raw: unknown): DirectStatus | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw["ok"] !== "boolean") return undefined;
  const checkedAt = nonEmptyString(raw["checkedAt"]);
  if (checkedAt === undefined) return undefined;
  const out: DirectStatus = { ok: raw["ok"], checkedAt };
  if (typeof raw["status"] === "number" && Number.isFinite(raw["status"])) out.status = raw["status"];
  const message = nonEmptyString(raw["message"]);
  if (message !== undefined) out.message = message;
  return out;
}

/* ---------- 读写 ---------- */

/** 读设置（文件缺失 / 不是合法 JSON / 字段形态不对都按「没设置」处理，绝不报错）。 */
export async function readSettings(ctx: HubContext): Promise<SkillsRemoteSettings> {
  const raw = await readJsonFile<SkillsRemoteSettings>(settingsFilePath(ctx));
  if (!raw || typeof raw !== "object") return { version: SETTINGS_VERSION };
  const record = raw as unknown as Record<string, unknown>;
  const out: SkillsRemoteSettings = { version: SETTINGS_VERSION };
  const mirror = nonEmptyString(record["githubMirror"]);
  if (mirror !== undefined) out.githubMirror = mirror;
  const capabilities = sanitizeMirrorCapabilities(record["mirrorCapabilities"]);
  if (capabilities !== undefined) out.mirrorCapabilities = capabilities;
  const direct = sanitizeDirectStatus(record["directStatus"]);
  if (direct !== undefined) out.directStatus = direct;
  return out;
}

/** 当前镜像前缀（没设置或设置非法时 undefined）。 */
export async function readMirror(ctx: HubContext): Promise<string | undefined> {
  const settings = await readSettings(ctx);
  if (settings.githubMirror === undefined) return undefined;
  const normalized = normalizeMirror(settings.githubMirror);
  return "error" in normalized ? undefined : normalized.mirror;
}

/** 要写进 settings.json 的字段（全部可缺省 —— 缺省 = 这一项不写，等于清除） */
export interface SettingsPatch {
  /** undefined / 空串 = 清除镜像 */
  mirror?: string;
  mirrorCapabilities?: MirrorCapabilities;
  directStatus?: DirectStatus;
}

/** 写入设置；patch 里没给的项一律不写（等于清除）。 */
export async function writeSettings(ctx: HubContext, patch: SettingsPatch): Promise<SkillsRemoteSettings> {
  const next: SkillsRemoteSettings = { version: SETTINGS_VERSION };
  const mirror = nonEmptyString(patch.mirror);
  if (mirror !== undefined) next.githubMirror = mirror;
  const capabilities = sanitizeMirrorCapabilities(patch.mirrorCapabilities);
  if (capabilities !== undefined) next.mirrorCapabilities = capabilities;
  const direct = sanitizeDirectStatus(patch.directStatus);
  if (direct !== undefined) next.directStatus = direct;
  await writeJsonFile(settingsFilePath(ctx), next);
  return next;
}
