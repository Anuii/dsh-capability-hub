/**
 * 截图脚本：kit 预览面板 + 外壳（Edge headless + CDP）。
 *
 * 用法（包根）：
 *   node scripts\ui-shot-kit.mjs
 *   ... --out <仓库根>\.dev\shots\ui0
 *
 * 产物（全部落在 --out）：
 *   ui0-01-kit-light.png         kit 预览（亮色，抽屉关闭）
 *   ui0-02-kit-dark.png          kit 预览（暗色，抽屉关闭）
 *   ui0-03-kit-hover.png         kit 预览：真鼠标悬停在「有更新」那一行上
 *   ui0-04-kit-drawer-light.png  kit 预览：抽屉打开（亮色）
 *   ui0-05-kit-drawer-dark.png   kit 预览：抽屉打开（暗色）
 *   ui0-06-shell-light.png       外壳（亮色，技能标签）
 *   ui0-07-shell-dark.png        外壳（暗色）
 *   ui0-08-diagnostics.png       「ⓘ」打开的诊断模态框
 *   ui0-facts.json               每一步的 DOM 事实（含主题变量是否真的切换了）
 *
 * 为什么自己写一份而不是改 ui-shot.mjs：ui-shot.mjs 采集的是页面 DOM 事实，
 * 这里要的是「审美审查」用的多主题 / 悬停截图，两边的关注点不同，分开更好维护。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EDGE = process.env.DSH_EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
if (!existsSync(EDGE)) throw new Error("找不到 Edge：用 $env:DSH_EDGE 指定 msedge.exe 的路径。");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = packageRoot; // .dev/ 在仓库根下（被 .gitignore 忽略）
const outLog = join(repoRoot, ".dev", "logs", "dev-profile.out.log");

function argOf(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
}

const port = Number(argOf("--port", "19411"));
const outDir = resolve(argOf("--out", join(repoRoot, ".dev", "shots", "ui0")));
// 调试端口默认按进程号取一个，避免上一轮残留的无头 Edge 还占着固定端口。
const debugPort = Number(argOf("--debug-port", "0")) || 9200 + (process.pid % 500);
const token = /token=([A-Za-z0-9_\-]+)/.exec(readFileSync(outLog, "utf8"))[1];
mkdirSync(outDir, { recursive: true });
const profileDir = join(repoRoot, ".dev", "tmp", "edge-profile-ui0");
mkdirSync(profileDir, { recursive: true });

// 上一次没退干净的 Edge 会占着调试端口 / 锁住 user-data-dir，表现是 CDP 调用永远不返回。
try {
  const probe = await fetch("http://127.0.0.1:" + String(debugPort) + "/json/version", {
    signal: AbortSignal.timeout(1200),
  });
  if (probe.ok)
    throw new Error(
      "调试端口 " +
        debugPort +
        " 已被占用：先收掉残留的无头 Edge（taskkill /IM msedge.exe /F 只在必要时用），或换 --debug-port。",
    );
} catch (error) {
  if (error instanceof Error && error.message.startsWith("调试端口")) throw error;
}

const edge = spawn(
  EDGE,
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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + debugPort + "/json/list")).json();
      const page = list.find((entry) => entry.type === "page");
      if (page !== undefined) return page;
    } catch {
      /* 调试端口还没起来 */
    }
    await sleep(300);
  }
  throw new Error("Edge 调试端口 " + debugPort + " 没起来");
}

const page = await findPage();
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

function send(method, params = {}, timeoutMs = 20000) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      fail(new Error("CDP 调用超时：" + method + "（多半是上一个无头 Edge 没退干净，占着 " + debugPort + " 端口）"));
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
}

/**
 * 收掉整棵 Edge 进程树。
 *
 * 只靠 spawn 的 pid 不够（headless Edge 会再起子进程，父进程甚至可能先退），
 * 所以再按调试端口的占用者补一刀 —— **只杀占用本脚本那个端口的进程**，
 * 绝不按镜像名批量杀（那会连用户自己开着的 Edge 一起干掉）。
 */
