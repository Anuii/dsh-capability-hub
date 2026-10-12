/**
 * mcp-runtime 常量。取值来源：PLAN §3.5/§3.6、DECISIONS D-D5..D-D8、.research/facts/F3（mcp-lazy 行为规格）。
 * 只放常量，不 import 任何东西。
 */

/** 元数据缓存文件版本与最大年龄（F3-Q3 CACHE_VERSION / DEFAULT_CACHE_MAX_AGE_MS）。 */
export const CACHE_VERSION = 1;
export const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * GET mcp/runtime 的 \`cache.tools[].description\` 上限（FIX-9）：只取描述的第一行，最多这么多个字符。
 * **不追加省略号** —— 前端按原样显示，追加符号会让长度超出上限。
 */
export const CACHE_TOOL_DESCRIPTION_MAX_CHARS = 160;

/** 全局空闲回收默认值（分钟）。0 = 不回收。 */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 10;

/** 输出护栏默认值（F3-Q6 / D-D6）。 */
export const DEFAULT_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_OUTPUT_MAX_LINES = 2000;
/** spill 单文件上限与保留数量。 */
export const SPILL_MAX_BYTES = 16 * 1024 * 1024;
export const SPILL_KEEP_FILES = 50;

/** envFrom 默认超时与捕获上限（F3-Q5，含「先追加再截断」所需的硬上限）。 */
export const ENV_FROM_DEFAULT_TIMEOUT_MS = 10_000;
export const ENV_FROM_STDOUT_LIMIT = 64 * 1024;
export const ENV_FROM_STDERR_LIMIT = 2000;
export const ENV_FROM_KILL_GRACE_MS = 1000;

/** 失败退避默认值（D-D7）。 */
export const DEFAULT_FAILURE_BACKOFF_MS = 60_000;

/** 子进程 stderr 尾部捕获上限（F3-Q6 MAX_STDERR_CHARS / MAX_STDERR_LINES；FIX-4 起按**字节**截，解码推迟到最后）。 */
export const MAX_STDERR_CAPTURE = 8 * 1024;
export const STDERR_SUMMARY_LINES = 3;

/** 空闲巡检周期（F3-Q2 IDLE_SWEEP_INTERVAL_MS）。 */
export const IDLE_SWEEP_INTERVAL_MS = 30_000;

/** 建立连接的超时（契约未规定，本地常量）。 */
export const CONNECT_TIMEOUT_MS = 30_000;
/** 关闭连接时等待 client.close() 的上限，超时后直接杀进程树。 */
export const CLOSE_TIMEOUT_MS = 5_000;
/** 进程树终止后等待进程消失的上限。 */
export const KILL_WAIT_MS = 5_000;

/** 一次成功调用之后，距上次元数据刷新超过该时长则顺带刷新（D-C6）。 */
export const REFRESH_AFTER_MS = 5 * 60_000;

/** 需要从父进程显式带入 MCP 子进程的代理相关变量（F1-Q2：#3 / 风险 2）。 */
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

/**
 * 一段描述的摘要：只取**第一行**，最多 CACHE_TOOL_DESCRIPTION_MAX_CHARS（160）个字符。
 *
 * 用在两处：运行态里每个工具的描述（FIX-9），以及系统提示词里每个服务器的 meta.description。
 * - 只取第一行：「一句话 + 空行 + 详细说明」的写法只要那句话；
 * - 截断**不追加省略号**：上限就是上限，追加符号会让长度变成 161；
 *   长度按 UTF-16 码元算（与 JavaScript 的 `length` 一致），若切口正好落在代理对中间就把那个字符整字丢掉，
 *   绝不吐半个代理对。
 */
export function clipToolDescription(text: string): string {
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? "";
  const trimmed = firstLine.trim();
  if (trimmed.length <= CACHE_TOOL_DESCRIPTION_MAX_CHARS) return trimmed;
  const clipped = trimmed.slice(0, CACHE_TOOL_DESCRIPTION_MAX_CHARS);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
}

/** 缓存目录相对 hubHome 的位置。 */
export const MCP_DIR_NAME = "mcp";
export const CACHE_FILE_NAME = "cache.json";
