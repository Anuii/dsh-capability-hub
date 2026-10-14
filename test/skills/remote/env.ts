/**
 * D-B18 测试用的模块装配：把 skills-remote 装起来，并把 home / hubHome / 假 fetch 暴露给测试。
 *
 * 与 flow.test.ts 的 buildModule 同源，只是把「来源记录、指纹、设置」这些文件的路径
 * 也一并给出来，方便断言磁盘上真正写了什么。
 */

import * as YAML from "yaml";
import fs from "node:fs/promises";
import path from "node:path";
import { createSkillsRemoteModule } from "../../../src/skills/remote/module.ts";
import { lockFilePath, sourcesFilePath } from "../../../src/skills/remote/lockstore.ts";
import { fingerprintsFilePath, type FingerprintsFile } from "../../../src/skills/remote/fingerprints.ts";
import { settingsFilePath } from "../../../src/skills/remote/settings.ts";
import { makeCtx, makeFakeApi, makeFakeFetch, makeLogger, makeTempDir, withRootPaths } from "./helpers.ts";
import type { FakeApi, FakeFetchRoute, LogRecord } from "./helpers.ts";

export interface RemoteEnv {
  home: string;
  hubHome: string;
  userAgents: string;
  ctx: ReturnType<typeof makeCtx>;
  skills: FakeApi;
  fake: ReturnType<typeof makeFakeFetch>;
  module: ReturnType<typeof createSkillsRemoteModule>;
  sink: LogRecord[];
  lockFile: string;
  sourcesFile: string;
  fingerprintsFile: string;
  settingsFile: string;
  call(key: string, req?: { query?: Record<string, string>; body?: unknown }): Promise<Record<string, unknown>>;
  readLock(): Promise<{ version: number; skills: Record<string, Record<string, unknown>> }>;
  writeLock(skills: Record<string, unknown>, version?: number): Promise<void>;
  readFingerprints(): Promise<FingerprintsFile>;
  readSettings(): Promise<Record<string, unknown>>;
  writeFile(rel: string, content: string): Promise<void>;
}

export interface RemoteEnvOptions {
  routes?: FakeFetchRoute[];
  skills?: NonNullable<Parameters<typeof makeFakeApi>[0]>["skills"];
  rootPaths?: Record<string, string>;
  home?: string;
  hubHome?: string;
  envToken?: string;
  /** 预置的 lock 条目（键 = 技能名） */
  lock?: Record<string, unknown>;
  /** 预置的 fingerprints.json 内容 */
  fingerprints?: Record<string, unknown>;
  /** 预置的 settings.json 内容 */
  settings?: Record<string, unknown>;
}

export async function buildRemoteEnv(options: RemoteEnvOptions = {}): Promise<RemoteEnv> {
  const home = options.home ?? makeTempDir("cap-hub-fp-home-");
  const hubHome = options.hubHome ?? makeTempDir("cap-hub-fp-hub-");
  const userAgents = makeTempDir("cap-hub-fp-agents-");
  const { logger, sink } = makeLogger();
  const ctx = makeCtx({ homeDir: home, hubHome, logger });
  // 回收站放在本环境自己的临时目录里：多个测试文件共用 %TEMP%\.fake-trash 会撞名（EPERM）
  const skills = makeFakeApi({ skills: options.skills ?? [], trashRoot: path.join(hubHome, ".fake-trash") });
  withRootPaths(skills, { "user-agents": userAgents, ...(options.rootPaths ?? {}) });
  const fake = makeFakeFetch(options.routes ?? []);
  const module = createSkillsRemoteModule(
    ctx,
    { skills, yaml: YAML },
    {
      fetchImpl: fake.fetch,
      envTokenProvider: () => options.envToken,
      ghTokenProvider: async () => undefined,
      cacheAuth: false,
    },
  );

  const lockFile = lockFilePath(ctx);
  const fingerprintsFile = fingerprintsFilePath(ctx);
  const settingsFile = settingsFilePath(ctx);
  await fs.mkdir(path.dirname(lockFile), { recursive: true });
  await fs.mkdir(path.join(hubHome, "skills"), { recursive: true });
  if (options.lock !== undefined) {
    await fs.writeFile(lockFile, JSON.stringify({ version: 3, skills: options.lock, dismissed: {} }));
  }
  if (options.fingerprints !== undefined) {
    await fs.writeFile(fingerprintsFile, JSON.stringify({ version: 1, entries: options.fingerprints }));
  }
  if (options.settings !== undefined) {
    await fs.writeFile(settingsFile, JSON.stringify(options.settings));
  }

  const env: RemoteEnv = {
    home,
    hubHome,
    userAgents,
    ctx,
    skills,
    fake,
    module,
    sink,
    lockFile,
    sourcesFile: sourcesFilePath(ctx),
    fingerprintsFile,
    settingsFile,
    async call(key, req = {}) {
      const handler = module.routes[key];
      if (handler === undefined) throw new Error(`路由不存在：${key}`);
      return (await handler({
        query: req.query ?? {},
        body: req.body,
        signal: new AbortController().signal,
      } as never)) as Record<string, unknown>;
    },
    async readLock() {
      return JSON.parse(await fs.readFile(lockFile, "utf8")) as {
        version: number;
        skills: Record<string, Record<string, unknown>>;
      };
    },
    async writeLock(entries, version = 3) {
      await fs.mkdir(path.dirname(lockFile), { recursive: true });
      await fs.writeFile(lockFile, JSON.stringify({ version, skills: entries, dismissed: {} }));
    },
    async readFingerprints() {
      try {
        return JSON.parse(await fs.readFile(fingerprintsFile, "utf8")) as FingerprintsFile;
      } catch {
        return { version: 1, entries: {} };
      }
    },
    async readSettings() {
      try {
        return JSON.parse(await fs.readFile(settingsFile, "utf8")) as Record<string, unknown>;
      } catch {
        return {};
      }
    },
    async writeFile(rel, content) {
      const abs = path.join(hubHome, "skills", rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    },
  };
  return env;
}

/** 一条 lock 条目（npx skills 的形态） */
export function lockEntry(options: {
  repo: string;
  ref?: string;
  skillPath: string;
  hash: string;
  installedAt?: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    source: options.repo,
    sourceType: "github",
    sourceUrl: `https://github.com/${options.repo}.git`,
    skillPath: options.skillPath,
    skillFolderHash: options.hash,
    installedAt: options.installedAt ?? "2026-09-01T00:00:00.000Z",
    updatedAt: options.installedAt ?? "2026-09-01T00:00:00.000Z",
  };
  if (options.ref !== undefined) entry.ref = options.ref;
  return { ...entry, ...(options.extra ?? {}) };
}

/** 该次请求里 url 含某子串的调用 */
export function callsMatching(env: RemoteEnv, needle: string): { url: string; headers: Record<string, string> }[] {
  return env.fake.calls.filter((call) => call.url.includes(needle));
}
