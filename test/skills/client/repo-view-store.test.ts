/**
 * repo-view-store.ts：仓库视图（「添加技能」抽屉）的状态与流程。用内存 adapter，通过仓库的接口测。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createRepoViewStore,
  filterScope,
  groupLimit,
  type RepoViewAdapter,
} from "../../../src/skills/client/remote/repo-view-store.ts";
import { DISCOVERY_PAGE } from "../../../src/skills/client/remote/discovery-model.ts";
import type { BrowseResult, DiscoveryView } from "../../../src/skills/contract/remote.ts";

const view = (cached: boolean, repos: string[] = ["a/one"]): DiscoveryView => ({
  cached,
  repos: repos.map((repo) => ({ repo, preset: false, scannedAt: "2026-10-05T00:00:00Z", skillCount: 1 })),
  skills: [],
});

const BROWSED: BrowseResult = {
  repo: "a/one",
  ref: "main",
  skills: [
    { skillPath: "x/SKILL.md", dirName: "x" },
    { skillPath: "y/SKILL.md", dirName: "y", installedId: "user-agents:y" },
    { skillPath: "z/SKILL.md", dirName: "z" },
  ],
};

/** 内存 adapter：记下调用；个别方法可以覆盖。 */
function fake(overrides: Partial<RepoViewAdapter> = {}): RepoViewAdapter & { calls: string[] } {
  const calls: string[] = [];
  const base: RepoViewAdapter = {
    roots: async () => [],
    discovery: async () => {
      calls.push("discovery");
      return view(true);
    },
    scan: async (_workspace, repos) => {
      calls.push("scan:" + (repos ?? []).join(","));
      return view(true);
    },
    browse: async (repo, ref) => {
      calls.push("browse:" + repo + "@" + (ref ?? ""));
      return BROWSED;
    },
    search: async (query) => {
      calls.push("search:" + query);
      return [{ name: "pdf", repo: "b/two" }];
    },
    addRepo: async (repo, ref) => {
      calls.push("add:" + repo + "@" + (ref ?? ""));
      return view(true, ["a/one", repo]);
    },
    updateRepo: async (repo, patch) => {
      calls.push("update:" + repo + ":" + patch.ref + ":" + patch.subPath);
      return view(true);
    },
    removeRepo: async (repo) => {
      calls.push("remove:" + repo);
      return view(true, []);
    },
    install: async (input) => {
      calls.push("install:" + input.repo + ":" + input.skillPaths.join("+") + ":" + input.target);
      return input.skillPaths.map((skillPath) => ({ skillPath, ok: true }));
    },
  };
  return Object.assign({ ...base, ...overrides }, { calls });
}

test("打开：读发现缓存；从没扫过就自动扫一次，扫过就不联网；仓库列表默认折叠", async () => {
  const never = fake({ discovery: async () => view(false) });
  const store = createRepoViewStore(never);
  assert.equal(store.state.get().reposOpen, false, "仓库列表默认折叠成一行");
  await store.open(undefined);
  assert.deepEqual(never.calls, ["scan:"]);
  assert.equal(store.state.get().scanning, false);

  const cached = fake();
  const again = createRepoViewStore(cached);
  await again.open("D:\\work");
  assert.deepEqual(cached.calls, ["discovery"]);
});

test("打开：切换工作区后，旧一轮的回应不覆盖新的", async () => {
  let release: (value: DiscoveryView) => void = () => undefined;
  let first = true;
  const adapter = fake({
    discovery: () =>
      first
        ? ((first = false), new Promise<DiscoveryView>((resolve) => (release = resolve)))
        : Promise.resolve(view(true, ["new/repo"])),
  });
  const store = createRepoViewStore(adapter);
  const slow = store.open("old");
  await store.open("new");
  release(view(true, ["old/repo"]));
  await slow;
  assert.deepEqual(
    store.state.get().discovery?.repos.map((record) => record.repo),
    ["new/repo"],
  );
});

test("输入框：像仓库地址就浏览（带分支、github.com 补协议）；关键词至少 2 个字才搜", async () => {
  const adapter = fake();
  const store = createRepoViewStore(adapter);
  store.setEntry("github.com/a/one");
  store.setRef("dev");
  await store.browseEntry();
  assert.equal(adapter.calls.at(-1), "browse:https://github.com/a/one@dev");
  assert.equal(store.state.get().focusTick, 1, "浏览结果出现时滚到可见");

  store.setEntry("p");
  await store.search();
  assert.equal(store.state.get().searchError, "搜索关键词至少需要 2 个字符。");
  store.setEntry("pdf");
  await store.search();
  assert.equal(store.state.get().searchOpen, true);
  assert.equal(store.state.get().searchError, undefined);
});