function killEdge() {
  try {
    if (edge.pid !== undefined)
      execFileSync("taskkill.exe", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* 已经退了就算了 */
  }
  try {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$c = Get-NetTCPConnection -LocalPort " +
          debugPort +
          " -State Listen -ErrorAction SilentlyContinue; " +
          "foreach ($x in $c) { taskkill.exe /PID $x.OwningProcess /T /F 2>$null | Out-Null }",
      ],
      { stdio: "ignore" },
    );
  } catch {
    /* 端口已经空了 */
  }
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails !== undefined)
    throw new Error("页面脚本异常：" + JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

/** 文件名后缀（--suffix v2 → ui0-01-kit-light-v2.png），用于对照打磨前后的截图。 */
const suffix = argOf("--suffix", "");

async function shot(name) {
  const result = await send("Page.captureScreenshot", { format: "png" });
  const file = join(outDir, suffix === "" ? name : name.replace(/\.png$/, "-" + suffix + ".png"));
  writeFileSync(file, Buffer.from(result.data, "base64"));
  console.log("shot: " + file);
  return file;
}

/**
 * 打开带查询串的页面并等它稳定；onboarding 模态框会先关掉。
 *
 * 注意：带 token 的那次请求会 303 到 "./"，**查询串会被丢掉**（实测 location: ./）。
 * 所以先用 token 换一次 cookie，之后所有导航都用不带 token 的普通 URL + 查询串。
 */
async function open(query) {
  loaded = false;
  const base = "http://127.0.0.1:" + String(port) + "/";
  await send("Page.navigate", { url: base + "?token=" + token + query });
  for (let i = 0; i < 80 && !loaded; i++) await sleep(250);
  await sleep(1200);
  if (!(await evaluate("location.search.includes('hubKit') || location.search === ''")) || true) {
    loaded = false;
    await send("Page.navigate", { url: base + (query === "" ? "" : "?" + query.replace(/^&/, "")) });
    for (let i = 0; i < 80 && !loaded; i++) await sleep(250);
  }
  for (let i = 0; i < 80 && !loaded; i++) await sleep(250);
  await sleep(2500);
  await evaluate(
    "(() => { const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '继续'); if (b) b.click(); return true; })()",
  );
  await sleep(700);
}

async function openHub() {
  const clicked = await evaluate(
    "(() => { const icon = document.querySelector('[data-dsh-panel-entry=capability-hub]'); if (!icon) return false; const b = icon.closest('button'); (b ?? icon).click(); return true; })()",
  );
  await sleep(1500);
  return clicked;
}

/** 真·鼠标悬停（:hover 只有真的派发鼠标事件才会触发）。 */
async function hover(selector) {
  const box = await evaluate(
    "(() => { const n = document.querySelector(" +
      JSON.stringify(selector) +
      "); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()",
  );
  if (box === null) return false;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, buttons: 0 });
  await sleep(350);
  return true;
}

async function setDark(dark) {
  await evaluate(
    "(() => { const b = document.body; if (" +
      String(dark) +
      ") b.setAttribute('data-ds-dark-theme',''); else b.removeAttribute('data-ds-dark-theme'); return true; })()",
  );
  await sleep(450);
}

const FACTS = {};
const themeProbe = "getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim()";

await send("Page.enable");
await send("Runtime.enable");
/** 预览面板很长（工具栏 + 两个分组 + 空状态 + 骨架屏），用自己的高度一次拍全；外壳用 1100。 */
async function viewport(height) {
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height, deviceScaleFactor: 1, mobile: false });
}
const PREVIEW_HEIGHT = 1700;
const SHELL_HEIGHT = 1100;
await viewport(PREVIEW_HEIGHT);

// ---- 1. kit 预览（亮色，抽屉关闭）------------------------------------------
await open("&hubKitPreview=1&hubKitDrawer=1");
FACTS.previewEntryClicked = await openHub();
FACTS.previewPresent = await evaluate("!!document.querySelector('[data-testid=hub-kit-preview]')");
FACTS.previewRows = await evaluate("document.querySelectorAll('[data-testid=hub-kit-preview] [role=button]').length");
FACTS.drawerClosedAtStart = await evaluate("!document.querySelector('[data-testid=kit-drawer]')");
await setDark(false);
FACTS.lightBgBase = await evaluate(themeProbe);
await shot("ui0-01-kit-light.png");

// ---- 2. 暗色 ---------------------------------------------------------------
await setDark(true);
FACTS.darkBgBase = await evaluate(themeProbe);
await shot("ui0-02-kit-dark.png");
await setDark(false);

// ---- 3. 悬停态 -------------------------------------------------------------
FACTS.hovered = await hover("[data-testid=kit-row-2]");
FACTS.hoverActionsVisible = await evaluate(
  "(() => { const n = document.querySelector('[data-testid=kit-row-2] [data-testid=kit-row-2-check]'); if (!n) return null; return getComputedStyle(n.parentElement).opacity; })()",
);
FACTS.hoverChevronVisible = await evaluate(
  "(() => { const row = document.querySelector('[data-testid=kit-row-2]'); const chip = row && row.lastElementChild; return chip ? getComputedStyle(chip).opacity : null; })()",
);
await shot("ui0-03-kit-hover.png");

