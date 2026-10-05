/**
 * MCP SDK 加载（F1-Q1/Q2）。
 *
 * 事实：DSH 自实现了模块解析拦截层（profile 本地优先，缺失回退 app.asar 安装目录），
 * 因此 profile 插件里 import '@modelcontextprotocol/client' 解析到的是安装目录里的
 * v2.0.0，与内核 @deepseek-ai/dsh-mcp-client 拿到的是同一个物理目录（同一模块实例）。
 * 这条解析路径只在 DSH 进程内成立，独立 Node 脚本复现不出来。
 *
 * 降级要求：SDK 加载失败不得让插件（以及 DSH）崩，只记降级原因，
 * mcp 工具继续存在但只返回「尚未就绪」。
 */

import type { McpSdk } from "../../mcp/contract/runtime.ts";

/** 加载好的 SDK：运行时要的那几个构造函数（契约 McpSdk）+ 诊断信息。 */
export interface LoadedMcpSdk extends McpSdk {
  /** 诊断用：解析到的真实路径与版本。 */
  info?: McpSdkInfo;
}

/** SDK 解析结果（用于 health 与文档）。 */
export interface McpSdkInfo {
  /** 主入口解析到的绝对文件 URL。 */
  mainResolved?: string;
  /** /stdio 子路径解析到的绝对文件 URL。 */
  stdioResolved?: string;
  /** 从安装目录 package.json 读出的版本。 */
  version?: string;
  /** 安装目录绝对路径。 */
  packageDir?: string;
}

export type SdkLoadState =
  | { status: "loaded"; sdk: LoadedMcpSdk; info: McpSdkInfo }
  | { status: "failed"; message: string };

/** 从解析出的文件 URL 反推包目录并读版本。 */
async function describePackage(resolved: string): Promise<McpSdkInfo> {
  const info: McpSdkInfo = {};
  try {
    const url = new URL(resolved);
    info.mainResolved = url.href;
    // 用 fileURLToPath 而不是 url.pathname：Windows 上 pathname 是 "/C:/Users/..."，
    // 带前导斜杠会被当成相对路径，读 package.json 直接失败（实测导致 health 里 version 缺失）。
    const { fileURLToPath } = await import("node:url");
    let mainPath: string;
    try {
      mainPath = fileURLToPath(url);
    } catch {
      mainPath = decodeURIComponent(url.pathname);
    }
    // 统一成 /（fileURLToPath 在 Windows 上给的是反斜杠路径，而 marker 用 /）
    // .../@modelcontextprotocol/client/dist/index.mjs → 包根
    const normalized = mainPath.replace(/\\/g, "/");
    const marker = "@modelcontextprotocol/client/";
    const at = normalized.lastIndexOf(marker);
    if (at === -1) return info;
    const packageDir = normalized.slice(0, at + marker.length - 1);
    info.packageDir = packageDir;
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(`${packageDir}/package.json`, "utf8")) as { version?: string };
    if (typeof manifest.version === "string") info.version = manifest.version;
  } catch {
    /* 诊断信息尽力而为，取不到就算了 */
  }
  return info;
}

/**
 * 动态加载 MCP SDK。永不 reject。
 * @param importer 供测试注入的 import 函数（默认 globalThis 的动态 import）
 */
export async function loadMcpSdk(
  importer: (specifier: string) => Promise<unknown> = (specifier) => import(/* @vite-ignore */ specifier),
): Promise<SdkLoadState> {
  try {
    const [main, stdio] = await Promise.all([
      importer("@modelcontextprotocol/client"),
      importer("@modelcontextprotocol/client/stdio"),
    ]);
    const mainMod = main as Record<string, unknown>;
    const stdioMod = stdio as Record<string, unknown>;
    const missing: string[] = [];
    if (typeof mainMod.Client !== "function" && typeof mainMod.Client !== "object") missing.push("Client");
    if (typeof mainMod.StreamableHTTPClientTransport !== "function") missing.push("StreamableHTTPClientTransport");
    if (typeof stdioMod.StdioClientTransport !== "function") missing.push("StdioClientTransport");
    if (missing.length > 0) {
      return { status: "failed", message: `MCP SDK 导出不完整，缺少：${missing.join(", ")}` };
    }
    const sdk: LoadedMcpSdk = {
      Client: mainMod.Client,
      StdioClientTransport: stdioMod.StdioClientTransport,
      StreamableHTTPClientTransport: mainMod.StreamableHTTPClientTransport,
    };
    let info: McpSdkInfo = {};
    try {
      const resolved = import.meta.resolve?.("@modelcontextprotocol/client");
      if (typeof resolved === "string") info = await describePackage(resolved);
    } catch {
      /* import.meta.resolve 不可用时只留空 info */
    }
    info.stdioResolved = `${info.packageDir ?? ""}/dist/stdio.mjs`;
    if (info.packageDir === undefined) delete info.stdioResolved;
    sdk.info = info;
    return { status: "loaded", sdk, info };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", message: `MCP SDK 加载失败：${message}` };
  }
}
