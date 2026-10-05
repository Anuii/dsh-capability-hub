/**
 * mcp-runtime 常量。取值来源：PLAN §3.5/§3.6、DECISIONS D-D5..D-D8、.research/facts/F3（mcp-lazy 行为规格）。
 * 只放常量，不 import 任何东西。
 */

/** 代理工具名（D-D1：全局只注册这一个工具）。 */
export const PROXY_TOOL_NAME = "mcp";

/** search 默认/最大条数（F3-Q1 SEARCH_DEFAULT_LIMIT / SEARCH_MAX_LIMIT）。 */
export const SEARCH_DEFAULT_LIMIT = 12;
export const SEARCH_MAX_LIMIT = 40;

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

/** 正则搜索的长度上限与是否允许嵌套量词（F3-Q4）。 */
export const MAX_REGEX_QUERY_LENGTH = 256;

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

/** 工具描述恒定前缀（D-D1：描述 = 恒定前缀 + 已启用服务器名，不写工具数量）。 */
export const DESCRIPTION_PREFIX =
  "MCP 服务器统一网关。它把本机配置的所有 MCP 服务器合成一个工具：" +
  "用 { search } 在本地工具缓存里检索工具，用 { describe } 查看某个工具的完整参数，" +
  "用 { tool, args } 真正调用它，用 { connect } 显式连接某个服务器并刷新它的工具清单，" +
  "用 { instructions } 查看某个服务器自带的用法说明，不带任何参数则返回运行状态。" +
  "search 与 describe 只读本地缓存、不启动任何进程；只有真正调用某个工具时才会启动它所属的服务器，并在空闲后自动回收。";

/** 没有任何已启用服务器时的固定文案。 */
export const DESCRIPTION_NO_SERVERS = "当前没有已启用的 MCP 服务器。";

/** 已启用服务器的描述后缀模板。 */
export function describeEnabledServers(names: string[]): string {
  if (names.length === 0) return DESCRIPTION_NO_SERVERS;
  return `已启用的 MCP 服务器（按配置顺序）：${names.join("，")}。`;
}

/** 缓存目录相对 hubHome 的位置。 */
export const MCP_DIR_NAME = "mcp";
export const CACHE_FILE_NAME = "cache.json";
export const SPILL_DIR_NAME = "spill";
