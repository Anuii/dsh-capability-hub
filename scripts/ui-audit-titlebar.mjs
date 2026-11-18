/**
 * 检查抽屉头部控件是否侵入 Windows 窗口控制区，可选输出叠加模拟控件后的亮 / 暗截图。
 * 只操作隔离测试 profile；创建的 MCP 夹具服务器会在结束时删除。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHubBrowser, sleep } from "./lib/hub-browser.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "titlebar-audit";
const NODE = process.execPath;
const FIXTURE = join(packageRoot, "test", "mcp", "runtime", "fixtures", "fake-mcp-server.mjs");
const suffix = process.argv.includes("--suffix") ? process.argv[process.argv.indexOf("--suffix") + 1] : "titlebar";
const outDir = resolve(join(packageRoot, ".dev", "shots", "titlebar"));
const takeShots = process.argv.includes("--shots");
const facts = [];
let failed = 0;
mkdirSync(outDir, { recursive: true });

const hub = await launchHubBrowser({ name: "titlebar-audit" });
const selector = (id) => "document.querySelector('[data-testid=" + JSON.stringify(id) + "]')";

async function installWindowControls() {
  await hub.evaluate(`(() => {
    if (document.getElementById('titlebar-audit-controls')) return;
    const root = document.createElement('div');
    root.id = 'titlebar-audit-controls';
    root.style.cssText = 'position:fixed;top:0;right:0;width:138px;height:48px;z-index:2147483647;display:flex;pointer-events:none;color:var(--dsw-alias-fg-primary);font:16px sans-serif;align-items:center;justify-content:space-around';
    root.innerHTML = '<span>—</span><span>□</span><span>×</span>';
    document.body.append(root);
  })()`);
}

async function setDark(dark) {
  await hub.evaluate(
    "(() => { if (" +
      String(dark) +
      ") document.body.setAttribute('data-ds-dark-theme',''); else document.body.removeAttribute('data-ds-dark-theme'); })()",
  );
  await sleep(250);
}

async function audit(name) {
  await sleep(350);
  const result = await hub.evaluate(`(() => {
    const drawer = document.querySelector('.chk_drawer');
    if (!drawer) return { name: ${JSON.stringify(name)}, missing: true, collisions: [] };
    const safe = { left: innerWidth - 138, right: innerWidth, top: 0, bottom: 48 };
    const controls = [...drawer.querySelectorAll("button, input, select, textarea, [role=switch], [role=checkbox]")];
    const collisions = controls.filter((node) => {
      const style = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return false;
      return r.width > 0 && r.height > 0 && r.left < safe.right && r.right > safe.left && r.top < safe.bottom && r.bottom > safe.top;
    }).map((node) => ({
      id: node.getAttribute('data-testid') || node.getAttribute('aria-label') || node.tagName,
      rect: { left: node.getBoundingClientRect().left, top: node.getBoundingClientRect().top, right: node.getBoundingClientRect().right, bottom: node.getBoundingClientRect().bottom },
    }));
    return { name: ${JSON.stringify(name)}, missing: false, collisions, windowControls: safe };
  })()`);
  facts.push(result);
  const ok = !result.missing && result.collisions.length === 0;
  if (!ok) failed += 1;
  console.log((ok ? "  [PASS] " : "  [FAIL] ") + name + " — " + JSON.stringify(result));
}

async function capture(name) {
  await audit(name);
  if (!takeShots) return;
  for (const dark of [false, true]) {
    await setDark(dark);
    const theme = dark ? "dark" : "light";
    await hub.shot(join(outDir, name + "-" + theme + "-" + suffix + ".png"));
  }
  await setDark(false);
}

async function addServer() {
  await hub.clickTestId("mcp-add");
  await hub.waitFor(selector("mcp-paste-textarea"));
  const pasted = {
    mcpServers: {
      [NAME]: { command: NODE, args: [FIXTURE], env: { FAKE_MCP_NO_GRANDCHILD: "1" } },
    },
  };
  await hub.setInput("mcp-paste-textarea", JSON.stringify(pasted, null, 2));
  await hub.clickTestId("mcp-paste-parse");
  await hub.waitFor(selector("mcp-paste-row-0"));
  await hub.clickTestId("mcp-paste-save");
  await hub.waitFor(selector("mcp-paste-row-result-0"), 15000);
  await hub.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await hub.waitFor(selector("mcp-row-" + NAME), 15000);
}

async function removeServer() {
  await hub.evaluate(
    "fetch('api/dsh-capability-hub/mcp/servers/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: " +
      JSON.stringify(NAME) +
      " }) })",
  );
}

try {
  await hub.open("");
  if (!(await hub.openHub())) throw new Error("能力中心入口未打开");
  await installWindowControls();

  await hub.clickTestId("capability-hub-tab-skills");
  await hub.clickText("添加技能");
  if (!(await hub.waitFor(selector("skills-add")))) throw new Error("添加技能抽屉未打开");
  await capture("skills-add");
  await hub.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await sleep(300);

  await hub.clickTestId("capability-hub-tab-mcp");
  await hub.waitFor(selector("mcp-toolbar"));
  await removeServer();
  await addServer();
  await hub.clickTestId("mcp-row-" + NAME);
  if (!(await hub.waitFor(selector("mcp-drawer")))) throw new Error("MCP 详情抽屉未打开");
  await capture("mcp-detail");
  await hub.clickTestId("mcp-detail-json");
  if (!(await hub.waitFor(selector("mcp-json-textarea")))) throw new Error("MCP JSON 编辑未打开");
  await capture("mcp-json");
} catch (error) {
  failed += 1;
  console.error("[FAIL] " + (error instanceof Error ? error.message : String(error)));
} finally {
  try {
    await removeServer();
  } finally {
    hub.close();
  }
}

writeFileSync(join(outDir, "facts-" + suffix + ".json"), JSON.stringify(facts, null, 2), "utf8");
console.log("UI-AUDIT-TITLEBAR-RESULT pass=" + String(facts.length - failed) + " fail=" + String(failed));
if (failed > 0) process.exitCode = 1;
