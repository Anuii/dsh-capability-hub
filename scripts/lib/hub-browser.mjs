/**
 * 走查脚本共用：起一个无头 Edge（CDP），登录测试 profile 的网页界面，打开能力中心。
 *
 *   const hub = await launchHubBrowser({ port: 19411 });
 *   await hub.open(""); await hub.openHub();
 *   await hub.clickTestId("capability-hub-tab-mcp");
 *   ...
 *   hub.close();
 *
 * 不新建会话（AGENTS.md 硬规则 3）。退出时只收掉本脚本起的那一棵 Edge（按 pid 与调试端口，绝不按镜像名）。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export async function launchHubBrowser(options = {}) {
  const edgePath = process.env.DSH_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  if (!existsSync(edgePath)) throw new Error("找不到 Edge：用 $env:DSH_EDGE 指定 msedge.exe 的路径。");
  const port = options.port ?? 19411;
  const debugPort = options.debugPort ?? 9200 + (process.pid % 500);
  const outLog = join(repoRoot, ".dev", "logs", "dev-profile.out.log");
  const token = /token=([A-Za-z0-9_\-]+)/.exec(readFileSync(outLog, "utf8"))[1];
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
      if (edge.pid !== undefined) execFileSync("taskkill.exe", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
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
    if (result.exceptionDetails !== undefined) throw new Error("页面脚本异常：" + JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

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
      evaluate("(() => { const n = document.querySelector('[data-testid=" + JSON.stringify(id) + "]'); if (!n) return false; n.click(); return true; })()"),
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
    close() {
      try {
        socket.close();
      } catch {
        // 已经断了
      }
      killEdge();
    },
  };
  return hub;
}
