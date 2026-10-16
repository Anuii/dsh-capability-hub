/**
 * 提示词页的操作走查（无头 Edge）：切到「提示词」→ 全局组存在 → 打开全局那一行的抽屉 →
 * 改一行并保存（Toast + 旧版本进回收站）→ 从回收站恢复（内容回到原样）→ 停用（确认）→
 * 行上显示「已停用」→ 启用回来 → 结束时夹具与开始时一致。不新建会话。
 *
 * 用法（包根，测试 profile 在跑）：node scripts\ui-walk-prompts.mjs
 * 期望末行：UI-WALK-PROMPTS-RESULT pass=N fail=0
 *
 * **只动「全局」那一行**：测试 profile 里它是 .dev/home/.dsh/AGENTS.md 这个夹具文件
 * （devOverrides 把 homeDir 指到 .dev/home），绝不在「当前工作区」组里编辑、新建、启停——
 * 那一组指向使用者真实项目里的 AGENTS.md / CLAUDE.md。
 * 夹具全局文件不存在时先「新建 AGENTS.md（全局）」，结束时**不删除**它（提示调度者）。
 */
import { launchHubBrowser, sleep } from "./lib/hub-browser.mjs";
import { redactSession } from "./lib/session-guard.mjs";

const GLOBAL_ROW = "prompts-row-global-0";
const MARKER = "\n<!-- 走查临时追加的一行（结束后会恢复） -->\n";

let pass = 0;
let fail = 0;
let created = [];
const check = (ok, label, detail = "") => {
  if (ok) pass += 1;
  else fail += 1;
  console.log((ok ? "  [PASS] " : "  [FAIL] ") + label + (detail === "" ? "" : " — " + detail));
};
const sel = (id) => "document.querySelector('[data-testid=" + JSON.stringify(id) + "]')";
const text = (needle) => "document.body.innerText.includes(" + JSON.stringify(needle) + ")";

const hub = await launchHubBrowser({ name: "walk-prompts" });
let fixtureCreated = false;
let originalContent;
let globalId;
let originalDisabled;

/** 直接调插件接口（只用于取夹具事实与结束前的核对；页面操作全部走真实点击）。 */
const apiGet = (path) =>
  hub.evaluate("fetch('api/dsh-capability-hub/" + path + "').then((r) => r.json()).then((b) => b.data)");

const readGlobal = async () => {
  const list = await apiGet("prompts/list");
  const layer = (list?.layers ?? []).find((item) => item.scope === "global");
  const file = layer?.files?.[0];
  return file;
};

/** 行上有没有「已停用」。 */
const rowDisabled = () =>
  hub.evaluate("(function(){ const n = " + sel(GLOBAL_ROW) + "; return !!n && n.innerText.includes('已停用'); })()");

/**
 * 用真实点击把全局那一行切成 want 指定的停用状态（点开关 → 确认 → 等行上的文字跟上）。
 * 已经是那个状态就什么都不做。只在「全局」那一行上做；「当前工作区」组一律不碰。
 */
const setGlobalDisabled = async (want) => {
  const current = await readGlobal();
  if (current === undefined || current.disabled === want) return;
  await hub.evaluate(sel(GLOBAL_ROW + "-toggle") + ".querySelector('[role=switch]').click()");
  await hub.waitFor(sel("prompts-toggle-dialog"), 8000);
  await hub.clickTestId("prompts-toggle-confirm");
  await hub.waitFor(
    "(function(){ const n = " +
      sel(GLOBAL_ROW) +
      "; return !!n && n.innerText.includes('已停用') === " +
      String(want) +
      "; })()",
    10000,
  );
};

