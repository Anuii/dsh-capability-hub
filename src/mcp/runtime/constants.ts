/**
 * mcp-runtime 常量（只剩 envFrom 用到的；连接相关的都交给官方 dsh-mcp-client，ADR-0010）。
 * 只放常量，不 import 任何东西。
 */

/** envFrom 默认超时与捕获上限（含「先追加再截断」所需的硬上限，D-D8）。 */
export const ENV_FROM_DEFAULT_TIMEOUT_MS = 10_000;
export const ENV_FROM_STDOUT_LIMIT = 64 * 1024;
export const ENV_FROM_STDERR_LIMIT = 2000;
export const ENV_FROM_KILL_GRACE_MS = 1000;

/** envFrom 命令 stderr 的捕获上限与摘要行数（按字节截，解码推迟到最后）。 */
export const MAX_STDERR_CAPTURE = 8 * 1024;
export const STDERR_SUMMARY_LINES = 3;

/** envFrom 命令需要从父进程显式带入的代理相关变量。 */
export const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
];
