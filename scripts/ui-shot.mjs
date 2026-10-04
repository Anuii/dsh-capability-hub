/**
 * dsh-capability-hub 的页面截图/取 DOM 证据脚本（Edge headless + CDP）。
 *
 * 为什么需要它：DSH 的 GUI 不能裸访问 —— 每个进程随机 launch token，先 GET
 * /?token=<token> 换到 browser-auth cookie，之后同源请求才被接受。无头浏览器带
 * cookie 打开页面即可拿到真实渲染结果。
 *
 * 用法（在包根）：
 *   node scripts\ui-shot.mjs
 *   ... --port 19411 --out <目录> --keep-open
 *
 * 做四件事：
 *   1. 从 .dev\logs\dev-profile.out.log 解析 token；
 *   2. 用 Edge headless + 远程调试端口打开带 token 的 URL（自动 303 落 cookie）；
 *   3. 点开侧栏「能力中心」→ 依次切三个标签，每步存一张 PNG；
 *   4. 收集 DOM 事实（标签文本、data-testid 存在性、诊断卡片折叠/展开两态文本）写成 facts.json。
 *      诊断信息默认折叠，脚本会先点开再读它的 innerText。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EDGE = process.env.DSH_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (!existsSync(EDGE)) throw new Error("找不到 Edge：用 $env:DSH_EDGE 指定 msedge.exe 的路径。");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..");
const logDir = join(repoRoot, ".dev", "logs");
const outLog = join(logDir, "dev-profile.out.log");

function argOf(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
}

const port = Number(argOf("--port", "19411"));
const outDir = resolve(argOf("--out", join(repoRoot, ".dev", "shots")));
const debugPort = Number(argOf("--debug-port", "9333"));
const keepOpen = process.argv.includes("--keep-open");

const text = readFileSync(outLog, "utf8");
const match = /token=([A-Za-z0-9_\-]+)/.exec(text);
if (match === null) throw new Error("日志里没有 token=... 行：" + outLog);
const token = match[1];
mkdirSync(outDir, { recursive: true });

const profileDir = join(repoRoot, ".dev", "tmp", "edge-profile");
mkdirSync(profileDir, { recursive: true });

const edge = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--user-data-dir=" + profileDir,
  "--remote-debugging-port=" + String(debugPort),
  "--window-size=1440,960",
  "about:blank",
], { stdio: "ignore", detached: false });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch("http://127.0.0.1:" + debugPort + "/json/list");
      const list = await response.json();
      const page = list.find((entry) => entry.type === "page");
      if (page !== undefined) return page;
    } catch {
      /* 调试端口还没起来 */
    }
    await sleep(300);
  }
  throw new Error("Edge 调试端口 " + debugPort + " 没起来");
}

const page = await targets();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((done, fail) => {
  socket.addEventListener("open", done, { once: true });
  socket.addEventListener("error", fail, { once: true });
});

let nextId = 1;
const pending = new Map();
let loaded = false;
const consoleLines = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === "Runtime.consoleAPICalled") {
    const text = (message.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    consoleLines.push(message.params.type + ": " + text);
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error !== undefined) entry.fail(new Error(JSON.stringify(message.error)));
    else entry.done(message.result);
    return;
  }
  if (message.method === "Page.loadEventFired") loaded = true;
});

