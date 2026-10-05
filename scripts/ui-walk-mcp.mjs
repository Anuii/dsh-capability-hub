/**
 * MCP 页的操作走查（无头 Edge）：手动添加一个服务器 → 校验提示 → 保存与后台探测 → 启停 →
 * JSON 模式（本地规则拦下未知字段）→ 删除。截图之外，用真实点击验证状态仓库接得对。
 *
 * 用法（包根，测试 profile 在跑）：node scripts\ui-walk-mcp.mjs
 * 期望末行：UI-WALK-MCP-RESULT pass=N fail=0
 *
 * 只动测试 profile 的夹具数据（devOverrides.homeDir），结束时无论成败都删掉走查用的服务器；不新建会话。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchHubBrowser, sleep } from "./lib/hub-browser.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "walk-probe";
const NODE = process.execPath;
const FIXTURE = join(packageRoot, "test", "mcp", "runtime", "fixtures", "fake-mcp-server.mjs");

let pass = 0;
let fail = 0;
const check = (ok, label, detail = "") => {
  if (ok) pass += 1;
  else fail += 1;
  console.log((ok ? "  [PASS] " : "  [FAIL] ") + label + (detail === "" ? "" : " — " + detail));
};
const sel = (id) => "document.querySelector('[data-testid=" + JSON.stringify(id) + "]')";

const hub = await launchHubBrowser({ name: "walk-mcp" });
const apiDelete = () =>
  hub.evaluate(
    "fetch('api/dsh-capability-hub/mcp/servers/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: " +
      JSON.stringify(NAME) +
      " }) }).then((r) => r.status)",
  );
try {
  await hub.open("");
  check(await hub.openHub(), "打开能力中心");
  await hub.clickTestId("capability-hub-tab-mcp");
  check(await hub.waitFor(sel("mcp-toolbar")), "MCP 页出现");
  if (await hub.exists("[data-testid=mcp-row-" + NAME + "]")) await apiDelete();

  // 1. 新建：空表单直接保存 → 所有错误亮出来，不提交
  await hub.clickTestId("mcp-add-menu-button");
  await sleep(300);
  await hub.clickTestId("mcp-add-form");
  check(await hub.waitFor(sel("mcp-form")), "「手动填写」打开表单");
  await hub.clickTestId("mcp-form-save");
  check(await hub.waitFor(sel("mcp-error-serverName")), "空表单保存：名称旁出现错误");
  check(await hub.waitFor(sel("mcp-form-error-count")), "空表单保存：显示错误数");

  // 2. 填好再保存：保存成功、出现在列表、后台探测到工具数
  await hub.setInput("mcp-input-serverName", NAME);
  await hub.setInput("mcp-input-command", NODE);
  await hub.clickTestId("mcp-array-args-add");
  await sleep(200);
  await hub.setInput("mcp-array-args-0", FIXTURE);
  await sleep(200);
  check(!(await hub.exists("[data-testid=mcp-error-serverName]")), "填好名称后错误消失");
  await hub.clickTestId("mcp-form-save");
  check(await hub.waitFor(sel("mcp-row-" + NAME), 15000), "保存后列表里出现新服务器");
  check(await hub.waitFor("document.body.innerText.includes('已生效：「" + NAME + "」')", 5000), "保存提示");
  check(await hub.waitFor("document.body.innerText.includes('后台探测到')", 15000), "后台探测到工具数后再提示一次");

  // 3. 详情抽屉里停用
  await hub.clickTestId("mcp-row-" + NAME);
  check(await hub.waitFor(sel("mcp-drawer")), "点行打开详情抽屉");
  await hub.evaluate(
    "(() => { const s = document.querySelector('[data-testid=mcp-drawer] [role=switch]'); if (s) s.click(); return !!s; })()",
  );
  check(await hub.waitFor("document.body.innerText.includes('已停用「" + NAME + "」')", 8000), "抽屉里停用，给出提示");

  // 4. JSON 模式：未知字段被同一份规则拦下（不发请求），去掉后保存成功
  await hub.clickTestId("mcp-detail-json");
  check(await hub.waitFor(sel("mcp-json-textarea")), "切到 JSON 模式");
  const text = await hub.evaluate(sel("mcp-json-textarea") + ".value");
  const value = JSON.parse(text);
  await hub.setInput("mcp-json-textarea", JSON.stringify({ ...value, bogus: 1 }, null, 2));
  await hub.clickTestId("mcp-json-save");
  check(await hub.waitFor(sel("mcp-json-errors")), "未知字段被拦下");
  await hub.setInput("mcp-json-textarea", JSON.stringify({ ...value, meta: { description: "走查" } }, null, 2));
  await hub.clickTestId("mcp-json-save");
  check(await hub.waitFor("!" + sel("mcp-json-textarea"), 8000), "去掉未知字段后保存成功（抽屉关闭）");

  // 5. 删除
  await hub.clickTestId("mcp-row-" + NAME);
  await hub.waitFor(sel("mcp-detail-delete"));
  await hub.clickTestId("mcp-detail-delete");
  check(await hub.waitFor(sel("mcp-delete-dialog")), "删除确认对话框");
  await hub.clickTestId("mcp-delete-confirm");
  check(await hub.waitFor("!" + sel("mcp-row-" + NAME), 8000), "删除后从列表消失");
  check(await hub.waitFor("document.body.innerText.includes('已删除「" + NAME + "」')", 5000), "删除提示");
} catch (error) {
  check(false, "走查中途出错", error instanceof Error ? error.message : String(error));
} finally {
  try {
    if (await hub.exists("[data-testid=mcp-row-" + NAME + "]")) await apiDelete();
  } catch {
    // 页面已经不在了
  }
  hub.close();
}
console.log("UI-WALK-MCP-RESULT pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