try {
  await hub.open("");
  check(await hub.openHub(), "打开能力中心");
  await hub.clickTestId("capability-hub-tab-prompts");
  check(await hub.waitFor(sel("prompts-toolbar"), 15000), "提示词页出现");
  check(await hub.waitFor(sel("prompts-group-global"), 10000), "「全局」组存在");
  check(await hub.waitFor(sel("prompts-group-workspace"), 10000), "「当前工作区」组存在");

  // 0. 夹具：测试 profile 的全局文件是 .dev/home/.dsh/AGENTS.md；不存在就先新建（结束时保留）。
  let file = await readGlobal();
  if (file === undefined) {
    await hub.clickTestId("prompts-create");
    check(await hub.waitFor(sel("prompts-create-dialog"), 8000), "打开「新建 AGENTS.md」对话框");
    await hub.clickTestId("prompts-create-location-global");
    await hub.clickTestId("prompts-create-confirm");
    check(await hub.waitFor(sel(GLOBAL_ROW), 15000), "新建后「全局」组里出现一行");
    fixtureCreated = true;
    file = await readGlobal();
  }
  check(file !== undefined, "夹具全局文件存在", file === undefined ? "" : file.displayPath);
  if (file === undefined) throw new Error("夹具里没有全局提示词文件");
  globalId = file.id;
  originalDisabled = file.disabled === true;

  const view = await apiGet("prompts/view?id=" + encodeURIComponent(globalId));
  originalContent = typeof view?.content === "string" ? view.content : "";
  check(typeof originalContent === "string", "读到夹具原始内容", String(originalContent.length) + " 字符");
  // 上次没恢复干净时先用界面启用回来（结束时按 originalDisabled 恢复原样）。
  if (originalDisabled) {
    await setGlobalDisabled(false);
    check((await readGlobal())?.disabled === false, "先把上次没恢复的停用状态启用回来");
  }

  // 1. 打开全局那一行的详情抽屉
  await hub.clickTestId(GLOBAL_ROW);
  check(await hub.waitFor(sel("prompts-drawer"), 10000), "点行打开详情抽屉");
  check(await hub.waitFor(sel("prompts-editor"), 10000), "抽屉里有等宽文本框");
  check(
    await hub.waitFor(sel("prompts-editor") + "?.value === " + JSON.stringify(originalContent), 10000),
    "文本框里是原始内容",
  );
  check(await hub.evaluate(sel("prompts-save") + "?.disabled === true"), "没有改动时「保存」不可点");

  // 2. 改一行并保存 → Toast「已保存，旧内容已放进回收站」
  const trashBefore = ((await apiGet("prompts/trash"))?.items ?? []).length;
  await hub.setInput("prompts-editor", originalContent + MARKER);
  check(await hub.evaluate(sel("prompts-save") + "?.disabled === false"), "有改动后「保存」可点");
  await hub.clickTestId("prompts-save");
  check(await hub.waitFor(text("已保存，旧内容已放进回收站"), 10000), "保存后出现 Toast");

  // 3. 回收站里出现旧版本
  const trash = (await apiGet("prompts/trash"))?.items ?? [];
  check(trash.length === trashBefore + 1, "回收站多出一条", String(trashBefore) + " → " + String(trash.length));
  const mine = trash
    .filter((item) => item.fileId === globalId)
    .sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt)))[0];
  check(mine !== undefined, "回收站里有全局文件的旧版本", mine === undefined ? "" : mine.trashId);
  if (mine === undefined) throw new Error("回收站里没有这次保存留下的旧版本");

  await hub.clickTestId("prompts-toolbar-more-button");
  check(await hub.waitFor(sel("prompts-open-trash"), 5000), "「⋯」菜单里有「回收站」");
  // 菜单项的 testid 挂在文字外面的 span 上，点它等于点菜单项（事件冒泡回 MenuItemButton）。
  await hub.evaluate(
    "(() => { const n = " +
      sel("prompts-open-trash") +
      "; if (!n) return false; (n.closest('[role=menuitem], button') ?? n).click(); return true; })()",
  );
  check(await hub.waitFor(sel("prompts-trash"), 8000), "打开回收站抽屉");
  check(await hub.waitFor(sel("prompts-trash-row-" + mine.trashId), 8000), "回收站里列出这一条旧版本");

  // 4. 恢复 → 内容回到原样
  await hub.clickTestId("prompts-trash-restore-" + mine.trashId);
  check(await hub.waitFor(sel("prompts-restore-dialog"), 8000), "恢复要先确认");
  await hub.clickTestId("prompts-restore-confirm");
  check(await hub.waitFor(text("已恢复"), 15000), "恢复给出提示");
  check(
    await hub.waitFor(sel("prompts-editor") + "?.value === " + JSON.stringify(originalContent), 15000),
    "恢复后文本框回到原始内容",
  );
  const after = await apiGet("prompts/view?id=" + encodeURIComponent(globalId));
  check(after?.content === originalContent, "磁盘上的内容也回到原样");
  await hub.clickTestId("prompts-trash-close");
  await sleep(400);
  await hub.clickTestId("prompts-drawer-close");
  await sleep(400);

  // 5. 停用（确认）→ 行显示「已停用」
  check(
    await hub.evaluate(sel(GLOBAL_ROW + "-toggle") + "?.querySelector('[role=switch]') !== null"),
    "行尾有启停开关",
  );
  await hub.evaluate(sel(GLOBAL_ROW + "-toggle") + ".querySelector('[role=switch]').click()");
  check(await hub.waitFor(sel("prompts-toggle-dialog"), 8000), "停用要先确认");
  // inGit 由宿主给：仓库里的项目根才会有「git 会显示文件被改名」这句提示。
  const inGit = (await apiGet("prompts/list"))?.inGit === true;
  check(
    (await hub.exists("[data-testid=prompts-toggle-git]")) === inGit,
    inGit ? "inGit 时确认框里提示「git 会显示文件被改名」" : "不在 git 仓库里时不提示改名",
  );
  await hub.clickTestId("prompts-toggle-confirm");
  check(await hub.waitFor(text("已停用"), 10000), "停用给出提示");
  check(
    await hub.waitFor(
      "(function(){ const n = " + sel(GLOBAL_ROW) + "; return !!n && n.innerText.includes('已停用'); })()",
      10000,
    ),
    "行上显示「已停用」",
  );
  const disabledFile = await readGlobal();
  check(disabledFile?.disabled === true, "接口里也是停用状态");

  // 6. 启用回来
  await hub.evaluate(sel(GLOBAL_ROW + "-toggle") + ".querySelector('[role=switch]').click()");
  check(await hub.waitFor(sel("prompts-toggle-dialog"), 8000), "启用也要确认");
  await hub.clickTestId("prompts-toggle-confirm");
  check(await hub.waitFor(text("已启用"), 10000), "启用给出提示");
  check((await rowDisabled()) === false, "行上不再显示「已停用」");
  let enabledFile = await readGlobal();
  check(enabledFile?.disabled === false, "接口里也是启用状态");

  // 夹具原本是停用的（上次没恢复干净）：再停用回去，做到「结束时与开始时一致」。
  if (originalDisabled) {
    await setGlobalDisabled(true);
    enabledFile = await readGlobal();
  }

  // 7. 结束时夹具与开始时一致
  const finalView = await apiGet("prompts/view?id=" + encodeURIComponent(globalId));
  check(finalView?.content === originalContent, "结束时内容与开始时一致");
  check(enabledFile?.disabled === originalDisabled, "结束时启用状态与开始时一致");
} catch (error) {
  check(false, "走查中途出错", error instanceof Error ? error.message : String(error));
} finally {
  // 兜底：中途出错也要把全局夹具的内容写回原样（只碰全局那一个 id）。
  try {
    if (globalId !== undefined && originalContent !== undefined) {
      const current = await apiGet("prompts/view?id=" + encodeURIComponent(globalId));
      if (current?.content !== originalContent) {
        const status = await hub.evaluate(
          "fetch('api/dsh-capability-hub/prompts/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: " +
            JSON.stringify(globalId) +
            ", content: " +
            JSON.stringify(originalContent) +
            ", baseVersion: " +
            JSON.stringify(current?.file?.version ?? "") +
            " }) }).then((r) => r.status)",
        );
        console.log("  [WARN] 兜底写回夹具内容，HTTP " + String(status));
      }
      const now = await readGlobal();
      if (now !== undefined && now.disabled !== originalDisabled) {
        await hub.evaluate(
          "fetch('api/dsh-capability-hub/prompts/set-enabled', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: " +
            JSON.stringify(globalId) +
            ", enabled: " +
            String(originalDisabled !== true) +
            " }) }).then((r) => r.status)",
        );
        console.log("  [WARN] 兜底把夹具的启用状态恢复成开始时那样");
      }
    }
  } catch {
    // 页面已经不在了
  }
  created = hub.close();
}
check(created.length === 0, "走查没有新建会话", created.map(redactSession).join("、"));
if (fixtureCreated) {
  console.log("注意：夹具全局文件原来不存在，本次走查新建了它（.dev/home/.dsh/AGENTS.md），按要求保留，不删除。");
}
console.log("UI-WALK-PROMPTS-RESULT pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
