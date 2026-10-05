/**
 * MCP 配置的持久化（PLAN §3.5 存储段、D-C1）。
 *
 * - 位置：<hubHome>/mcp/config.json（所有 profile 共用一份）。
 * - 原子写：同目录临时文件 + rename。
 * - 并发容忍：写前比较 mtime，被外部改过先重新加载再把本次变更应用到最新数据上。
 * - 外部修改检测：轮询 mtime（间隔可注入，默认 2000ms），重新加载并触发 onChange。
 * - 损坏恢复：原文件改名备份为 config.json.corrupt-<时间戳>，以空配置启动并记录 warning。
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { emptyRawConfig, toEffectiveConfig } from "./schema.ts";
import type { RawMcpConfigFile } from "./types.ts";
import type { EffectiveMcpConfig, McpConfigSource } from "../contract/config.ts";
import type { HubLogger } from "../../platform/contract/host.ts";

export interface McpStore extends McpConfigSource {
  /** 配置文件绝对路径 */
  readonly path: string;
  /** 加载过程中产生的问题（例如文件损坏），可直接展示给用户 */
  readonly warnings: string[];
  /** 落盘形态（只含非默认字段）+ 显式设置字段集合，供界面使用 */
  getRaw(): RawMcpConfigFile;
  /**
   * 应用一次变更：先用最新磁盘内容刷新，再把 mutator 作用到最新数据上，原子写回。
   * mutator 里抛错 = 放弃本次写入（用于重名冲突、校验失败等）。
   * 返回值 = mutator 的返回值。
   */
  save<T>(mutator: (draft: RawMcpConfigFile) => T): Promise<T>;
  /** 等待首次加载完成 */
  ready(): Promise<void>;
  /** 强制重新加载（测试用） */
  reload(): Promise<void>;
  /** 停止轮询并清空监听器 */
  dispose(): void;
}

export interface McpStoreOptions {
  /** 外部修改轮询间隔（毫秒），默认 2000；<=0 表示不轮询 */
  pollIntervalMs?: number;
  /** 时间源（可注入，测试用） */
  now?: () => Date;
}

function timestamp(date: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    String(date.getFullYear()) +
    p(date.getMonth() + 1) +
    p(date.getDate()) +
    "-" +
    p(date.getHours()) +
    p(date.getMinutes()) +
    p(date.getSeconds()) +
    "-" +
    p(date.getMilliseconds(), 3)
  );
}

/** 缺省 logger（模块可独立测试）。 */
export function silentLogger(): HubLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

