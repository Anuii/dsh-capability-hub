/**
 * MCP 页的操作走查（无头 Edge）：粘贴 JSON 添加一个服务器 → 预览与保存 → 由 DSH 官方 MCP 插件连上、
 * 行上显示工具数 → 详情里看到模型看到的工具名 → 重新连接 → 启停 →
 * JSON 编辑（本地规则拦下废弃字段）→ 删除。截图之外，用真实点击验证状态仓库接得对。
 *
 * 用法（包根，测试 profile 在跑）：node scripts\ui-walk-mcp.mjs
 * 期望末行：UI-WALK-MCP-RESULT pass=N fail=0
 *
 * 只动测试 profile 的夹具数据（devOverrides.homeDir），结束时无论成败都删掉走查用的服务器；不新建会话。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHubBrowser, sleep } from "./lib/hub-browser.mjs";
import { redactSession } from "./lib/session-guard.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "walk-probe";
const NODE = process.execPath;
const FIXTURE = join(packageRoot, "test", "mcp", "runtime", "fixtures", "fake-mcp-server.mjs");

let pass = 0;
let fail = 0;
let created = [];
/** 走查里通过 Registry 添加的服务器：结束时无论成败都删掉。 */
const createdRegistry = [];
const check = (ok, label, detail = "") => {
  if (ok) pass += 1;
  else fail += 1;
  console.log((ok ? "  [PASS] " : "  [FAIL] ") + label + (detail === "" ? "" : " — " + detail));
};
const sel = (id) => "document.querySelector('[data-testid=" + JSON.stringify(id) + "]')";
const text = (needle) => "document.body.innerText.includes(" + JSON.stringify(needle) + ")";

const hub = await launchHubBrowser({ name: "walk-mcp" });
const apiDeleteName = (name) =>
  hub.evaluate(
    "fetch('api/dsh-capability-hub/mcp/servers/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: " +
      JSON.stringify(name) +
      " }) }).then((r) => r.status)",
  );
