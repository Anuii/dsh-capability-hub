/**
 * 假 SDK：内存版的 Client / StdioClientTransport / StreamableHTTPClientTransport。
 *
 * 形状严格对着 @modelcontextprotocol/client v2 的实际用法（F1-Q2/Q3）：
 *   new Client({name,version}, opts) → client.connect(transport) → transport.pid
 *   client.listTools(undefined, { cacheMode: 'refresh' }) / client.getInstructions() / client.callTool(params, opts)
 *   client.onclose / client.close() / transport.stderr（'pipe' 时可读）
 *
 * 它能控制：连接延迟 / 连接失败 / 工具清单 / 调用延迟 / 调用失败 / 崩溃 /
 * 超大输出 / stderr 文本 —— 覆盖单测要验的所有分支。
 */
import { EventEmitter } from 'node:events';
import { sleep } from './fake-clock.ts';

export interface FakeToolSpec {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface FakeCallResult {
  content?: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface FakeServerBehavior {
  /** 匹配键：command + ' ' + args.join(' ')。 */
  key: string;
  tools?: FakeToolSpec[];
  instructions?: string;
  connectDelayMs?: number;
  connectFailure?: string;
  listDelayMs?: number;
  listFailure?: string;
  callDelayMs?: number;
  callFailure?: string;
  /** 调用后进程"崩溃"：onclose 触发，后续调用失败。 */
  crashOnCall?: boolean;
  callResults?: Record<string, FakeCallResult>;
  stderrText?: string;
  /** 关闭时永不返回（验证关闭超时兜底）。 */
  hangOnClose?: boolean;
}

export interface FakeProcess {
  pid: number;
  behavior: FakeServerBehavior;
  alive: boolean;
  children: FakeProcess[];
  spawnArgs: { command: string; args: string[]; env: Record<string, string>; cwd?: string; stderr?: string };
}

export class FakeMcpRegistry {
  behaviors = new Map<string, FakeServerBehavior>();
  processes = new Map<number, FakeProcess>();
  spawned: FakeProcess[] = [];
  transportEnv: Array<Record<string, string>> = [];
  transportCwd: Array<string | undefined> = [];
  transportStderrMode: Array<string | undefined> = [];
  connectCalls = 0;
  closeCalls = 0;
  listCalls = 0;
  callCalls: Array<{ name: string; args: unknown; timeout?: number; hadSignal: boolean }> = [];
  #nextPid = 40_000;

  register(behavior: FakeServerBehavior): void {
    this.behaviors.set(behavior.key, behavior);
  }

  static key(command: string, args: string[]): string {
    return command + ' ' + args.join(' ');
  }

  startProcess(behavior: FakeServerBehavior, spawnArgs: FakeProcess['spawnArgs']): FakeProcess {
    this.#nextPid += 1;
    const proc: FakeProcess = { pid: this.#nextPid, behavior, alive: true, children: [], spawnArgs };
    this.processes.set(proc.pid, proc);
    this.spawned.push(proc);
    return proc;
  }

  /** 模拟 taskkill /T：连子孙一起杀。 */
  killTree(pid: number): void {
    const proc = this.processes.get(pid);
    if (!proc) return;
    proc.alive = false;
    for (const child of proc.children) this.killTree(child.pid);
  }

  liveProcessCount(): number {
    return [...this.processes.values()].filter((proc) => proc.alive).length;
  }
}

class FakeTransport {
  pid: number | undefined;
  stderr: EventEmitter | null = null;
  #behavior: FakeServerBehavior;
  #registry: FakeMcpRegistry;
  #process: FakeProcess | undefined;
  #options: Record<string, unknown>;

  constructor(options: Record<string, unknown>, registry: FakeMcpRegistry, behaviorKey: string) {
    this.#options = options;
    this.#registry = registry;
    this.stderr = options.stderr === 'pipe' ? new EventEmitter() : null;
    const behavior = registry.behaviors.get(behaviorKey);
    if (!behavior) throw new Error('假 SDK：没有为该命令注册行为 — ' + behaviorKey);
    this.#behavior = behavior;
  }

  get behavior(): FakeServerBehavior {
    return this.#behavior;
  }

  get process(): FakeProcess | undefined {
    return this.#process;
  }

