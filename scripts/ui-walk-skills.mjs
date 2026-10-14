/**
 * 技能页「来源」一段的操作走查（无头 Edge）：找一个还没有来源的技能 → 手动登记（空仓库被拦下）→
 * 登记成功 → 取消登记。不联网。
 *
 * 用法（包根，测试 profile 在跑）：node scripts\ui-walk-skills.mjs
 * 期望末行：UI-WALK-SKILLS-RESULT pass=N fail=0
 *
 * 只动测试 profile 的夹具数据；登记过的来源结束时一定取消掉；不新建会话。
 */
import { launchHubBrowser, sleep } from "./lib/hub-browser.mjs";

let pass = 0;
let fail = 0;
const check = (ok, label, detail = "") => {
  if (ok) pass += 1;
  else fail += 1;
  console.log((ok ? "  [PASS] " : "  [FAIL] ") + label + (detail === "" ? "" : " — " + detail));
};
const sel = (id) => "document.querySelector('[data-testid=" + JSON.stringify(id) + "]')";

const hub = await launchHubBrowser({ name: "walk-skills" });
let registeredFor;
try {
  await hub.open("");
  check(await hub.openHub(), "打开能力中心");
  await hub.clickTestId("capability-hub-tab-skills");
  check(await hub.waitFor("document.querySelector('[data-testid^=skills-row-]')", 15000), "技能列表出现");

  // 1. 依次打开技能，找一个「无来源」的（平铺 .md 技能不支持来源，跳过）
  const ids = await hub.evaluate(
    "[...document.querySelectorAll('[data-testid^=skills-row-]')].map((n) => n.getAttribute('data-testid').slice('skills-row-'.length)).filter((id) => !id.endsWith('.md'))",
  );
  let skillId;
  for (const id of ids.slice(0, 12)) {
    await hub.clickTestId("skills-row-" + id);
    if (!(await hub.waitFor(sel("skills-detail"), 5000))) continue;
    if (await hub.waitFor(sel("skills-remote-source-none-" + id), 4000)) {
      skillId = id;
      break;
    }
    await hub.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await sleep(400);
  }
  check(skillId !== undefined, "找到一个没有来源的技能", skillId ?? "");
  if (skillId === undefined) throw new Error("夹具里没有可用的技能");

  // 2. 手动登记：预填技能路径；仓库为空被拦下；填好后登记成功
  await hub.clickTestId("skills-remote-source-manual");
  check(await hub.waitFor(sel("skills-remote-manual-form")), "打开手动登记表单");
  const prefilled = await hub.evaluate(sel("skills-remote-manual-skillpath") + ".value");
  check(/\/SKILL\.md$/.test(prefilled), "技能路径预填成「<目录名>/SKILL.md」", prefilled);
  await hub.clickTestId("skills-remote-manual-confirm");
  check(await hub.waitFor("document.body.innerText.includes('repo：')", 3000), "仓库为空被拦下（不发请求）");
  await hub.setInput("skills-remote-manual-repo", "walk-owner/walk-repo");
  await hub.clickTestId("skills-remote-manual-confirm");
  registeredFor = skillId;
  check(
    await hub.waitFor(
      sel("skills-remote-source-done-" + skillId) + "?.innerText.includes('walk-owner/walk-repo')",
      8000,
    ),
    "登记成功并给出结果",
  );
  check(await hub.waitFor(sel("skills-remote-source-kv-" + skillId), 8000), "来源信息出现");

  // 3. 取消登记
  check(await hub.waitFor(sel("skills-remote-source-unregister"), 5000), "出现「取消登记」");
  await hub.clickTestId("skills-remote-source-unregister");
  check(await hub.waitFor(sel("skills-remote-unregister-body")), "取消登记要先确认");
  await hub.clickTestId("skills-remote-unregister-confirm");
  check(
    await hub.waitFor(sel("skills-remote-source-done-" + skillId) + "?.innerText.includes('已取消来源登记')", 8000),
    "取消登记成功",
  );
  registeredFor = undefined;
  check(await hub.waitFor(sel("skills-remote-source-none-" + skillId), 8000), "回到「无来源」");
} catch (error) {
  check(false, "走查中途出错", error instanceof Error ? error.message : String(error));
} finally {
  if (registeredFor !== undefined) {
    try {
      await hub.evaluate(
        "fetch('api/dsh-capability-hub/skills/sources/unregister', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skillId: " +
          JSON.stringify(registeredFor) +
          " }) }).then((r) => r.status)",
      );
    } catch {
      // 页面已经不在了
    }
  }
  hub.close();
}
console.log("UI-WALK-SKILLS-RESULT pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
