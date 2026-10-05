/**
 * 截图脚本：真实页面的「审美验收」截图（Edge headless + CDP），对应 docs/UI-DESIGN.md 第 5 节。
 *
 * 用法（包根，测试 profile 在跑）：
 *   node scripts\ui-shot-pages.mjs
 *   ... --out <仓库根>\.dev\shots\pages --suffix v2
 *
 * 产物（亮色 / 暗色各一张）：
 *   p01/p02  技能标签（默认折叠状态）
 *   p03/p04  技能标签：展开 DSH 内置、悬停一行
 *   p05/p06  「添加技能」仓库视图
 *   p07/p08  MCP 标签（滚到底，含「运行中」区域的真实空状态）
 *   p09/p10  MCP 标签，?hubPreviewRunning=1 的示例实例（预览数据，不新建会话）
 *   p11/p12  MCP 服务器详情抽屉
 *   p13/p14  仓库视图：展开仓库列表、勾选两项（底部出现安装区）
 *   p15      仓库视图：skills.sh 搜索结果（固定高度滚动框；会联网）
 *   p17      技能页「已启用」筛选下折叠用户级里的第一个来源仓库（筛选中也能折叠）
 *   p16      仓库视图：从搜索结果「浏览」某个仓库后（结果出现在输入区下方并自动滚到可见）
 *   pages-facts.json  每一步的 DOM 事实（标签、彩色元素统计、每行可见控件数）
 *
 * 不新建会话：会话存储与桌面版共用（AGENTS.md 硬规则 3）。
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
const outDir = resolve(argOf("--out", join(repoRoot, ".dev", "shots", "pages")));
// 调试端口默认按进程号取一个，避免上一轮残留的无头 Edge 还占着固定端口。
const debugPort = Number(argOf("--debug-port", "0")) || 9200 + (process.pid % 500);
const token = /token=([A-Za-z0-9_\-]+)/.exec(readFileSync(outLog, "utf8"))[1];
mkdirSync(outDir, { recursive: true });
const profileDir = join(repoRoot, ".dev", "tmp", "edge-profile-pages");
mkdirSync(profileDir, { recursive: true });

// 上一次没退干净的 Edge 会占着调试端口 / 锁住 user-data-dir，表现是 CDP 调用永远不返回。
try {
  const probe = await fetch("http://127.0.0.1:" + String(debugPort) + "/json/version", { signal: AbortSignal.timeout(1200) });
  if (probe.ok) throw new Error("调试端口 " + debugPort + " 已被占用：先收掉残留的无头 Edge（taskkill /IM msedge.exe /F 只在必要时用），或换 --debug-port。");
} catch (error) {
  if (error instanceof Error && error.message.startsWith("调试端口")) throw error;
}

const edge = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--user-data-dir=" + profileDir,
  "--remote-debugging-port=" + String(debugPort),
  "--window-size=1440,1100",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:" + debugPort + "/json/list")).json();
      const page = list.find((entry) => entry.type === "page");
      if (page !== undefined) return page;
    } catch { /* 调试端口还没起来 */ }
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
      done: (value) => { clearTimeout(timer); done(value); },
      fail: (error) => { clearTimeout(timer); fail(error); },
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
    if (edge.pid !== undefined) execFileSync("taskkill.exe", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" });
  } catch { /* 已经退了就算了 */ }
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command",
      "$c = Get-NetTCPConnection -LocalPort " + debugPort + " -State Listen -ErrorAction SilentlyContinue; " +
      "foreach ($x in $c) { taskkill.exe /PID $x.OwningProcess /T /F 2>$null | Out-Null }",
    ], { stdio: "ignore" });
  } catch { /* 端口已经空了 */ }
}

