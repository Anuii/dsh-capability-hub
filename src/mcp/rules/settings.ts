/**
 * MCP 全局设置的规则（宿主落盘前校验、界面即时校验共用一份；ADR-0008）。
 * 落盘只写「用户显式设置且不等于默认值」的项（D-C1）。
 */

import { isNatural, isPlainObject } from "./values.ts";
import type { EffectiveMcpConfig, FieldError, OutputGuard, RawMcpSettings } from "../contract/config.ts";

/** 全局设置白名单。注意：servers 单独存，不是 setting。 */
export const SETTINGS_FIELDS = ["idleTimeout", "outputGuard", "failureBackoffMs"] as const;

export const SETTINGS_DEFAULTS = {
  idleTimeout: 10,
  failureBackoffMs: 60000,
} as const;

export const DEFAULT_OUTPUT_GUARD: OutputGuard = { enabled: true, maxBytes: 51200, maxLines: 2000 };

export interface ParsedSettings {
  errors: FieldError[];
  settings: RawMcpSettings;
}

/** 解析全局设置输入（只保留非默认项）。 */
export function parseSettingsInput(input: unknown): ParsedSettings {
  const errors: FieldError[] = [];
  const settings: RawMcpSettings = {};
  if (input === undefined || input === null) return { errors, settings };
  if (!isPlainObject(input)) {
    errors.push({ path: "settings", message: "全局设置必须是一个 JSON 对象。" });
    return { errors, settings };
  }

  for (const key of Object.keys(input)) {
    if (!(SETTINGS_FIELDS as readonly string[]).includes(key)) {
      errors.push({
        path: "settings." + key,
        message: "未知的全局设置项「" + key + "」。支持的项：" + SETTINGS_FIELDS.join("、") + "。",
      });
    }
  }

  if ("idleTimeout" in input && input.idleTimeout !== undefined && input.idleTimeout !== null) {
    const value = input.idleTimeout;
    if (!isNatural(value)) {
      errors.push({
        path: "settings.idleTimeout",
        message: "空闲回收时间必须是不小于 0 的整数（分钟，0 表示不回收）。",
      });
    } else if (value !== SETTINGS_DEFAULTS.idleTimeout) {
      settings.idleTimeout = value;
    }
  }

  if ("failureBackoffMs" in input && input.failureBackoffMs !== undefined && input.failureBackoffMs !== null) {
    const value = input.failureBackoffMs;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      errors.push({ path: "settings.failureBackoffMs", message: "失败退避时间必须是不小于 0 的整数（毫秒）。" });
    } else if (value !== SETTINGS_DEFAULTS.failureBackoffMs) {
      settings.failureBackoffMs = value;
    }
  }

  if ("outputGuard" in input && input.outputGuard !== undefined && input.outputGuard !== null) {
    const raw = input.outputGuard;
    if (typeof raw === "boolean") {
      if (!raw) settings.outputGuard = false;
    } else if (!isPlainObject(raw)) {
      errors.push({
        path: "settings.outputGuard",
        message: "输出护栏必须是布尔值，或形如 { enabled, maxBytes, maxLines } 的对象。",
      });
    } else {
      const partial: { enabled?: boolean; maxBytes?: number; maxLines?: number } = {};
      for (const key of Object.keys(raw)) {
        if (key !== "enabled" && key !== "maxBytes" && key !== "maxLines") {
          errors.push({
            path: "settings.outputGuard." + key,
            message: "未知的输出护栏项「" + key + "」。支持：enabled、maxBytes、maxLines。",
          });
        }
      }
      if ("enabled" in raw && raw.enabled !== undefined && raw.enabled !== null) {
        if (typeof raw.enabled !== "boolean") {
          errors.push({ path: "settings.outputGuard.enabled", message: "enabled 必须是布尔值。" });
        } else partial.enabled = raw.enabled;
      }
      if ("maxBytes" in raw && raw.maxBytes !== undefined && raw.maxBytes !== null) {
        if (typeof raw.maxBytes !== "number" || !Number.isSafeInteger(raw.maxBytes) || raw.maxBytes <= 0) {
          errors.push({ path: "settings.outputGuard.maxBytes", message: "maxBytes 必须是大于 0 的整数。" });
        } else partial.maxBytes = raw.maxBytes;
      }
      if ("maxLines" in raw && raw.maxLines !== undefined && raw.maxLines !== null) {
        if (typeof raw.maxLines !== "number" || !Number.isSafeInteger(raw.maxLines) || raw.maxLines <= 0) {
          errors.push({ path: "settings.outputGuard.maxLines", message: "maxLines 必须是大于 0 的整数。" });
        } else partial.maxLines = raw.maxLines;
      }
      if (errors.length === 0) {
        const merged: OutputGuard = { ...DEFAULT_OUTPUT_GUARD, ...partial };
        if (
          merged.enabled !== DEFAULT_OUTPUT_GUARD.enabled ||
          merged.maxBytes !== DEFAULT_OUTPUT_GUARD.maxBytes ||
          merged.maxLines !== DEFAULT_OUTPUT_GUARD.maxLines
        ) {
          settings.outputGuard = partial;
        }
      }
    }
  }

  return { errors, settings };
}

/** 把落盘设置解析成完整值。 */
export function effectiveSettings(raw: RawMcpSettings | undefined): EffectiveMcpConfig["settings"] {
  const source = isPlainObject(raw) ? (raw as RawMcpSettings) : {};
  const guard: OutputGuard =
    source.outputGuard === false
      ? { ...DEFAULT_OUTPUT_GUARD, enabled: false }
      : isPlainObject(source.outputGuard)
        ? { ...DEFAULT_OUTPUT_GUARD, ...(source.outputGuard as Record<string, unknown>) }
        : { ...DEFAULT_OUTPUT_GUARD };
  return {
    idleTimeoutMin: isNatural(source.idleTimeout) ? source.idleTimeout : SETTINGS_DEFAULTS.idleTimeout,
    outputGuard: guard,
    failureBackoffMs:
      typeof source.failureBackoffMs === "number" &&
      Number.isSafeInteger(source.failureBackoffMs) &&
      source.failureBackoffMs >= 0
        ? source.failureBackoffMs
        : SETTINGS_DEFAULTS.failureBackoffMs,
  };
}
