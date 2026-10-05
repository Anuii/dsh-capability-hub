/**
 * 加载 DSH 自带的 yaml 库（ADR-0006，与 MCP SDK 同一做法：D-A4，不打包进插件）。
 *
 * 动态 import 走 DSH 的模块解析拦截层（profile 本地优先，缺失回退 app.asar 安装目录），
 * 拿到的就是 DSH 自己解析技能 frontmatter 用的那份。加载失败不得拖垮插件：
 * 只让依赖它的技能模块降级，原因进 health。
 */

import type { YamlLib } from "../../skills/contract/yaml.ts";

export type YamlLoadState =
  | { status: "loaded"; yaml: YamlLib; version?: string }
  | { status: "failed"; message: string };

/** 动态加载 yaml。永不 reject。 */
export async function loadYaml(
  importer: (specifier: string) => Promise<unknown> = (specifier) => import(/* @vite-ignore */ specifier),
): Promise<YamlLoadState> {
  try {
    const mod = (await importer("yaml")) as Record<string, unknown> & { default?: Record<string, unknown> };
    const lib = (typeof mod.parseDocument === "function" ? mod : mod.default) as Record<string, unknown> | undefined;
    const needed = ["parseDocument", "visit", "isMap", "isSeq", "isScalar", "isPair"];
    const missing = needed.filter((name) => typeof lib?.[name] !== "function");
    if (lib === undefined || missing.length > 0) {
      return { status: "failed", message: "yaml 库导出不完整，缺少：" + missing.join(", ") };
    }
    return { status: "loaded", yaml: lib as unknown as YamlLib, ...(await readVersion()) };
  } catch (error) {
    return {
      status: "failed",
      message: "DSH 自带的 yaml 库加载失败：" + (error instanceof Error ? error.message : String(error)),
    };
  }
}

/** 从解析到的入口反推包目录读版本（诊断用，尽力而为）。 */
async function readVersion(): Promise<{ version?: string }> {
  try {
    const resolved = import.meta.resolve?.("yaml");
    if (typeof resolved !== "string") return {};
    const { fileURLToPath } = await import("node:url");
    const file = fileURLToPath(resolved).replace(/\\/g, "/");
    const at = file.lastIndexOf("/yaml/");
    if (at === -1) return {};
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(file.slice(0, at) + "/yaml/package.json", "utf8")) as {
      version?: unknown;
    };
    return typeof manifest.version === "string" ? { version: manifest.version } : {};
  } catch {
    return {};
  }
}