// 脚本中途抛错也要收掉无头 Edge（只收本脚本起的那一棵）。
process.on("exit", () => killEdge());

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails !== undefined) throw new Error("页面脚本异常：" + JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

/** 文件名后缀（--suffix v2 → p01-skills-light-v2.png），用于对照打磨前后的截图。 */
const suffix = argOf("--suffix", "");

async function shot(name) {
  const result = await send("Page.captureScreenshot", { format: "png" }, 60000);
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
  await evaluate("(() => { const b = [...document.querySelectorAll('button')].find((n) => (n.innerText || '').trim() === '继续'); if (b) b.click(); return true; })()");
  await sleep(700);
}

async function openHub() {
  const clicked = await evaluate("(() => { const icon = document.querySelector('[data-dsh-panel-entry=capability-hub]'); if (!icon) return false; const b = icon.closest('button'); (b ?? icon).click(); return true; })()");
  await sleep(1500);
  return clicked;
}

/** 真·鼠标悬停（:hover 只有真的派发鼠标事件才会触发）。 */
async function hover(selector) {
  const box = await evaluate("(() => { const n = document.querySelector(" + JSON.stringify(selector) + "); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
  if (box === null) return false;
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, buttons: 0 });
  await sleep(350);
  return true;
}

async function setDark(dark) {
  await evaluate("(() => { const b = document.body; if (" + String(dark) + ") b.setAttribute('data-ds-dark-theme',''); else b.removeAttribute('data-ds-dark-theme'); return true; })()");
  await sleep(450);
}


const FACTS = {};
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

/** 按可见文字点一个按钮 / 可点元素（在能力中心页面内）。 */
async function clickText(text, within = "[data-testid=capability-hub-page]") {
  return evaluate("(() => { const root = document.querySelector(" + JSON.stringify(within) + ") || document; " +
    "const nodes = [...root.querySelectorAll('button, [role=button], [role=tab], [role=menuitem], [role=option], summary')]; " +
    "const hit = nodes.find((n) => (n.innerText || n.textContent || '').trim().startsWith(" + JSON.stringify(text) + ")); " +
    "if (!hit) return false; hit.scrollIntoView({ block: 'center' }); hit.click(); return true; })()");
}

async function clickTestId(id) {
  return evaluate("(() => { const n = document.querySelector('[data-testid=" + id + "]'); if (!n) return false; n.click(); return true; })()");
}

async function escape() {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(450);
}

/** 两种主题各拍一张。 */
async function pair(prefix, label) {
  await setDark(false);
  await shot(prefix + "-" + label + "-light.png");
  await setDark(true);
  await shot(String(Number(prefix.slice(1)) + 1).padStart(2, "0").replace(/^/, "p") + "-" + label + "-dark.png");
  await setDark(false);
}

/**
 * UI-DESIGN 第 5 节的可自动核对部分：
 *  - 可见面板里每个「行」（role=button 的列表行）未悬停时可见的交互控件数；
 *  - 可见面板里带非中性色（饱和度高）的文字 / 边框 / 背景元素数（截图里人工再看一遍）。
 */
const AUDIT = `(() => {
  const page = document.querySelector('[data-testid=capability-hub-page]');
  if (!page) return null;
  const visible = (n) => { const s = getComputedStyle(n); const r = n.getBoundingClientRect(); return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05 && r.width > 0 && r.height > 0; };
  const shown = (n) => { for (let x = n; x && x !== page; x = x.parentElement) { if (x.hidden || !visible(x)) return false; } return true; };
  const rows = [...page.querySelectorAll('[role=button]')].filter((n) => shown(n) && n.getBoundingClientRect().height >= 40 && n.closest('[role=dialog]') === null);
  const controlsPerRow = rows.map((row) => [...row.querySelectorAll('button, input, [role=switch], [role=checkbox], select')].filter((c) => shown(c)).length);
  const sat = (c) => { const m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return 0; const [r, g, b, a = 1] = m[1].split(',').map(Number); if (a < 0.2) return 0; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx; };
  const colored = [...page.querySelectorAll('*')].filter((n) => shown(n) && n.children.length === 0 && (sat(getComputedStyle(n).color) > 0.35 || sat(getComputedStyle(n).backgroundColor) > 0.35)).map((n) => (n.getAttribute('data-testid') || n.tagName) + ':' + (n.textContent || '').trim().slice(0, 16));
  return { rows: rows.length, maxControlsPerRow: Math.max(0, ...controlsPerRow), rowsOverOne: controlsPerRow.filter((n) => n > 1).length, colored: colored.slice(0, 25), coloredCount: colored.length };
})()`;

