/**
 * 走查 / 截图脚本共用的会话守卫（纯 Node，**只读**会话存储：绝不写、绝不删）。
 *
 * 为什么要它：DSH 网页端加载时读 localStorage 的 `dsh.sessions.current` —— 指向的会话存在且
 * **非空白**（日志里出现过 `turn/start` 事件）就只打开它；没有记录 / 会话已不存在 / 指向空白会话时，
 * 会退回「最近使用的工作区」复用那里的空白会话，没有可复用的就**新建一个**。测试 profile 与桌面版
 * 共用同一份会话存储，新建的会话会出现在使用者真实的会话列表里（AGENTS.md 硬规则 3）。
 *
 * 会话存储布局：<DSH_HOME 或 ~/.dsh>/sessions/<工作区目录名>/<session-…>/session.v4.jsonl.zstd
 * （JSONL，**多帧** zstd 压缩；第一帧的头是 {"type":"session","version":4,…,"delegationDepth":0,…}）。
 *
 * 本模块的键一律用 "/" 连接「工作区目录名」与「会话目录名」，与磁盘上的路径分隔符无关。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** 会话日志文件名（DSH v4 存储）。 */
export const SESSION_FILE = "session.v4.jsonl.zstd";
/** 会话目录名前缀。 */
export const SESSION_DIR_PREFIX = "session-";
/** 默认「多久没动过才算安全」：30 分钟（避开正在使用的会话）。 */
export const DEFAULT_MIN_IDLE_MS = 30 * 60 * 1000;
/** 打印时保留的会话 id 十六进制位数。 */
const SESSION_ID_HEAD = 8;
/** 打印时工作区目录名保留的头 / 尾字符数（中间是被替换掉的绝对路径）。 */
const WORKSPACE_HEAD = 4;
const WORKSPACE_TAIL = 7;
/** zstd 帧魔数：28 B5 2F FD。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 会话存储的根目录：<DSH_HOME 或 ~/.dsh>/sessions。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function sessionsRoot(env = process.env) {
  return join(env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
}

/**
 * 列出存储里的会话目录（键 = "<工作区目录名>/<会话目录名>"，目录名 = 会话 id）。
 * 目录不存在、读不动都当成空。
 *
 * @param {string} root
 * @returns {Array<{ key: string, dir: string }>}
 */
function listSessionDirs(root) {
  /** @type {Array<{ key: string, dir: string }>} */
  const out = [];
  let workspaces;
  try {
    workspaces = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(root, workspace.name);
    let entries;
    try {
      entries = readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(SESSION_DIR_PREFIX)) continue;
      out.push({ key: workspace.name + "/" + entry.name, dir: join(workspaceDir, entry.name) });
    }
  }
  return out;
}

/**
 * 当前所有 <工作区目录>/<session-…> 的集合；目录不存在返回空集。
 *
 * @param {string} root
 * @returns {Set<string>}
 */
export function snapshotSessions(root) {
  return new Set(listSessionDirs(root).map((entry) => entry.key));
}

/**
 * after 里有、before 里没有的键（按 after 的列举顺序）。
 *
 * @param {Set<string>} before
 * @param {Set<string>} after
 * @returns {string[]}
 */
export function newSessions(before, after) {
  return [...after].filter((key) => !before.has(key));
}

/** 保留头尾、中间换成「…」；短名字原样返回。 */
function shorten(name, head, tail) {
  if (name.length <= head + tail + 1) return name;
  return name.slice(0, head) + "…" + name.slice(-tail);
}

/**
 * 打印用：会话 id 只留前 8 位十六进制加「…」，工作区目录名也只留头尾（它编码了绝对路径）。
 * 完整 id / 完整路径永远不打印（AGENTS.md 硬规则 6）。
 *
 * @param {string} key
 * @returns {string}
 */
export function redactSession(key) {
  const parts = String(key)
    .split(/[\\/]/)
    .filter((part) => part !== "");
  const name = parts.pop() ?? "";
  const workspace = parts.join("/");
  const prefix = name.startsWith(SESSION_DIR_PREFIX) ? SESSION_DIR_PREFIX : "";
  const body = name.slice(prefix.length);
  const id = prefix + body.slice(0, SESSION_ID_HEAD) + "…";
  if (workspace === "") return id;
  return shorten(workspace, WORKSPACE_HEAD, WORKSPACE_TAIL) + "\\" + id;
}