  async start(): Promise<void> {
    // 真实服务器是「先写 stderr，再失败退出」，所以这里先吐 stderr 再抛错。
    const early = this.#behavior.stderrText;
    if (early && this.stderr) this.stderr.emit('data', Buffer.from(early, 'utf8'));
    if (this.#behavior.connectDelayMs) await sleep(this.#behavior.connectDelayMs);
    // 只读一次：测试里的失败注入用 getter（每读一次就推进「第几次连接」的序号），
    // 读两次会把序号吃掉，于是「第 2 次失败」变成「第 2 次读出失败、第 3 次读出 undefined」。
    const connectFailure = this.#behavior.connectFailure;
    if (connectFailure) throw new Error(connectFailure);
    const proc = this.#registry.startProcess(this.#behavior, {
      command: String(this.#options.command ?? ''),
      args: Array.isArray(this.#options.args) ? (this.#options.args as string[]) : [],
      env: (this.#options.env ?? {}) as Record<string, string>,
      ...(this.#options.cwd !== undefined ? { cwd: String(this.#options.cwd) } : {}),
      ...(this.#options.stderr !== undefined ? { stderr: String(this.#options.stderr) } : {}),
    });
    this.#process = proc;
    this.pid = proc.pid;
  }

  async close(): Promise<void> {
    if (this.#behavior.hangOnClose) return new Promise<void>(() => undefined);
    // 真实 SDK 只杀直接子进程；孙进程靠调用方的进程树终止兜底。
    if (this.#process) this.#process.alive = false;
  }
}

export class FakeStdioClientTransport extends FakeTransport {
  constructor(options: Record<string, unknown>, registry: FakeMcpRegistry) {
    super(options, registry, FakeMcpRegistry.key(String(options.command ?? ''), (options.args as string[]) ?? []));
    registry.transportEnv.push((options.env ?? {}) as Record<string, string>);
    registry.transportCwd.push(options.cwd === undefined ? undefined : String(options.cwd));
    registry.transportStderrMode.push(options.stderr === undefined ? undefined : String(options.stderr));
  }
}

export class FakeStreamableHttpClientTransport extends FakeTransport {
  constructor(url: URL, options: Record<string, unknown>, registry: FakeMcpRegistry) {
    super({ command: url.toString(), args: [] }, registry, FakeMcpRegistry.key(url.toString(), []));
    registry.transportEnv.push({});
  }
}

class FakeClient {
  #registry: FakeMcpRegistry;
  #transport: FakeTransport | undefined;
  #closed = false;
  onclose: (() => void) | undefined;

  constructor(_info: unknown, _options: unknown, registry: FakeMcpRegistry) {
    this.#registry = registry;
  }

  async connect(transport: FakeTransport): Promise<void> {
    this.#registry.connectCalls += 1;
    this.#transport = transport;
    await transport.start();
  }

  getInstructions(): string | undefined {
    return this.#transport?.behavior.instructions;
  }

  async listTools(_params: unknown, options?: { cacheMode?: string }): Promise<{ tools: FakeToolSpec[] }> {
    this.#registry.listCalls += 1;
    const behavior = this.#transport?.behavior;
    if (!behavior) throw new Error('假 SDK：尚未连接');
    if (options?.cacheMode !== 'refresh') throw new Error('假 SDK：listTools 必须以 cacheMode: refresh 调用');
    if (behavior.listDelayMs) await sleep(behavior.listDelayMs);
    const listFailure = behavior.listFailure;
    if (listFailure) throw new Error(listFailure);
    return { tools: behavior.tools ?? [] };
  }

  async callTool(params: { name: string; arguments?: unknown }, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown> {
    const behavior = this.#transport?.behavior;
    if (!behavior) throw new Error('假 SDK：尚未连接');
    this.#registry.callCalls.push({
      name: params.name,
      args: params.arguments,
      ...(options?.timeout !== undefined ? { timeout: options.timeout } : {}),
      hadSignal: options?.signal !== undefined,
    });
    if (options?.signal?.aborted) {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    if (behavior.callDelayMs) await sleep(behavior.callDelayMs);
    if (behavior.crashOnCall) {
      this.#closed = true;
      const transport = this.#transport;
      if (transport?.process) transport.process.alive = false;
      this.onclose?.();
      throw new Error('Connection closed');
    }
    const callFailure = behavior.callFailure;
    if (callFailure) throw new Error(callFailure);
    const custom = behavior.callResults?.[params.name];
    if (custom) return custom;
    return { content: [{ type: 'text', text: 'fake:' + params.name }] };
  }

  async close(): Promise<void> {
    this.#registry.closeCalls += 1;
    this.#closed = true;
    await this.#transport?.close();
  }

  get closed(): boolean {
    return this.#closed;
  }
}

export interface FakeSdk {
  Client: unknown;
  StdioClientTransport: unknown;
  StreamableHTTPClientTransport: unknown;
  getDefaultEnvironment: () => Record<string, string>;
}

export function createFakeSdk(registry: FakeMcpRegistry): FakeSdk {
  class BoundClient extends FakeClient {
    constructor(info: unknown, options: unknown) {
      super(info, options, registry);
    }
  }
  class BoundStdio extends FakeStdioClientTransport {
    constructor(options: Record<string, unknown>) {
      super(options, registry);
    }
  }
  class BoundHttp extends FakeStreamableHttpClientTransport {
    constructor(url: URL, options: Record<string, unknown>) {
      super(url, options, registry);
    }
  }
  return {
    Client: BoundClient,
    StdioClientTransport: BoundStdio,
    StreamableHTTPClientTransport: BoundHttp,
    getDefaultEnvironment: () => ({ PATH: process.env.PATH ?? '', USERPROFILE: process.env.USERPROFILE ?? '' }),
  };
}

export interface FakeSupervisor {
  killedPids: number[];
  isAlive(pid: number): Promise<boolean>;
  killTree(pid: number, opts?: { graceMs?: number }): Promise<void>;
}

export function createFakeSupervisor(registry: FakeMcpRegistry): FakeSupervisor {
  const killedPids: number[] = [];
  return {
    killedPids,
    async isAlive(pid: number) {
      return registry.processes.get(pid)?.alive === true;
    },
    async killTree(pid: number) {
      killedPids.push(pid);
      registry.killTree(pid);
    },
  };
}
