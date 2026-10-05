/**
 * envFrom：在服务器 spawn 的那一刻执行命令取值（D-D8、F3-Q5）。
 *
 * 与参考实现的关键差异：参考实现写死 `spawn('/bin/sh', ['-c', …])`，
 * **在 Windows 上 /bin/sh 根本不存在 ⇒ 每个用 envFrom 的配置 100% 起不来**（F3-Q8）。
 * 这里按平台选 shell：Windows 用 `cmd.exe /d /s /c`，其余平台 `/bin/sh -c`。
 *
 * 六类拒绝（每一条的诊断都只含变量名 / 退出码 / 命令自身 stderr，**绝不含 stdout**）：
 *   1. 命令起不来；2. 超时；3. 非零退出；4. stdout 超 64 KiB；5. 含 NUL 字节；6. 空值且不在 allowEmpty。
 * 任一失败 ⇒ 该服务器拒绝启动（绝不注入空值）。
 */
import { spawn } from 'node:child_process';
import { IS_WINDOWS } from './win-proc-platform.ts';
import { ENV_FROM_DEFAULT_TIMEOUT_MS, ENV_FROM_KILL_GRACE_MS, ENV_FROM_STDERR_LIMIT, ENV_FROM_STDOUT_LIMIT } from '../constants.ts';
import { proxyEnvironment, fallbackDefaultEnvironment } from './sandbox-env.ts';
import { appendCappedBytes, decodeStderrBytes } from './stderr-tail.ts';

export interface EnvFromFailure {
  variable: string;
  /** 中文诊断：只含变量名、退出码、stderr 尾部。 */
  message: string;
}

export interface EnvFromResult {
  values: Record<string, string>;
  failures: EnvFromFailure[];
}

/** 追加并截断：先追加再切，避免单个超大 chunk 冲破上限（F3-Q5 appendCapped）。 */
function appendCapped(current: string, chunk: string, limit: number): string {
  const next = current + chunk;
  return next.length > limit ? next.slice(0, limit) : next;
}

function commandSpec(command: string): { file: string; args: string[] } {
  if (IS_WINDOWS) {
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    return { file: comspec, args: ['/d', '/s', '/c', command] };
  }
  return { file: '/bin/sh', args: ['-c', command] };
}

export interface EnvFromRunner {
  (variable: string, command: string, timeoutMs: number): Promise<{ ok: true; value: string } | { ok: false; message: string }>;
}

/** 真实实现：跑一条命令取它的 stdout。 */
export const runEnvFromCommand: EnvFromRunner = (variable, command, timeoutMs) =>
  new Promise((resolve) => {
    const spec = commandSpec(command);
    let child: ReturnType<typeof spawn> | undefined;
    let stdout = '';
    // FIX-4：stderr 攒**字节**，等命令结束后一次性解码（逐块解码会切断跨块的多字节字符）
    let stderrBytes: Buffer = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: { ok: true; value: string } | { ok: false; message: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const killTree = () => {
      const pid = child?.pid;
      if (!pid) return;
      if (IS_WINDOWS) {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => undefined);
        setTimeout(() => {
          try {
            child?.kill('SIGKILL');
          } catch {
            /* 已经不在了 */
          }
        }, ENV_FROM_KILL_GRACE_MS);
      } else {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            child?.kill('SIGKILL');
          } catch {
            /* 已经不在了 */
          }
        }
      }
    };

    try {
      // detached：自成进程组，超时时可以整组回收（POSIX 语义；Windows 上靠 taskkill /T）。
      child = spawn(spec.file, spec.args, {
        env: { ...fallbackDefaultEnvironment(), ...proxyEnvironment() },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !IS_WINDOWS,
      });
    } catch (err) {
      finish({ ok: false, message: `envFrom: "${variable}" 无法执行 — ${(err as Error).message}` });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      killTree();
      finish({
        ok: false,
        message: `envFrom: "${variable}" 在 ${timeoutMs} ms 内没有结束，已终止 — 可调大该服务器的 envFromTimeoutMs`,
      });
    }, Math.max(1, timeoutMs));
    (timer as { unref?: () => void }).unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendCapped(stdout, String(chunk), ENV_FROM_STDOUT_LIMIT + 1);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = appendCappedBytes(stderrBytes, chunk, ENV_FROM_STDERR_LIMIT);
    });
    child.on('error', (err) => {
      finish({ ok: false, message: `envFrom: "${variable}" 无法执行 — ${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      if (timedOut) return;
      // FIX-4：解码统一走 decodeStderrBytes（严格 UTF-8 → win32 上的 GBK → 非 fatal UTF-8）
      const stderrTail = decodeStderrBytes(stderrBytes).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' — ');
      if (code !== 0) {
        finish({
          ok: false,
          message: `envFrom: "${variable}" 失败（退出码 ${code ?? '未知'}）${stderrTail ? `：${stderrTail}` : ''}`,
        });
        return;
      }
      if (Buffer.byteLength(stdout, 'utf8') > ENV_FROM_STDOUT_LIMIT) {
        // 截断的密钥是**错的**密钥，会在别处以更难读的方式失败 —— 所以是拒绝而不是截断。
        finish({
          ok: false,
          message: `envFrom: "${variable}" 的输出超过 ${ENV_FROM_STDOUT_LIMIT} 字节上限，已拒绝（截断的值是错误的密钥）`,
        });
        return;
      }
      const value = stdout.trim();
      if (value.includes('\0')) {
        // 含 NUL 时 spawn 自己的错误消息会把该值原文带出来，从而泄漏进诊断/模型面前。
        finish({ ok: false, message: `envFrom: "${variable}" 的结果包含 NUL 字节，已拒绝` });
        return;
      }
      finish({ ok: true, value });
    });
  });

export interface ResolveEnvFromOptions {
  envFrom: Record<string, string>;
  allowEmpty: string[];
  timeoutMs?: number;
  runner?: EnvFromRunner;
}

/**
 * 解析全部 envFrom 变量。
 * 并发跑，且**全部结算后**才返回：提前返回会让其它进程组无人收尸（F3-Q5）。
 */
export async function resolveEnvFrom(options: ResolveEnvFromOptions): Promise<EnvFromResult> {
  const variables = Object.keys(options.envFrom);
  const values: Record<string, string> = {};
  const failures: EnvFromFailure[] = [];
  if (variables.length === 0) return { values, failures };

  const runner = options.runner ?? runEnvFromCommand;
  const timeoutMs = options.timeoutMs ?? ENV_FROM_DEFAULT_TIMEOUT_MS;
  const allowEmpty = new Set(options.allowEmpty);

  const settled = await Promise.all(
    variables.map(async (variable) => {
      const command = options.envFrom[variable];
      if (typeof command !== 'string' || command.trim() === '') {
        return { variable, ok: false as const, message: `envFrom: "${variable}" 的命令为空` };
      }
      try {
        const result = await runner(variable, command, timeoutMs);
        if (result.ok === false) return { variable, ok: false as const, message: result.message };
        if (result.value.length === 0 && !allowEmpty.has(variable)) {
          return {
            variable,
            ok: false as const,
            message: `envFrom: "${variable}" 的结果为空；若确实允许空值，请把该变量加入该服务器的 allowEmpty`,
          };
        }
        return { variable, ok: true as const, value: result.value };
      } catch (err) {
        return { variable, ok: false as const, message: `envFrom: "${variable}" 无法执行 — ${(err as Error).message}` };
      }
    }),
  );

  for (const item of settled) {
    if (item.ok) values[item.variable] = item.value;
    else failures.push({ variable: item.variable, message: item.message });
  }
  return { values, failures };
}