// ---- 4. 抽屉（亮色 / 暗色）-------------------------------------------------
await viewport(SHELL_HEIGHT);
await evaluate(
  "(() => { const n = document.querySelector('[data-testid=kit-row-1]'); n.focus(); n.click(); return true; })()",
);
await sleep(500);
FACTS.drawerOpen = await evaluate("!!document.querySelector('[data-testid=kit-drawer]')");
FACTS.drawerFocusInside = await evaluate(
  "(() => { const d = document.querySelector('[data-testid=kit-drawer]'); return d ? d.contains(document.activeElement) : null; })()",
);
FACTS.drawerWidth = await evaluate(
  "(() => { const d = document.querySelector('[data-testid=kit-drawer]'); return d ? Math.round(d.getBoundingClientRect().width) : null; })()",
);
await shot("ui0-04-kit-drawer-light.png");
await setDark(true);
await shot("ui0-05-kit-drawer-dark.png");
await setDark(false);

// Esc 关闭 + 焦点归还
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(400);
FACTS.drawerClosedByEscape = await evaluate("!document.querySelector('[data-testid=kit-drawer]')");
FACTS.focusReturnedToRow = await evaluate(
  "(() => { const n = document.activeElement; return n ? (n.getAttribute('data-testid') || n.tagName) : null; })()",
);

// ---- 5. 外壳（真实标签页）--------------------------------------------------
await open("");
FACTS.hubEntryClicked = await openHub();
FACTS.headerTitle = await evaluate(
  "(() => { const h = document.querySelector('[data-testid=capability-hub-page] h2'); return h ? h.textContent : null; })()",
);
FACTS.subtitleGone = await evaluate(
  "(() => { const p = document.querySelector('[data-testid=capability-hub-page] header p'); return p === null; })()",
);
FACTS.envCardNotOnPage = await evaluate("document.querySelector('[data-testid=capability-hub-env]') === null");
FACTS.degradedBannerVisible = await evaluate("!!document.querySelector('[data-testid=capability-hub-degraded]')");
FACTS.tabsMounted = await evaluate(
  "JSON.stringify(['skills','mcp'].map((id) => !!document.querySelector('[data-testid=capability-hub-panel-' + id + ']')))",
);
await shot("ui0-06-shell-light.png");
// 降级横幅：正常情况下它**不在**页面上；把 dev profile 的 devOverrides.failureDemo 打开后
// 再跑一次这个脚本，就会多出一张 ui0-09-degraded-banner.png（见 docs\DEV.md 第 10 节）。
if (FACTS.degradedBannerVisible) {
  FACTS.degradedBannerText = await evaluate(
    "(() => { const n = document.querySelector('[data-testid=capability-hub-degraded]'); return n ? n.innerText : null; })()",
  );
  await shot("ui0-09-degraded-banner.png");
  // 横幅上的「查看详情」打开的是同一个诊断模态框。
  FACTS.degradedDetailsClicked = await evaluate(
    "(() => { const n = document.querySelector('[data-testid=capability-hub-degraded-details]'); if (!n) return false; n.click(); return true; })()",
  );
  await sleep(700);
  FACTS.degradedDetailsOpenedModal = await evaluate("!!document.querySelector('[data-testid=capability-hub-env]')");
  await shot("ui0-10-degraded-details.png");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(400);
}
await setDark(true);
await shot("ui0-07-shell-dark.png");
await setDark(false);

// ---- 6. 诊断模态框 ---------------------------------------------------------
FACTS.infoClicked = await evaluate(
  "(() => { const n = document.querySelector('[data-testid=capability-hub-info]'); if (!n) return false; n.click(); return true; })()",
);
await sleep(700);
FACTS.envInModal = await evaluate("!!document.querySelector('[data-testid=capability-hub-env]')");
FACTS.envText = await evaluate(
  "(() => { const n = document.querySelector('[data-testid=capability-hub-env]'); return n ? n.innerText : null; })()",
);
await shot("ui0-08-diagnostics.png");

FACTS.console = consoleLines.filter((line) => line.includes("capability-hub")).slice(0, 20);
writeFileSync(
  join(outDir, suffix === "" ? "ui0-facts.json" : "ui0-facts-" + suffix + ".json"),
  JSON.stringify(FACTS, null, 2),
  "utf8",
);
console.log(JSON.stringify(FACTS, null, 2));

socket.close();
killEdge();