export function createMcpStore(hubHome: string, logger: HubLogger, opts: McpStoreOptions = {}): McpStore {
  const dir = join(hubHome, "mcp");
  const filePath = join(dir, "config.json");
  const pollIntervalMs = opts.pollIntervalMs === undefined ? 2000 : opts.pollIntervalMs;
  const now = opts.now ?? (() => new Date());

  let raw: RawMcpConfigFile = emptyRawConfig();
  let effective: EffectiveMcpConfig = toEffectiveConfig(raw);
  let mtimeMs: number | undefined;
  let warnings: string[] = [];
  let listeners: ((next: EffectiveMcpConfig, prev: EffectiveMcpConfig) => void)[] = [];
  let timer: NodeJS.Timeout | undefined;
  /** 串行化写操作，避免并发 save 互相覆盖 */
  let queue: Promise<unknown> = Promise.resolve();

  async function statMtime(): Promise<number | undefined> {
    try {
      const st = await fs.stat(filePath);
      return st.mtimeMs;
    } catch {
      return undefined;
    }
  }

  async function readFileRaw(): Promise<{ raw: RawMcpConfigFile; mtime?: number; warnings: string[] }> {
    const notes: string[] = [];
    let text: string;
    let mtime: number | undefined;
    try {
      const st = await fs.stat(filePath);
      mtime = st.mtimeMs;
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { raw: emptyRawConfig(), mtime: undefined, warnings: notes };
      notes.push("读取 MCP 配置文件失败：" + (error as Error).message + "，已按空配置启动。");
      return { raw: emptyRawConfig(), mtime: undefined, warnings: notes };
    }
    if (text.trim() === "") return { raw: emptyRawConfig(), mtime, warnings: notes };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const backup = filePath + ".corrupt-" + timestamp(now());
      try {
        await fs.rename(filePath, backup);
        notes.push(
          "MCP 配置文件不是合法 JSON（" + (error as Error).message + "），已备份为 " + backup + "，本次以空配置启动。",
        );
      } catch (renameError) {
        notes.push(
          "MCP 配置文件不是合法 JSON（" +
            (error as Error).message +
            "），备份失败：" +
            (renameError as Error).message +
            "，本次以空配置启动。",
        );
      }
      return { raw: emptyRawConfig(), mtime: undefined, warnings: notes };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      notes.push("MCP 配置文件结构异常（顶层必须是对象），已忽略其内容并以空配置启动。");
      return { raw: emptyRawConfig(), mtime, warnings: notes };
    }
    const record = parsed as Record<string, unknown>;
    const rawServers = Array.isArray(record.servers) ? record.servers : [];
    const settings =
      record.settings && typeof record.settings === "object" && !Array.isArray(record.settings)
        ? (record.settings as RawMcpConfigFile["settings"])
        : {};
    return {
      raw: {
        version: 1,
        settings,
        servers: rawServers.filter(
          (s) => s !== null && typeof s === "object" && !Array.isArray(s),
        ) as RawMcpConfigFile["servers"],
      },
      mtime,
      warnings: notes,
    };
  }

  /** 只在「生效配置」真的变化时通知（顺序、启停、字段值都算变化）。 */
  function emit(next: EffectiveMcpConfig, prev: EffectiveMcpConfig): void {
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    for (const listener of [...listeners]) {
      try {
        listener(next, prev);
      } catch (error) {
        logger.error("MCP 配置变更监听器抛错", error);
      }
    }
  }

  async function reloadInternal(): Promise<void> {
    const loaded = await readFileRaw();
    applyLoaded(loaded);
  }

  function applyLoaded(loaded: { raw: RawMcpConfigFile; mtime?: number; warnings: string[] }): boolean {
    const nextEffective = toEffectiveConfig(loaded.raw);
    const prev = effective;
    const changed = JSON.stringify(loaded.raw) !== JSON.stringify(raw);
    raw = loaded.raw;
    mtimeMs = loaded.mtime;
    effective = nextEffective;
    warnings = loaded.warnings;
    if (loaded.warnings.length > 0) {
      for (const w of loaded.warnings) logger.warn("mcp-config: " + w);
    }
    emit(nextEffective, prev);
    return changed;
  }

  /**
   * 写入前对齐磁盘状态。
   *
   * 只比 mtime 是不够的：Windows 的文件时间按系统时钟刻度刷新（约 15.6ms），
   * 同一刻度内的外部写入会得到相同的 mtime，从而被漏掉。配置很小，直接按内容比对。
   */
  async function refreshBeforeWrite(): Promise<void> {
    const loaded = await readFileRaw();
    if (JSON.stringify(loaded.raw) === JSON.stringify(raw)) {
      mtimeMs = loaded.mtime;
      warnings = loaded.warnings;
      return;
    }
    logger.debug("mcp-config: 写入前发现外部修改，先重新加载再应用本次变更");
    applyLoaded(loaded);
  }

  async function writeRaw(next: RawMcpConfigFile): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const tmp = join(dir, ".config.json.tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 10));
    const text = JSON.stringify(next, null, 2) + "\n";
    await fs.writeFile(tmp, text, "utf8");
    try {
      await fs.rename(tmp, filePath);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
    mtimeMs = await statMtime();
  }

  // 首次加载（异步进行；调用方用 ready() 等待，或直接用后续的 onChange 事件）
  let initialized = false;
  const initPromise = (async () => {
    const loaded = await readFileRaw();
    const nextEffective = toEffectiveConfig(loaded.raw);
    const prev = effective;
    raw = loaded.raw;
    mtimeMs = loaded.mtime;
    effective = nextEffective;
    warnings = loaded.warnings;
    initialized = true;
    for (const w of loaded.warnings) logger.warn("mcp-config: " + w);
    emit(nextEffective, prev);
  })();

  if (pollIntervalMs > 0) {
    timer = setInterval(() => {
      void (async () => {
        const current = await statMtime();
        if (current === mtimeMs) return;
        logger.debug("mcp-config: 检测到外部修改，重新加载配置");
        await reloadInternal();
      })().catch((error) => logger.error("mcp-config: 轮询外部修改失败", error));
    }, pollIntervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  return {
    path: filePath,
    get warnings() {
      return warnings;
    },
    /** 等待首次加载完成（路由与外部调用方都先 await 它）。 */
    ready: async () => {
      await initPromise;
      if (!initialized) await initPromise;
    },
    get: () => effective,
    getRaw: () => raw,
    onChange(listener) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    async save<T>(mutator: (draft: RawMcpConfigFile) => T): Promise<T> {
      const run = async (): Promise<T> => {
        await initPromise;
        // 1) 写前合并：磁盘被外部改过就先重新加载，再基于最新数据应用本次变更
        await refreshBeforeWrite();
        const draft: RawMcpConfigFile = JSON.parse(JSON.stringify(raw)) as RawMcpConfigFile;
        const result = mutator(draft);
        const prev = effective;
        await writeRaw(draft);
        raw = draft;
        effective = toEffectiveConfig(raw);
        emit(effective, prev);
        return result;
      };
      const chained = queue.then(run, run);
      queue = chained.catch(() => undefined);
      return await chained;
    },
    async reload() {
      await reloadInternal();
    },
    dispose() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      listeners = [];
    },
  };
}

export { dirname };
