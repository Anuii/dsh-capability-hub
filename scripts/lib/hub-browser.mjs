/**
 * 走查脚本共用：起一个无头 Edge（CDP），登录测试 profile 的网页界面，打开能力中心。
 *
 *   const hub = await launchHubBrowser({ port: 19411 });
 *   await hub.open(""); await hub.openHub();
 *   await hub.clickTestId("capability-hub-tab-mcp");
 *   ...
 *   hub.close();
 *
 * 不新建会话（AGENTS.md 硬规则 3）：起 Edge 之后、第一次 Page.navigate 之前，先挑一个已存在的
 * 非空白会话，用 Page.addScriptToEvaluateOnNewDocument 把 localStorage 的 `dsh.sessions.current`
 * 指到它上面；找不到就抛错停下。close() / newSessions() 比较走查前后的会话存储，
 * 一旦多出会话就打印 [FAIL] 并把退出码置为 1（会话存储与桌面版共用，需人工确认后删除）。
 *
 * 退出时只收掉本脚本起的那一棵 Edge（按 pid 与调试端口，绝不按镜像名）。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  newSessions as diffSessions,
  pickViewTarget,
  redactSession,
  selectionSeedScript,
  sessionsRoot,
  snapshotSessions,
} from "./session-guard.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * 从启动日志里等一个 token（最多 timeoutMs，每 250ms 重试一次）。
 * 日志还不存在、或此刻正好被清空/重写，都当作「还没好」继续等。
 */
async function waitForToken(outLog, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const match = /token=([A-Za-z0-9_\-]+)/.exec(readFileSync(outLog, "utf8"));
      if (match !== null) return match[1];
    } catch {
      // 日志还没写出来
    }
    if (Date.now() >= until) {
      throw new Error(
        "启动日志里 " +
          timeoutMs / 1000 +
          " 秒内没有出现 token=…：测试 profile 可能没起来（先跑 scripts\\dev-profile.ps1 start，再看 .dev\\logs\\dev-profile.err.log）。",
      );
    }
    await sleep(250);
  }
}