const apiDelete = () => apiDeleteName(NAME);
try {
  await hub.open("");
  check(await hub.openHub(), "打开能力中心");
  await hub.clickTestId("capability-hub-tab-mcp");
  check(await hub.waitFor(sel("mcp-toolbar")), "MCP 页出现");
  if (await hub.exists("[data-testid=mcp-row-" + NAME + "]")) await apiDelete();

  // 1. 添加：粘贴 JSON → 解析预览 → 保存
  await hub.clickTestId("mcp-add");
  check(await hub.waitFor(sel("mcp-paste-textarea")), "「添加服务器」打开粘贴 JSON");
  const pasted = {
    mcpServers: {
      [NAME]: { command: NODE, args: [FIXTURE], env: { FAKE_MCP_NO_GRANDCHILD: "1" }, meta: { description: "走查用" } },
    },
  };
  await hub.setInput("mcp-paste-textarea", JSON.stringify(pasted, null, 2));
  await hub.clickTestId("mcp-paste-parse");
  check(await hub.waitFor(sel("mcp-paste-row-0")), "解析出一行预览");
  await hub.clickTestId("mcp-paste-save");
  check(await hub.waitFor(sel("mcp-paste-row-result-0"), 15000), "保存结果出现在预览行上");
  await hub.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await sleep(400);
  check(await hub.waitFor(sel("mcp-row-" + NAME), 15000), "列表里出现新服务器");

  // 2. 详情：0.9.0 起不再显示运行状态，行上不出现工具数
  check(
    !(await hub.evaluate("(" + sel("mcp-row-" + NAME) + "?.innerText ?? '').includes('个工具')")),
    "行上不显示工具数（运行状态界面已移除）",
  );
  await hub.clickTestId("mcp-row-" + NAME);
  check(await hub.waitFor(sel("mcp-drawer")), "点行打开详情抽屉");
  check(
    (await hub.evaluate("!document.querySelector('[data-testid=mcp-detail-tool-list]')")) === true,
    "抽屉里没有工具清单",
  );
  check(
    (await hub.evaluate("!document.querySelector('[data-testid=mcp-detail-reconnect]')")) === true,
    "抽屉里没有重新连接",
  );

  // 4. 抽屉里停用
  await hub.evaluate(
    "(() => { const s = document.querySelector('[data-testid=mcp-drawer] [role=switch]'); if (s) s.click(); return !!s; })()",
  );
  check(await hub.waitFor(text("已停用「" + NAME + "」"), 8000), "抽屉里停用，给出提示");

  // 5. JSON 编辑：废弃字段被同一份规则拦下（不发请求），去掉后保存成功、回到详情
  await hub.clickTestId("mcp-detail-json");
  check(await hub.waitFor(sel("mcp-json-textarea")), "切到 JSON 编辑");
  const current = JSON.parse(await hub.evaluate(sel("mcp-json-textarea") + ".value"));
  await hub.setInput("mcp-json-textarea", JSON.stringify({ ...current, lifecycle: "eager" }, null, 2));
  await hub.clickTestId("mcp-json-save");
  check(await hub.waitFor(sel("mcp-json-errors")), "废弃字段 lifecycle 被拦下");
  check(await hub.waitFor(text("已废弃")), "错误里说明字段已废弃");
  await hub.setInput("mcp-json-textarea", JSON.stringify({ ...current, scope: "session" }, null, 2));
  await hub.clickTestId("mcp-json-save");
  check(await hub.waitFor("!" + sel("mcp-json-textarea"), 8000), "改成按会话后保存成功（回到详情）");
  check(await hub.waitFor(sel("mcp-detail-scope") + "?.innerText.includes('按会话')", 5000), "详情里显示按会话");

  // 6. 删除
  await hub.waitFor(sel("mcp-detail-delete"));
  await hub.clickTestId("mcp-detail-delete");
  check(await hub.waitFor(sel("mcp-delete-dialog")), "删除确认对话框");
  await hub.clickTestId("mcp-delete-confirm");
  check(await hub.waitFor("!" + sel("mcp-row-" + NAME), 8000), "删除后从列表消失");
  check(await hub.waitFor(text("已删除「" + NAME + "」"), 5000), "删除提示");

  // 7. 连接失败提示：加一台启动命令不存在的服务器 → 顶部出现失败横幅 → 删掉后消失
  const BROKEN = "walk-broken";
  await hub.clickTestId("mcp-add");
  await hub.waitFor(sel("mcp-paste-textarea"), 8000);
  await hub.setInput(
    "mcp-paste-textarea",
    JSON.stringify({ mcpServers: { [BROKEN]: { command: "definitely-not-a-real-command-xyz" } } }, null, 2),
  );
  await hub.clickTestId("mcp-paste-parse");
  await hub.waitFor(sel("mcp-paste-row-0"), 8000);
  await hub.clickTestId("mcp-paste-save");
  await hub.waitFor(sel("mcp-paste-row-result-0"), 15000);
  await hub.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await sleep(400);
  check(await hub.waitFor(sel("mcp-connect-failures"), 25000), "连不上时出现失败提示");
  check(await hub.waitFor(text(BROKEN), 5000), "失败提示里点名了那台服务器");
  createdRegistry.push(BROKEN);
  await apiDeleteName(BROKEN);
  // 删是通过接口做的，页面配置没变、不会自动重读 health；点横幅上的「重新读取」再确认它消失。
  await hub.clickTestId("mcp-connect-recheck");
  check(await hub.waitFor("!" + sel("mcp-connect-failures"), 20000), "删掉连不上的服务器后提示消失");

  // 8. 从 Official Registry 搜索（测试 profile 开了 devOverrides.registryFixture：固定夹具、不联网）
  await hub.clickTestId("mcp-add");
  check(await hub.waitFor(sel("mcp-add-modes"), 8000), "「添加服务器」有两种方式");
  const switched = await hub.evaluate(
    "(() => { const tabs = [...document.querySelectorAll('[data-testid=mcp-add-modes] [role=tab]')]; const t = tabs.find((n) => (n.textContent || '').includes('Registry')); if (!t) return false; t.click(); return true; })()",
  );
  check(switched, "切到「从 Official Registry 搜索」");
  check(
    await hub.waitFor(
      "!document.querySelector('[data-testid=mcp-add-registry-panel]')?.hidden && !!document.querySelector('[data-testid=mcp-registry-query]')",
      8000,
    ),
    "搜索面板可见",
  );
  await hub.setInput("mcp-registry-query", "demo");
  await hub.clickTestId("mcp-registry-search");
  check(await hub.waitFor(sel("mcp-registry-results"), 20000), "搜到结果列表");
  const rowCount = await hub.evaluate(
    "[...document.querySelectorAll('[data-testid^=mcp-registry-row-]')].filter((n) => !/^mcp-registry-row-env-/.test(n.getAttribute('data-testid'))).length",
  );
  check(rowCount === 2, "夹具返回两条 server", String(rowCount));

  // 8. 预览 npm 那条：必填环境变量空着不许保存，填上后保存
  const openedNpm = await hub.evaluate(
    "(() => { const rows = [...document.querySelectorAll('[data-testid^=mcp-registry-row-]')]; const r = rows.find((n) => (n.innerText || '').includes('npm-demo')); if (!r) return false; r.click(); return true; })()",
  );
  check(openedNpm, "点开 npm 夹具的预览");
  check(await hub.waitFor(sel("mcp-registry-preview"), 15000), "预览出现");
  // 预览先出现、详情后到：等服务器名输入框渲染出来再读，别拿 null 去取 .value
  check(await hub.waitFor(sel("mcp-registry-name"), 15000), "预览里出现可编辑的服务器名");
  const suggested = await hub.evaluate(sel("mcp-registry-name") + "?.value ?? ''");
  check(suggested === "npm-demo", "默认服务器名是合规建议名", String(suggested));
  check((await hub.evaluate(sel("mcp-registry-save") + ".disabled")) === true, "必填 DEMO_KEY 空着时不能保存");
  check(await hub.exists("[data-testid=mcp-registry-env-error-DEMO_KEY]"), "必填变量标红");
  await hub.setInput("mcp-registry-env-DEMO_KEY", "walk-demo-key");
  check((await hub.evaluate(sel("mcp-registry-save") + ".disabled")) === false, "填上必填变量后可以保存");
  await hub.clickTestId("mcp-registry-save");
  check(await hub.waitFor(sel("mcp-registry-save-result"), 20000), "保存给出结果");
  createdRegistry.push("npm-demo");
  await hub.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await sleep(600);
  check(await hub.waitFor(sel("mcp-row-npm-demo"), 15000), "列表里出现 npm-demo");

  // 9. 远程那条：预览生成 streamable-http + url，不保存
  await hub.clickTestId("mcp-add");
  await hub.waitFor(sel("mcp-add-modes"), 8000);
  await hub.evaluate(
    "(() => { const tabs = [...document.querySelectorAll('[data-testid=mcp-add-modes] [role=tab]')]; const t = tabs.find((n) => (n.textContent || '').includes('Registry')); if (t) t.click(); return true; })()",
  );
  await hub.setInput("mcp-registry-query", "remote");
  await hub.clickTestId("mcp-registry-search");
  await hub.waitFor(sel("mcp-registry-results"), 20000);
  const openedRemote = await hub.evaluate(
    "(() => { const rows = [...document.querySelectorAll('[data-testid^=mcp-registry-row-]')]; const r = rows.find((n) => (n.innerText || '').includes('remote-demo')); if (!r) return false; r.click(); return true; })()",
  );
  check(openedRemote, "点开远程夹具的预览");
  check(await hub.waitFor(sel("mcp-registry-config"), 15000), "远程预览也生成了配置");
  const configText = await hub.evaluate(sel("mcp-registry-config") + "?.innerText ?? ''");
  check(
    configText.includes("streamable-http") && configText.includes("remote-demo.example.com"),
    "生成的配置是 streamable-http + url",
  );
  await hub.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await sleep(400);

  // 10. 结果很多时：列表在固定高度里滚动，滚到底后最后一条也能点开（修复「选项溢出窗口」）
  await hub.clickTestId("mcp-add");
  await hub.waitFor(sel("mcp-add-modes"), 8000);
  await hub.evaluate(
    "(() => { const tabs = [...document.querySelectorAll('[data-testid=mcp-add-modes] [role=tab]')]; const t = tabs.find((n) => (n.textContent || '').includes('Registry')); if (t) t.click(); return true; })()",
  );
  await hub.setInput("mcp-registry-query", "many");
  await hub.clickTestId("mcp-registry-search");
  await hub.waitFor(sel("mcp-registry-results"), 20000);
  const manyRows = await hub.evaluate(
    "[...document.querySelectorAll('[data-testid^=mcp-registry-row-]')].filter((n) => !/^mcp-registry-row-env-/.test(n.getAttribute('data-testid'))).length",
  );
  check(manyRows === 12, "夹具的多结果查询返回 12 条", String(manyRows));
  const scrollInfo = await hub.evaluate(
    "(() => { const n = document.querySelector('[data-testid=mcp-registry-results-scroll]'); if (!n) return null; return n.scrollHeight > n.clientHeight; })()",
  );
  check(scrollInfo === true, "结果多时结果框内部可滚动（不撑破对话框）");
  const lastVisible = await hub.evaluate(
    "(() => { const box = document.querySelector('[data-testid=mcp-registry-results-scroll]'); const row = document.querySelector('[data-testid=mcp-registry-row-11]'); if (!box || !row) return false; box.scrollTop = box.scrollHeight; const b = box.getBoundingClientRect(); const r = row.getBoundingClientRect(); return r.bottom <= b.bottom + 1; })()",
  );
  check(lastVisible === true, "滚到底后最后一条落在结果框内");
  await hub.clickTestId("mcp-registry-row-11");
  check(await hub.waitFor(sel("mcp-registry-preview"), 15000), "最后一条也能点开预览");
  await hub.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await sleep(400);
} catch (error) {
  check(false, "走查中途出错", error instanceof Error ? error.message : String(error));
} finally {
  try {
    if (await hub.exists("[data-testid=mcp-row-" + NAME + "]")) await apiDelete();
    for (const name of createdRegistry) {
      if (await hub.exists("[data-testid=mcp-row-" + name + "]")) await apiDeleteName(name);
    }
  } catch {
    // 页面已经不在了
  }
  created = hub.close();
}
check(created.length === 0, "走查没有新建会话", created.map(redactSession).join("、"));
console.log("UI-WALK-MCP-RESULT pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
