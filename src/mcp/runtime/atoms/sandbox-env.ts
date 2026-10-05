/**
 * env 组装（D-D8 / F1-Q2 风险 2）。
 *
 * SDK 的 StdioClientTransport 用 cross-spawn 自己 spawn（不经过 DSH 的 subprocess 服务），
 * 且 env 默认只有 getDefaultEnvironment() 的 11 个白名单变量：
 *   APPDATA, HOMEDRIVE, HOMEPATH, LOCALAPPDATA, PATH, PROCESSOR_ARCHITECTURE,
 *   SYSTEMDRIVE, SYSTEMROOT, TEMP, USERNAME, USERPROFILE, PROGRAMFILES
 * 因此 HTTP_PROXY / HTTPS_PROXY / NO_PROXY / ALL_PROXY / NODE_EXTRA_CA_CERTS 默认都不传，
 * 需要代理的 stdio 服务器会静默失败 —— 必须由我们显式带过去。
 *
 * 注意：**绝不**把整个 process.env 铺进去（会漏令牌与内部变量）。
 */
import { PROXY_ENV_KEYS } from "../constants.ts";

/**
 * 内置的 getDefaultEnvironment() 等价实现（Windows 白名单）。
 * 平台层若注入 sdk.getDefaultEnvironment（推荐），则以注入的为准。
 */
const DEFAULT_INHERITED_ENV_VARS_WIN32 = [
  "APPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATH",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERNAME",
  "USERPROFILE",
  "PROGRAMFILES",
];

const DEFAULT_INHERITED_ENV_VARS_POSIX = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"];

export function fallbackDefaultEnvironment(): Record<string, string> {
  const keys = process.platform === "win32" ? DEFAULT_INHERITED_ENV_VARS_WIN32 : DEFAULT_INHERITED_ENV_VARS_POSIX;
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    // 跳过 cmd.exe 的 command-processor hack：以 "()" 开头的值会在子进程里执行命令。
    if (typeof value === "string" && !value.startsWith("()")) env[key] = value;
  }
  return env;
}

/** 代理相关变量的显式透传（只带存在且有值的）。 */
export function proxyEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return env;
}

/**
 * 组装 stdio 子进程的 env。
 * 优先级（后者覆盖前者）：SDK 默认白名单 → 代理变量 → 服务器配置 env → envFrom 解析结果。
 */
export function buildChildEnv(args: {
  base?: Record<string, string> | undefined;
  proxy?: Record<string, string> | undefined;
  extra?: Record<string, string> | undefined;
  fromCommands?: Record<string, string> | undefined;
}): Record<string, string> {
  return {
    ...(args.base ?? fallbackDefaultEnvironment()),
    ...(args.proxy ?? proxyEnvironment()),
    ...(args.extra ?? {}),
    ...(args.fromCommands ?? {}),
  };
}