test("从搜索结果浏览：预先勾上那个技能，并收起搜索结果；浏览失败给错误", async () => {
  const store = createRepoViewStore(fake());
  store.setEntry("pdf");
  await store.search();
  await store.browse("a/one", undefined, "x/SKILL.md");
  const state = store.state.get();
  assert.equal(state.searchOpen, false);
  assert.deepEqual([...state.selected.values()], [{ repo: "a/one", ref: "main", skillPath: "x/SKILL.md" }]);

  const broken = createRepoViewStore(fake({ browse: async () => Promise.reject(new Error("仓库不存在")) }));
  await broken.browse("no/such");
  assert.equal(broken.state.get().browseError, "仓库不存在");
  assert.equal(broken.state.get().browse, undefined);
});

test("全选：只勾未安装的；返回汇总清掉浏览", async () => {
  const store = createRepoViewStore(fake());
  await store.browse("a/one");
  store.selectAllBrowsed();
  assert.deepEqual(
    [...store.state.get().selected.values()].map((item) => item.skillPath),
    ["x/SKILL.md", "z/SKILL.md"],
  );
  store.back();
  assert.equal(store.state.get().browse, undefined);
});

test("仓库列表：加入后提示新仓库的扫描结果；编辑保存；移除时清掉针对它的筛选", async () => {
  const adapter = fake();
  const store = createRepoViewStore(adapter);
  await store.open(undefined);
  await store.addRepo("b/two");
  assert.match(store.state.get().repoNote ?? "", /^已加入 b\/two/);

  store.startEdit({ repo: "a/one", preset: false, ref: "main" });
  store.editField("subPath", "skills");
  await store.saveEdit();
  assert.equal(adapter.calls.at(-1), "update:a/one:main:skills");
  assert.equal(store.state.get().editing, undefined);

  store.setFilter({ repoFilter: "A/ONE" });
  await store.removeRepo("a/one");
  assert.equal(store.state.get().repoFilter, "", "仓库名不区分大小写");

  await store.addRepo("  ");
  assert.equal(store.state.get().repoError, "请填写仓库。");
});

test("分批渲染：每组先 200 行，「再显示」加一批；换一种筛选重来", () => {
  const store = createRepoViewStore(fake());
  assert.equal(groupLimit(store.state.get(), "a/one"), DISCOVERY_PAGE);
  store.showMore("a/one");
  assert.equal(groupLimit(store.state.get(), "A/One"), DISCOVERY_PAGE * 2);
  store.setFilter({ query: "pdf" });
  assert.notEqual(filterScope(store.state.get()), "");
  assert.equal(groupLimit(store.state.get(), "a/one"), DISCOVERY_PAGE, "新的筛选从第一批开始");
});

test("安装：跨仓库按仓库分组依次装；失败的仓库记原因；清空勾选；有成功时重读发现并刷新正在浏览的仓库", async () => {
  const adapter = fake({
    install: async (input) => {
      adapter.calls.push("install:" + input.repo + ":" + input.skillPaths.join("+") + ":" + input.target);
      if (input.repo === "c/bad") throw new Error("下载失败");
      return input.skillPaths.map((skillPath) => ({ skillPath, ok: true }));
    },
  });
  const store = createRepoViewStore(adapter);
  await store.browse("a/one");
  store.toggle({ repo: "a/one", ref: "main", skillPath: "x/SKILL.md" }, true);
  store.toggle({ repo: "a/one", ref: "main", skillPath: "z/SKILL.md" }, true);
  store.toggle({ repo: "c/bad", skillPath: "q/SKILL.md" }, true);
  store.setTarget("user-dsh");
  const ok = await store.install();
  assert.equal(ok, 2);
  const state = store.state.get();
  assert.equal(state.selected.size, 0);
  assert.equal(state.installError, "c/bad：下载失败");
  assert.deepEqual(
    state.results?.map((item) => item.repo + ":" + item.skillPath),
    ["a/one:x/SKILL.md", "a/one:z/SKILL.md"],
  );
  assert.ok(adapter.calls.includes("install:a/one:x/SKILL.md+z/SKILL.md:user-dsh"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(adapter.calls.includes("discovery"), "「已安装」是现算的：重读缓存");
  assert.equal(adapter.calls.filter((call) => call.startsWith("browse:a/one")).length, 2, "刷新正在浏览的仓库");
  assert.notEqual(store.state.get().results, undefined, "刷新浏览时不清掉逐个结果");
  assert.equal(await store.install(), 0, "没有勾选时什么也不做");
});