function send(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((done, fail) => pending.set(id, { done, fail }));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails !== undefined) throw new Error("页面脚本异常：" + JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function shot(name) {
  const result = await send("Page.captureScreenshot", { format: "png" });
  const file = join(outDir, name);
  writeFileSync(file, Buffer.from(result.data, "base64"));
  console.log("shot: " + file);
  return file;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
const url = "http://127.0.0.1:" + String(port) + "/?token=" + token;
await send("Page.navigate", { url });
for (let i = 0; i < 60 && !loaded; i++) await sleep(250);
await sleep(2500);

const facts = {};

// DSH 首次加载会弹「预览版说明」模态框，挡住页面；先关掉它。
facts.dismissedOnboarding = await evaluate(
  "(() => { const nodes = [...document.querySelectorAll('button')]; const hit = nodes.find((n) => (n.innerText || '').trim() === '继续'); if (!hit) return false; hit.click(); return true; })()",
);
await sleep(800);

facts.title = await evaluate("document.title");
facts.bootLoaded = await evaluate("!!globalThis.__DSH_BOOT__");
facts.hubInBoot = await evaluate("JSON.stringify(globalThis.__DSH_BOOT__ ?? {}).includes(\"dsh-capability-hub\")");

// 1. 点开侧栏的「能力中心」行
facts.sidebarEntryFound = await evaluate(
  "(() => { const icon = document.querySelector('[data-dsh-panel-entry=capability-hub]'); if (!icon) return false; const button = icon.closest('button'); if (button) button.click(); else icon.click(); return true; })()",
);
await sleep(1200);
facts.pagePresent = await evaluate("!!document.querySelector('[data-testid=capability-hub-page]')");
await shot("01-page.png");

// 2. 依次切三个标签
facts.tabs = await evaluate("JSON.stringify([...document.querySelectorAll('[role=tab]')].map((node) => node.textContent))");
for (const tab of ["skills", "mcp", "runtime"]) {
  facts["clicked-" + tab] = await evaluate(
    "(() => { const node = document.querySelector('[data-testid=capability-hub-tab-" + tab + "]'); if (!node) return false; node.click(); return true; })()",
  );
  await sleep(400);
  facts["activeTab-" + tab] = await evaluate(
    "(() => { const node = document.querySelector('[data-testid=capability-hub-tab-" + tab + "]'); return node ? node.getAttribute('aria-selected') : null; })()",
  );
  // 三个标签是同时挂载的（切换只改 hidden），所以「存在」恒为真 ——
  // 判断可见性要看 hidden 属性。
  facts["panel-" + tab] = await evaluate(
    "(() => { const node = document.querySelector('[data-testid=capability-hub-panel-" + tab + "]'); return node ? !node.hidden : false; })()",
  );
  facts["panelMounted-" + tab] = await evaluate("!!document.querySelector('[data-testid=capability-hub-panel-" + tab + "]')");
  await shot("02-tab-" + tab + ".png");
}

// 3. 停回技能标签再截一张整页
await evaluate("document.querySelector('[data-testid=capability-hub-tab-skills]')?.click()");
await sleep(300);

// 4. （可选）新建一个会话，再看「当前工作区」（useCurrentWorkspace 的来源是会话列表快照里的 cwd）
// 【调度者 2026-10-04】默认不再新建会话：dev profile 与 desktop 共用 ~/.dsh 的会话存储，
// 每跑一次就会在用户真实的会话列表里多一个会话。确实需要时显式传 --new-session。
const wantNewSession = process.argv.includes("--new-session");
facts.newSessionClicked = wantNewSession
  ? await evaluate(
      "(() => { const nodes = [...document.querySelectorAll('button')]; const hit = nodes.find((n) => (n.getAttribute('aria-label') || '') === '新建会话'); if (!hit) return false; hit.click(); return true; })()",
    )
  : "skipped (pass --new-session to enable)";
if (wantNewSession) await sleep(3000);
// 新建会话后 main slot 切到了会话视图，重新点回「能力中心」再读环境卡片。
await evaluate(
  "(() => { const icon = document.querySelector('[data-dsh-panel-entry=capability-hub]'); const button = icon && icon.closest('button'); (button ?? icon)?.click(); return true; })()",
);
await sleep(1500);
facts.clientDiagnostics = await evaluate(
  "(globalThis.__dshCapabilityHubDiagnostics ? JSON.stringify(globalThis.__dshCapabilityHubDiagnostics()) : 'hook missing')",
);
facts.console = consoleLines.filter((line) => line.includes("capability-hub")).slice(0, 20);
// 诊断信息不是页面上的常驻卡片：它只在「ⓘ」模态框里存在。
// 顺序：先确认页面上没有它 → 截「没有诊断卡片」的整页 → 点 ⓘ → 再读它的 innerText → Esc 关掉。
facts.headerTitle = await evaluate(
  "(() => { const node = document.querySelector('[data-testid=capability-hub-page] h2'); return node ? node.textContent : null; })()",
);
facts.subtitleRemoved = await evaluate(
  "document.querySelector('[data-testid=capability-hub-page] header p') === null",
);
facts.envCardOnPage = await evaluate("document.querySelector('[data-testid=capability-hub-env]') !== null");
facts.degradedBannerOnPage = await evaluate("!!document.querySelector('[data-testid=capability-hub-degraded]')");
await shot("03-workspace.png");
facts.infoButtonClicked = await evaluate(
  "(() => { const node = document.querySelector('[data-testid=capability-hub-info]'); if (!node) return false; node.click(); return true; })()",
);
await sleep(700);
facts.envInModal = await evaluate("!!document.querySelector('[data-testid=capability-hub-env]')");
facts.envCardTextAfterNewSession = await evaluate(
  "(() => { const node = document.querySelector('[data-testid=capability-hub-env]'); return node ? node.innerText : null; })()",
);
await shot("04-env-expanded.png");
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(500);
facts.envCardGoneAfterClose = await evaluate("document.querySelector('[data-testid=capability-hub-env]') === null");

writeFileSync(join(outDir, "facts.json"), JSON.stringify(facts, null, 2), "utf8");
console.log(JSON.stringify(facts, null, 2));

socket.close();
if (!keepOpen) edge.kill();
