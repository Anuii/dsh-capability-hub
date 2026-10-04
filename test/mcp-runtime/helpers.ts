/**
 * 测试公共脚手架：临时目录、假配置源、构造运行时。
 * **所有测试数据只落 os.tmpdir() 下的自建目录**（任务书 E4 / PLAN §4）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpRuntime } from '../../src/host/mcp-runtime/runtime.ts';
import { FakeClock } from './fakes/fake-clock.ts';
import { FakeMcpRegistry, createFakeSdk, createFakeSupervisor } from './fakes/fake-sdk.ts';
import type { McpRuntimeInternal } from '../../src/host/mcp-runtime/runtime.ts';
import type { EffectiveMcpConfig, EffectiveServer, HubContext, McpConfigSource } from '../../src/host/mcp-runtime/contract.ts';

export interface TempHome {
  dir: string;
  hubHome: string;
  cleanup(): Promise<void>;
}

const created: string[] = [];

export async function makeTempHome(label = 'mcp-runtime'): Promise<TempHome> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-capability-hub-' + label + '-'));
  created.push(dir);
  const hubHome = join(dir, 'storages', 'dsh-capability-hub');
  return {
    dir,
    hubHome,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function cleanupAllTemps(): Promise<void> {
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function makeContext(hubHome: string, workspaceDir: string): HubContext {
  const messages: string[] = [];
  return {
    homeDir: workspaceDir,
    dshHome: join(workspaceDir, '.dsh'),
    hubHome,
    profileName: 'test',
    customSkillDirs: [],
    logger: {
      debug: (...args: unknown[]) => messages.push('debug ' + args.join(' ')),
      info: (...args: unknown[]) => messages.push('info ' + args.join(' ')),
      warn: (...args: unknown[]) => messages.push('warn ' + args.join(' ')),
      error: (...args: unknown[]) => messages.push('error ' + args.join(' ')),
    },
  };
}

/** 假配置源：get() 返回当前快照；set() 触发 onChange。 */
export class FakeConfigSource implements McpConfigSource {
  #config: EffectiveMcpConfig;
  #listeners = new Set<(next: EffectiveMcpConfig, prev: EffectiveMcpConfig) => void>();
  changeCount = 0;

  constructor(servers: EffectiveServer[] = [], settings?: Partial<EffectiveMcpConfig['settings']>) {
    this.#config = {
      settings: {
        idleTimeoutMin: settings?.idleTimeoutMin ?? 10,
        outputGuard: settings?.outputGuard ?? { enabled: true, maxBytes: 51200, maxLines: 2000 },
        failureBackoffMs: settings?.failureBackoffMs ?? 60000,
      },
      servers,
    };
  }

  get(): EffectiveMcpConfig {
    return this.#config;
  }

  onChange(listener: (next: EffectiveMcpConfig, prev: EffectiveMcpConfig) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(config: EffectiveMcpConfig): void {
    const prev = this.#config;
    this.#config = config;
    this.changeCount += 1;
    for (const listener of [...this.#listeners]) listener(config, prev);
  }

  setSettings(settings: Partial<EffectiveMcpConfig['settings']>): void {
    this.set({ settings: { ...this.#config.settings, ...settings }, servers: this.#config.servers });
  }

  setServers(servers: EffectiveServer[]): void {
    this.set({ settings: this.#config.settings, servers });
  }
}

/** 造一个 EffectiveServer（全部字段都有默认值）。 */
export function makeServer(overrides: Partial<EffectiveServer> & { serverName: string }): EffectiveServer {
  return {
    transport: 'stdio',
    args: [],
    env: {},
    envFrom: {},
    allowEmpty: [],
    envFromTimeoutMs: 10_000,
    headers: {},
    toolCallTimeoutMs: 60_000,
    lifecycle: 'lazy',
    idleTimeoutMin: 10,
    searchKeywords: {},
    disabled: false,
    debug: false,
    ...overrides,
  };
}

export interface Harness {
  runtime: McpRuntimeInternal;
  registry: FakeMcpRegistry;
  config: FakeConfigSource;
  clock: FakeClock;
  supervisor: ReturnType<typeof createFakeSupervisor>;
  sdk: ReturnType<typeof createFakeSdk>;
  home: TempHome;
  dispose(): Promise<void>;
}

/**
 * 造一个完整运行时。
 * @param opts.autoStart 是否调用 start()（默认 true，模拟平台层接线后的状态）
 */
export async function makeHarness(opts: {
  servers?: EffectiveServer[];
  settings?: Partial<EffectiveMcpConfig['settings']>;
  behaviors?: Parameters<FakeMcpRegistry['register']>[0][];
  autoStart?: boolean;
  sweepIntervalMs?: number;
  cacheWatchIntervalMs?: number;
} = {}): Promise<Harness> {
  const home = await makeTempHome();
  const ctx = makeContext(home.hubHome, home.dir);
  const registry = new FakeMcpRegistry();
  for (const behavior of opts.behaviors ?? []) registry.register(behavior);
  const sdk = createFakeSdk(registry);
  const supervisor = createFakeSupervisor(registry);
  const clock = new FakeClock();
  const config = new FakeConfigSource(opts.servers ?? [], opts.settings);
  const runtime = createMcpRuntime({
    ctx,
    config,
    sdk,
    clock,
    supervisor,
    sweepIntervalMs: opts.sweepIntervalMs ?? 30_000,
    cacheWatchIntervalMs: opts.cacheWatchIntervalMs ?? 30_000,
  });
  if (opts.autoStart !== false) {
    await runtime.start();
    // start() 会为「缓存缺失」的服务器发起启动探测。等它们落地，
    // 后面的断言才能用「增量」这种确定性写法（否则探测会晚一点点连上，把计数搅乱）。
    await runtime.waitForBackgroundWork();
  }
  return {
    runtime,
    registry,
    config,
    clock,
    supervisor,
    sdk,
    home,
    dispose: async () => {
      await runtime.dispose();
      await home.cleanup();
    },
  };
}

/** 构造一次 execute 调用上下文。 */
export function callCtx(sessionId: string, extra: { parentSessionId?: string; signal?: AbortSignal } = {}) {
  return {
    sessionId,
    ...(extra.parentSessionId !== undefined ? { parentSessionId: extra.parentSessionId } : {}),
    signal: extra.signal ?? new AbortController().signal,
  };
}

export function toolBehavior(key: string, tools: Array<{ name: string; description?: string; inputSchema?: unknown }>) {
  return { key, tools };
}
