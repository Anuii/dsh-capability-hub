/**
 * 子进程监管：进程存活查询 + 进程树终止。
 *
 * 为什么必须有这一层（F1-Q2、F3-Q8、D-D5）：
 * @modelcontextprotocol/client v2 的 StdioClientTransport.close() 只对 this._process 一个 pid
 * 发 SIGTERM→SIGKILL，没有任何 taskkill /T 或进程组逻辑。Windows 下 .cmd 会被 cross-spawn
 * 包成 cmd.exe /d /s /c "…"（npx.cmd 就是这种），被杀的只是 cmd.exe，
 * 真正的 node 服务器可能作为孤儿存活。所以关闭时必须自己收整棵树。
 */
import { execFile } from "node:child_process";
import { IS_WINDOWS, parseTasklistCsv } from "./win-proc.ts";
import { KILL_WAIT_MS } from "../constants.ts";
import type { Clock } from "./clock.ts";

export interface ProcessSupervisor {
  /** pid 是否仍然存在。 */
  isAlive(pid: number): Promise<boolean>;
  /** 终止整棵进程树（含孙进程）。 */
  killTree(pid: number, opts?: { graceMs?: number }): Promise<void>;
}

function runExec(
  file: string,
  args: string[],
  opts: { timeout: number; cwd?: string; env?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = execFile(
        file,
        args,
        {
          windowsHide: true,
          timeout: opts.timeout,
          maxBuffer: 8 * 1024 * 1024,
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts.env !== undefined ? { env: opts.env } : {}),
        },
        (err, stdout, stderr) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
          done({ code, stdout: String(stdout), stderr: String(stderr) });
        },
      );
      child.on("error", (err) => done({ code: -1, stdout: "", stderr: String(err.message) }));
    } catch (err) {
      done({ code: -1, stdout: "", stderr: String((err as Error).message) });
    }
  });
}

/** 真实监管器。 */
export function createProcessSupervisor(clock: Clock): ProcessSupervisor {
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const handle = clock.setTimer(resolve, ms);
      void handle;
    });

  async function isAlive(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (IS_WINDOWS) {
      const res = await runExec("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { timeout: 10_000 });
      return parseTasklistCsv(res.stdout).some((row) => row.pid === pid);
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as { code?: string }).code === "EPERM";
    }
  }

  async function killTree(pid: number, opts: { graceMs?: number } = {}): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (IS_WINDOWS) {
      // /T 连子孙一起杀，/F 强制。先把树杀掉，再按 pid 确认是否真的消失。
      await runExec("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 15_000 });
    } else {
      // POSIX：进程组（detached 时 pid 即组长）。杀不到再退化到单进程。
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* 已经不在了 */
        }
      }
      await sleep(opts.graceMs ?? 500);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* 已经不在了 */
        }
      }
    }
    const deadline = Date.now() + (opts.graceMs ?? KILL_WAIT_MS);
    while (Date.now() < deadline) {
      if (!(await isAlive(pid))) return;
      await sleep(100);
    }
  }

  return { isAlive, killTree };
}