export async function launchHubBrowser(options = {}) {
  const edgePath = process.env.DSH_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  if (!existsSync(edgePath)) throw new Error("找不到 Edge：用 $env:DSH_EDGE 指定 msedge.exe 的路径。");
  const port = options.port ?? 19411;
  const debugPort = options.debugPort ?? 9200 + (process.pid % 500);
  const outLog = join(repoRoot, ".dev", "logs", "dev-profile.out.log");
  // DSH 的令牌是每进程随机、启动几秒后才写进日志：刚 restart 就跑走查会读到空日志。
  // 这里最多等 15 秒（跑起来那次只需几百毫秒），而不是立刻抛「Cannot read properties of null」。
  const token = await waitForToken(outLog, 15_000);
  const profileDir = join(repoRoot, ".dev", "tmp", "edge-profile-" + (options.name ?? "walk"));
  mkdirSync(profileDir, { recursive: true });

  const edge = spawn(
    edgePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--user-data-dir=" + profileDir,
      "--remote-debugging-port=" + String(debugPort),
      "--window-size=1440,1100",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const killEdge = () => {
    try {
      if (edge.pid !== undefined)
        execFileSync("taskkill.exe", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // 已经退了
    }
    try {
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "$c = Get-NetTCPConnection -LocalPort " +
            debugPort +
            " -State Listen -ErrorAction SilentlyContinue; foreach ($x in $c) { taskkill.exe /PID $x.OwningProcess /T /F 2>$null | Out-Null }",
        ],
        { stdio: "ignore" },
      );
    } catch {
      // 端口已经空了
    }
  };
  process.on("exit", killEdge);

  let target;
  for (let i = 0; i < 60 && target === undefined; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + debugPort + "/json/list")).json();
      target = list.find((entry) => entry.type === "page");
    } catch {
      // 调试端口还没起来
    }
    if (target === undefined) await sleep(300);
  }
  if (target === undefined) throw new Error("Edge 调试端口 " + debugPort + " 没起来");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });

  let nextId = 1;
  let loaded = false;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) entry.fail(new Error(JSON.stringify(message.error)));
      else entry.done(message.result);
      return;
    }
    if (message.method === "Page.loadEventFired") loaded = true;
  });
  const send = (method, params = {}, timeoutMs = 20000) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error("CDP 调用超时：" + method));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        done: (value) => {
          clearTimeout(timer);
          done(value);
        },
        fail: (error) => {
          clearTimeout(timer);
          fail(error);
        },
      });
    });
  };
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails !== undefined)
      throw new Error("页面脚本异常：" + JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  // 第一次 Page.navigate 之前：记下当前会话，挑一个能安全打开的，把它种进页面的 localStorage。
  // 网页端加载时读到 `dsh.sessions.current` 指向的会话存在且非空白，就只打开它、不新建。
  const sessionsDir = sessionsRoot();
  const before = snapshotSessions(sessionsDir);
  const viewSessionId = pickViewTarget(sessionsDir);
  if (viewSessionId === undefined) {
    throw new Error("找不到可作为初始视图的已有会话：为了不新建会话，走查停止。");
  }
  await send("Page.addScriptToEvaluateOnNewDocument", { source: selectionSeedScript(viewSessionId) });

  const base = "http://127.0.0.1:" + String(port) + "/";
  const hub = {
    send,
    evaluate,
    /** 先用 token 换 cookie，再打开不带 token 的地址（带 token 的请求会 303 并丢掉查询串）。 */
    async open(query = "") {
      for (const url of [base + "?token=" + token, base + (query === "" ? "" : "?" + query.replace(/^[&?]/, ""))]) {
        loaded = false;
        await send("Page.navigate", { url });
        for (let i = 0; i < 80 && !loaded; i++) await sleep(250);
      }
      await sleep(2500);
      await hub.clickText("继续", "body");
      await sleep(500);
    },
    async openHub() {
      const clicked = await evaluate(
        "(() => { const icon = document.querySelector('[data-dsh-panel-entry=capability-hub]'); if (!icon) return false; (icon.closest('button') ?? icon).click(); return true; })()",
      );
      await sleep(1500);
      return clicked;
    },
    clickTestId: (id) =>
      evaluate(
        "(() => { const n = document.querySelector('[data-testid=" +
          JSON.stringify(id) +
          "]'); if (!n) return false; n.click(); return true; })()",
      ),
    clickText: (text, within = "[data-testid=capability-hub-page]") =>
      evaluate(
        "(() => { const root = document.querySelector(" +
          JSON.stringify(within) +
          ") || document; const hit = [...root.querySelectorAll('button, [role=button], [role=menuitem], [role=switch]')].find((n) => (n.innerText || n.textContent || '').trim().startsWith(" +
          JSON.stringify(text) +
          ")); if (!hit) return false; hit.click(); return true; })()",
      ),
    /** 给受控输入框写值（走原生 setter + input 事件，React 才收得到）。 */
    setInput: (id, value) =>
      evaluate(
        "(() => { const n = document.querySelector('[data-testid=" +
          JSON.stringify(id) +
          "]'); if (!n) return false; const proto = n.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(n, " +
          JSON.stringify(value) +
          "); n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()",
      ),
    exists: (selector) => evaluate("document.querySelector(" + JSON.stringify(selector) + ") !== null"),
    bodyText: () => evaluate("document.body.innerText"),
    /** 等页面脚本表达式为真；超时返回 false。 */
    async waitFor(expression, timeoutMs = 8000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        if (await evaluate("Boolean(" + expression + ")")) return true;
        await sleep(200);
      }
      return false;
    },
    async shot(file) {
      const result = await send("Page.captureScreenshot", { format: "png" }, 60000);
      writeFileSync(file, Buffer.from(result.data, "base64"));
      return file;
    },
    /** 走查开始之后新出现的会话键（只比较，不关闭）。 */
    newSessions: () => diffSessions(before, snapshotSessions(sessionsDir)),
    close() {
      const created = diffSessions(before, snapshotSessions(sessionsDir));
      if (created.length > 0) {
        console.error(
          "[FAIL] 走查期间出现了 " +
            created.length +
            " 个新会话：" +
            created.map((key) => redactSession(key)).join("、") +
            "（请人工确认后删除）",
        );
        process.exitCode = 1;
      }
      try {
        socket.close();
      } catch {
        // 已经断了
      }
      killEdge();
      return created;
    },
  };
  return hub;
}