// ---- 技能 -------------------------------------------------------------------
await open("");
FACTS.hubEntryClicked = await openHub();
FACTS.tabs = await evaluate("[...document.querySelectorAll('[data-testid=capability-hub-page] [role=tab]')].map((n) => n.textContent.trim())");
await clickTestId("capability-hub-tab-skills");
await sleep(1200);
FACTS.skillsAudit = await evaluate(AUDIT);
await pair("p01", "skills");
FACTS.expandedBuiltin = await clickText("DSH 内置");
await sleep(500);
await evaluate("window.scrollTo(0, 0)");
const firstRow = await evaluate("(() => { const n = [...document.querySelectorAll('[data-testid=capability-hub-panel-skills] [role=button]')].find((x) => x.getBoundingClientRect().height >= 40); if (!n) return null; const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()");
if (firstRow) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: firstRow.x, y: firstRow.y, buttons: 0 }); await sleep(350); }
FACTS.skillsExpandedAudit = await evaluate(AUDIT);
await pair("p03", "skills-expanded");
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5, buttons: 0 });

// 筛选中折叠：切到「已启用」，折叠第一个来源仓库分组，再切回「全部」看折叠是否还原
FACTS.filterEnabled = await clickTestId("skills-toolbar-filter-enabled");
await sleep(500);
const repoToggle = "[data-testid^=skills-repo-user-][data-testid$=-toggle]";
FACTS.filteredRepoBefore = await evaluate("(() => { const n = document.querySelector(" + JSON.stringify(repoToggle) + "); return n ? n.getAttribute('aria-expanded') : null; })()");
await evaluate("(() => { const n = document.querySelector(" + JSON.stringify(repoToggle) + "); if (n) n.click(); return !!n; })()");
await sleep(400);
FACTS.filteredRepoAfter = await evaluate("(() => { const n = document.querySelector(" + JSON.stringify(repoToggle) + "); return n ? n.getAttribute('aria-expanded') : null; })()");
await evaluate("window.scrollTo(0, 0)");
await shot("p17-skills-filtered-fold-light.png");
await clickTestId("skills-toolbar-filter-all");
await sleep(400);
FACTS.unfilteredRepoAfterClear = await evaluate("(() => { const n = document.querySelector(" + JSON.stringify(repoToggle) + "); return n ? n.getAttribute('aria-expanded') : null; })()");

FACTS.addSkillOpened = await clickText("添加技能");
await sleep(2500);
FACTS.addSkillDrawerWidth = await evaluate("(() => { const d = document.querySelector('[data-testid=kit-drawer]') || document.querySelector('[role=dialog]'); return d ? Math.round(d.getBoundingClientRect().width) : null; })()");
await pair("p05", "add-skill");
FACTS.repoListToggled = await clickTestId("skills-repo-group-toggle");
FACTS.checked = await evaluate("(() => { const boxes = [...document.querySelectorAll('[data-testid=skills-discovery-list] input[type=checkbox]:not(:disabled)')].slice(0, 2); boxes.forEach((b) => b.click()); return boxes.length; })()");
await sleep(600);
FACTS.footerVisible = await evaluate("!!document.querySelector('[data-testid=skills-install-submit]')");
FACTS.addSkillAudit = await evaluate("(() => { const d = document.querySelector('[data-testid=kit-drawer]'); if (!d) return null; const rows = [...d.querySelectorAll('[data-testid=skills-discovery-list] li')]; return rows.slice(0, 50).map((r) => [...r.querySelectorAll('button, input, [role=switch], [role=checkbox], select')].filter((c) => getComputedStyle(c).opacity !== '0' && c.getBoundingClientRect().width > 0 && getComputedStyle(c.closest('[class]')).opacity !== '0').length).reduce((m, n) => Math.max(m, n), 0); })()");
await pair("p13", "add-skill-selected");
// 搜索 skills.sh → 结果框；再从结果里「浏览」一个仓库（--no-network 时跳过）
if (!process.argv.includes("--no-network")) {
  await evaluate("(() => { const n = document.querySelector('[data-testid=skills-remote-search-input]'); const input = n && (n.tagName === 'INPUT' ? n : n.querySelector('input')); if (!input) return false; input.focus(); return true; })()");
  await send("Input.insertText", { text: "pdf" });
  await clickTestId("skills-remote-search-button");
  await sleep(4000);
  FACTS.searchBoxHeight = await evaluate("(() => { const n = document.querySelector('[data-testid=skills-remote-search-box]'); return n ? Math.round(n.getBoundingClientRect().height) : null; })()");
  await shot("p15-add-skill-search-light.png");
  FACTS.browsedFromSearch = await clickTestId("skills-remote-search-browse-0");
  await sleep(6000);
  FACTS.searchCollapsedAfterBrowse = await evaluate("!document.querySelector('[data-testid=skills-remote-search-box]')");
  FACTS.browseVisible = await evaluate("(() => { const n = document.querySelector('[data-testid=skills-remote-browse-result]'); if (!n) return null; const r = n.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })()");
  await shot("p16-add-skill-browse-light.png");
}
await escape();

