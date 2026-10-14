/**
 * 「GitHub 镜像」对话框的纯规则与小状态仓库（mirror-model.ts）。
 *
 * 规则：菜单标签（无设置 / 有设置取主机名 / 解析失败显示原文）、自检结果文案、
 * 保存与清除的 Toast、输入首尾空白；状态仓库：打开填当前值、测试、保存成功关对话框、
 * 422 留在对话框里带中文 message 与逐字段错误。
 *
 * 数据访问用内存 fake（不碰 DOM / React / 网络）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createMirrorStore,
  mirrorHost,
  mirrorMenuLabel,
  mirrorTestText,
  mirrorToastText,
  trimMirrorInput,
  type MirrorAdapter,
} from "../../../src/skills/client/remote/mirror-model.ts";
import { t } from "../../../src/skills/client/strings.ts";
import type { MirrorTestResult, SkillsRemoteSettings } from "../../../src/skills/contract/remote.ts";

function setup(options: { current?: string; testResult?: MirrorTestResult; failSave?: boolean } = {}) {
  const calls: string[] = [];
  const adapter: MirrorAdapter = {
    async load(): Promise<SkillsRemoteSettings> {
      calls.push("load");
      return options.current === undefined ? { version: 1 } : { version: 1, githubMirror: options.current };
    },
    async save(mirror: string): Promise<SkillsRemoteSettings> {
      calls.push("save " + JSON.stringify(mirror));
      if (options.failSave) {
        throw Object.assign(new Error("GitHub 镜像必须以 https:// 开头。"), {
          code: "VALIDATION",
          details: [{ path: "githubMirror", message: "必须以 https:// 开头" }],
        });
      }
      return mirror === "" ? { version: 1 } : { version: 1, githubMirror: mirror };
    },
    async test(mirror: string): Promise<MirrorTestResult> {
      calls.push("test " + JSON.stringify(mirror));
      return options.testResult ?? { ok: true, ms: 12 };
    },
  };
  return { store: createMirrorStore(adapter), calls };
}

test("输入首尾空白：一律去掉，中间不动", () => {
  assert.equal(trimMirrorInput("  https://ghfast.top/  "), "https://ghfast.top/");
  assert.equal(trimMirrorInput(""), "");
  assert.equal(trimMirrorInput("   "), "");
  assert.equal(trimMirrorInput("https://a b/"), "https://a b/");
});

test("菜单标签：没设置是「GitHub 镜像…」，设置了带主机名", () => {
  assert.equal(mirrorMenuLabel(undefined), t("skills.remote.menu.mirror"));
  assert.equal(mirrorMenuLabel(""), t("skills.remote.menu.mirror"));
  assert.equal(mirrorMenuLabel("   "), t("skills.remote.menu.mirror"));
  assert.equal(mirrorMenuLabel("https://ghfast.top/"), t("skills.remote.menu.mirrorSet", { host: "ghfast.top" }));
  // 带端口的镜像其实是另一个镜像，标签照实显示；首尾空白不影响判定
  assert.equal(
    mirrorMenuLabel("  https://mirror.example.com:8443/  "),
    t("skills.remote.menu.mirrorSet", { host: "mirror.example.com:8443" }),
  );
});

test("菜单标签：URL 解析失败就显示原文（用户至少看得到自己填了什么）", () => {
  assert.equal(mirrorMenuLabel("ghfast.top"), t("skills.remote.menu.mirrorSet", { host: "ghfast.top" }));
  assert.equal(mirrorHost("not a url"), "not a url");
  assert.equal(mirrorHost("https://ghfast.top/"), "ghfast.top");
});

test("自检结果文案：成功给毫秒，失败原样显示宿主的中文原因", () => {
  assert.equal(mirrorTestText({ ok: true, ms: 12 }), t("skills.remote.mirror.testOk", { ms: 12 }));
  assert.equal(mirrorTestText({ ok: true }), t("skills.remote.mirror.testOkNoMs"));
  assert.equal(
    mirrorTestText({ ok: false, message: "镜像返回 HTTP 404，没能取到测试文件。" }),
    "镜像返回 HTTP 404，没能取到测试文件。",
  );
  assert.equal(mirrorTestText({ ok: false, message: "   " }), t("skills.remote.mirror.testFailed"));
  assert.equal(mirrorTestText({ ok: false }), t("skills.remote.mirror.testFailed"));
});

test("保存 / 清除的 Toast 文案", () => {
  assert.equal(mirrorToastText("https://ghfast.top/"), t("skills.remote.mirror.saved"));
  assert.equal(mirrorToastText("  "), t("skills.remote.mirror.cleared"));
  assert.equal(mirrorToastText(""), t("skills.remote.mirror.cleared"));
});

test("打开对话框：填入当前值；没读过设置时先读一次", async () => {
  const { store, calls } = setup({ current: "https://ghfast.top/" });
  store.open();
  assert.equal(store.state.get().open, true);
  assert.equal(store.state.get().input, "");
  await store.ensureLoaded();
  assert.equal(store.state.get().current, "https://ghfast.top/");
  store.close();
  store.open();
  assert.equal(store.state.get().input, "https://ghfast.top/");
  assert.ok(calls.includes("load"));
});

test("测试：用去掉首尾空白后的值发请求，结果进 state，期间 testing 为真", async () => {
  const { store, calls } = setup({ testResult: { ok: true, ms: 7 } });
  store.open();
  store.setInput("  https://ghfast.top/  ");
  await store.test();
  assert.deepEqual(
    calls.filter((call) => call.startsWith("test ")),
    ['test "https://ghfast.top/"'],
  );
  assert.deepEqual(store.state.get().result, { ok: true, ms: 7 });
  assert.equal(store.state.get().testing, false);
  assert.equal(store.state.get().open, true, "测试不关闭对话框、也不保存");
  assert.equal(
    calls.some((call) => call.startsWith("save ")),
    false,
    "测试不保存设置",
  );
});

test("测试失败也不抛错：宿主原因进 state", async () => {
  const { store } = setup({ testResult: { ok: false, message: "连接镜像失败：请求超时。" } });
  store.open();
  await store.test();
  assert.deepEqual(store.state.get().result, { ok: false, message: "连接镜像失败：请求超时。" });
});

test("保存成功：关闭对话框、更新当前值，并给出 Toast 文案", async () => {
  const { store, calls } = setup();
  store.open();
  store.setInput(" https://ghfast.top/ ");
  const toast = await store.save();
  assert.equal(toast, t("skills.remote.mirror.saved"));
  assert.ok(calls.includes('save "https://ghfast.top/"'), "首尾空白不进请求");
  assert.equal(store.state.get().open, false);
  assert.equal(store.state.get().current, "https://ghfast.top/");
  assert.equal(store.state.get().busy, false);
});

test("保存空值 = 清除：Toast 说明改回直连，当前值变回 undefined", async () => {
  const { store, calls } = setup({ current: "https://ghfast.top/" });
  await store.ensureLoaded();
  store.open();
  store.setInput("   ");
  const toast = await store.save();
  assert.equal(toast, t("skills.remote.mirror.cleared"));
  assert.ok(calls.includes('save ""'));
  assert.equal(store.state.get().current, undefined);
});

test("保存失败（422）：对话框不关，宿主的 message 与逐字段错误留在 state", async () => {
  const { store } = setup({ failSave: true });
  store.open();
  store.setInput("http://ghfast.top/");
  const toast = await store.save();
  assert.equal(toast, undefined, "失败不给 Toast 文案");
  assert.equal(store.state.get().open, true, "对话框不关闭");
  assert.equal(store.state.get().error, "GitHub 镜像必须以 https:// 开头。");
  assert.deepEqual(store.state.get().errors, [{ path: "githubMirror", message: "必须以 https:// 开头" }]);
  assert.equal(store.state.get().busy, false);
});

test("改输入会清掉上一次的自检结果与错误（它们不再对应当前内容）", async () => {
  const { store } = setup({ testResult: { ok: false, message: "连接镜像失败：请求超时。" } });
  store.open();
  await store.test();
  assert.notEqual(store.state.get().result, undefined);
  store.setInput("https://ghfast.top/");
  assert.equal(store.state.get().result, undefined);
  assert.equal(store.state.get().error, undefined);
});

test("读设置失败只降级：不抛错、标签按「没设置」显示", async () => {
  const failing: MirrorAdapter = {
    async load() {
      throw new Error("请求失败：网络错误");
    },
    async save(mirror) {
      return mirror === "" ? { version: 1 } : { version: 1, githubMirror: mirror };
    },
    async test() {
      return { ok: true, ms: 1 };
    },
  };
  const store = createMirrorStore(failing);
  await store.ensureLoaded();
  assert.equal(store.state.get().current, undefined);
  assert.equal(store.state.get().loaded, true);
  assert.equal(mirrorMenuLabel(store.state.get().current), t("skills.remote.menu.mirror"));
});

test("设置读回来得晚：打开时是空的输入框会被补上当前值（但不会覆盖用户已敲的字）", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const adapter: MirrorAdapter = {
    async load() {
      await gate;
      return { version: 1, githubMirror: "https://ghfast.top/" };
    },
    async save(mirror) {
      return { version: 1, githubMirror: mirror };
    },
    async test() {
      return { ok: true, ms: 1 };
    },
  };
  const store = createMirrorStore(adapter);
  store.open();
  assert.equal(store.state.get().input, "", "设置还没回来时输入框是空的");
  release?.();
  await store.ensureLoaded();
  assert.equal(store.state.get().input, "https://ghfast.top/", "补上当前值");

  // 用户已经开始敲字时不再覆盖
  const store2 = createMirrorStore(adapter);
  store2.open();
  store2.setInput("https://mirror.example.com/");
  await store2.ensureLoaded();
  assert.equal(store2.state.get().input, "https://mirror.example.com/");
});