/**
 * 解出会话日志的全部文本。
 *
 * DSH 的 session.v4.jsonl.zstd 是**多个 zstd 帧首尾相接**（每追加一批事件写一帧，一个真实会话可能上百帧），
 * 而 zstdDecompressSync 与 createZstdDecompress 流都**只解第一帧**（于是只剩会话头，turn/start 全看不见）。
 * 所以按魔数找出每个帧的起点，对每个起点单独解（它解完这一帧就停），再把各帧文本按顺序拼起来；
 * 某个起点解不动就跳过（魔数字节可能只是恰好出现在压缩数据里）。
 *
 * @param {string} file
 * @returns {string} 全部帧的文本；一帧都解不出时是空串
 */
function readSessionText(file) {
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return "";
  }
  let text = "";
  let at = buffer.indexOf(ZSTD_MAGIC);
  while (at !== -1) {
    try {
      const part = zstdDecompressSync(buffer.subarray(at)).toString("utf8");
      // 帧尾通常带换行；万一没有，补一个，免得两帧的行粘成一条坏 JSON。
      if (text !== "" && !text.endsWith("\n") && part !== "") text += "\n";
      text += part;
    } catch {
      // 不是真帧，跳过
    }
    at = buffer.indexOf(ZSTD_MAGIC, at + 1);
  }
  return text;
}

/**
 * 这个会话能不能安全地当初始视图：头是 session、delegationDepth 为 0、日志里出现过 turn/start。
 * 解压或头解析失败一律当不能用。
 *
 * @param {string} file
 * @returns {boolean}
 */
function isReusableSession(file) {
  const text = readSessionText(file);
  if (text === "") return false;
  const lines = text.split("\n");
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return false;
  }
  if (header === null || typeof header !== "object") return false;
  if (header.type !== "session") return false;
  if ((header.delegationDepth ?? 0) !== 0) return false;
  for (const line of lines) {
    // 快筛：turn/start 才把会话从「空白」翻成「非空白」，空白会话会被网页端丢弃并新建。
    if (!line.includes("turn/start")) continue;
    try {
      if (JSON.parse(line).type === "turn/start") return true;
    } catch {
      // 坏行不可能是一条事件，跳过
    }
  }
  return false;
}

/**
 * 挑一个可以安全打开的已有会话 id：头 type=session、delegationDepth=0、日志里有 turn/start、
 * 文件最后修改时间早于 now - minIdleMs（避开正在使用的会话）。按修改时间从新到旧取第一个，
 * 解压 / 解析失败的跳过；没有候选返回 undefined。
 *
 * @param {string} root
 * @param {{ now?: number, minIdleMs?: number }} [options]
 * @returns {string | undefined}
 */
export function pickViewTarget(root, options = {}) {
  const { now = Date.now(), minIdleMs = DEFAULT_MIN_IDLE_MS } = options;
  const cutoff = now - minIdleMs;
  /** @type {Array<{ key: string, mtimeMs: number, file: string }>} */
  const candidates = [];
  for (const entry of listSessionDirs(root)) {
    const file = join(entry.dir, SESSION_FILE);
    let info;
    try {
      info = statSync(file);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    if (info.mtimeMs >= cutoff) continue;
    candidates.push({ key: entry.key, mtimeMs: info.mtimeMs, file });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates) {
    if (!isReusableSession(candidate.file)) continue;
    return candidate.key.slice(candidate.key.lastIndexOf("/") + 1);
  }
  return undefined;
}

/**
 * 注入到页面里的一段 JS：把当前会话指到指定会话上，网页端加载时就不会新建。
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function selectionSeedScript(sessionId) {
  return (
    "try { localStorage.setItem(" +
    JSON.stringify("dsh.sessions.current") +
    ", JSON.stringify({ sessionId: " +
    JSON.stringify(sessionId) +
    " })) } catch {}"
  );
}