// ---- MCP --------------------------------------------------------------------
await clickTestId("capability-hub-tab-mcp");
await sleep(1200);
await evaluate("(() => { const p = document.querySelector('[data-testid=capability-hub-panel-mcp]'); if (p) p.scrollIntoView({ block: 'end' }); const s = [...document.querySelectorAll('*')].find((n) => n.children.length === 0 && /^运行中/.test((n.textContent || '').trim())); if (s) s.scrollIntoView({ block: 'center' }); return true; })()");
await sleep(400);
FACTS.mcpAudit = await evaluate(AUDIT);
FACTS.runningHeader = await evaluate("(() => { const s = [...document.querySelectorAll('[data-testid=capability-hub-panel-mcp] *')].find((n) => n.children.length === 0 && /^运行中/.test((n.textContent || '').trim())); return s ? s.textContent.trim() : null; })()");
await pair("p07", "mcp");

await open("&hubPreviewRunning=1");
await openHub();
await clickTestId("capability-hub-tab-mcp");
await sleep(1500);
await evaluate("(() => { const s = [...document.querySelectorAll('[data-testid=capability-hub-panel-mcp] *')].find((n) => n.children.length === 0 && /^运行中/.test((n.textContent || '').trim())); if (s) s.scrollIntoView({ block: 'start' }); return true; })()");
await sleep(400);
FACTS.previewRunningText = await evaluate("(() => { const p = document.querySelector('[data-testid=capability-hub-panel-mcp]'); return p ? p.innerText.slice(-600) : null; })()");
await pair("p09", "mcp-running-preview");

await open("");
await openHub();
await clickTestId("capability-hub-tab-mcp");
await sleep(1200);
FACTS.serverDrawerOpened = await evaluate("(() => { const n = [...document.querySelectorAll('[data-testid=capability-hub-panel-mcp] [role=button]')].find((x) => x.getBoundingClientRect().height >= 40); if (!n) return false; n.click(); return true; })()");
await sleep(1500);
FACTS.serverDrawerText = await evaluate("(() => { const d = document.querySelector('[data-testid=kit-drawer]') || document.querySelector('[role=dialog]'); return d ? d.innerText.slice(0, 800) : null; })()");
await pair("p11", "mcp-drawer");
await escape();

FACTS.console = consoleLines.filter((line) => /capability-hub|error/i.test(line)).slice(0, 20);
writeFileSync(join(outDir, suffix === "" ? "pages-facts.json" : "pages-facts-" + suffix + ".json"), JSON.stringify(FACTS, null, 2), "utf8");
console.log(JSON.stringify(FACTS, null, 2));
socket.close();
killEdge();
