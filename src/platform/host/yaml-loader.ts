/**
 * 加载 DSH 自带的 yaml 库（ADR-0006，与 MCP SDK 同一做法：D-A4，不打包进插件）。
 *
 * 要的是 DSH **判断技能能否加载时用的那一份**：先找到 DSH 的 @deepseek-ai/dsh-skill-filesystem，
 * 再从它所在的位置 require("yaml")——不受 profile 里其他插件顺带装的 yaml 影响。找不到时退回普通的
 * 动态 import（走 DSH 的模块解析）。加载失败不得拖垮插件：只让技能模块降级，原因进 health。
 */

import type { YamlLib } from "../../skills/contract/yaml.ts";

export type YamlLoadState =
  | { status: "loaded"; yaml: YamlLib; version?: string; source: "dsh-skill-filesystem" | "import" }
  | { status: "failed"; message: string };

const NEEDED = ["parseDocument", "visit", "isMap", "isSeq", "isScalar", "isPair"] as const;

/** 可注入的加载方式（单测用）。 */
export interface YamlSources {
  /** 从 DSH 的 dsh-skill-filesystem 旁边加载；返回模块与版本，找不到时抛错 */
  besideSkillFilesystem(): Promise<{ module: unknown; version?: string }>;
  /** 普通动态 import */
  importYaml(): Promise<unknown>;
}

function pick(mod: unknown): { lib?: YamlLib; missing: string[] } {
  const record = mod as (Record<string, unknown> & { default?: Record<string, unknown> }) | undefined;
  const lib = typeof record?.parseDocument === "function" ? record : record?.default;
  const missing = NEEDED.filter((name) => typeof lib?.[name] !== "function");
  return missing.length === 0 ? { lib: lib as unknown as YamlLib, missing } : { missing: [...missing] };
}

const realSources: YamlSources = {
  async besideSkillFilesystem() {
    const { createRequire } = await import("node:module");
    const anchor = import.meta.resolve("@deepseek-ai/dsh-skill-filesystem/package.json");
    const require = createRequire(anchor);
    const module = require("yaml") as unknown;
    let version: string | undefined;
    try {
      version = (require("yaml/package.json") as { version?: string }).version;
    } catch {
      // 版本只用于诊断
    }
    return { module, ...(version === undefined ? {} : { version }) };
  },
  importYaml: () => import(/* @vite-ignore */ "yaml"),
};

/** 加载 yaml。永不 reject。 */
export async function loadYaml(sources: YamlSources = realSources): Promise<YamlLoadState> {
  const problems: string[] = [];
  try {
    const found = await sources.besideSkillFilesystem();
    const { lib, missing } = pick(found.module);
    if (lib !== undefined) {
      return {
        status: "loaded",
        yaml: lib,
        source: "dsh-skill-filesystem",
        ...(found.version === undefined ? {} : { version: found.version }),
      };
    }
    problems.push("导出不完整，缺少：" + missing.join(", "));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  try {
    const { lib, missing } = pick(await sources.importYaml());
    if (lib !== undefined) return { status: "loaded", yaml: lib, source: "import" };
    problems.push("导出不完整，缺少：" + missing.join(", "));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return { status: "failed", message: "DSH 自带的 yaml 库加载失败：" + problems.join("；") };
}
