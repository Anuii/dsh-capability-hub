/**
 * 远程共享 store 的单测（纯数据，不碰 DOM / React）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteStore } from "../../../src/skills/client/remote/store.ts";
import type { SourceEntry } from "../../../src/skills/contract/remote.ts";

function entry(skillId: string): SourceEntry {
  return { skillId, repo: "a/b", ref: "main", skillPath: "x/SKILL.md", store: "hub" };
}

test("初始快照：未加载、无来源、无检查结果", () => {
  const store = createRemoteStore();
  const snapshot = store.state.get();
  assert.equal(snapshot.sourcesLoaded, false);
  assert.deepEqual(snapshot.sources, {});
  assert.deepEqual(snapshot.checks, {});
  assert.equal(snapshot.checking, false);
  assert.equal(snapshot.applying, false);
});

test("setSources 建索引并置已加载；upsert / remove 只动一条", () => {
  const store = createRemoteStore();
  store.setSources([entry("user-agents:a"), entry("user-dsh:b")]);
  let snapshot = store.state.get();
  assert.equal(snapshot.sourcesLoaded, true);
  assert.equal(Object.keys(snapshot.sources).length, 2);
  assert.equal(snapshot.sources["user-dsh:b"]!.repo, "a/b");

  store.upsertSource(entry("user-agents:c"));
  assert.equal(Object.keys(store.state.get().sources).length, 3);

  store.removeSource("user-agents:a");
  snapshot = store.state.get();
  assert.equal(snapshot.sources["user-agents:a"], undefined);
  assert.equal(Object.keys(snapshot.sources).length, 2);
});

test("setChecks 合并结果（只动 checks，不再记凭据与配额）", () => {
  const store = createRemoteStore();
  store.setChecks([{ skillId: "a", status: "up-to-date" }]);
  assert.deepEqual(store.state.get().checks, { a: { skillId: "a", status: "up-to-date" } });
  store.setChecks([{ skillId: "b", status: "update-available" }]);
  const snapshot = store.state.get();
  assert.equal(snapshot.checks["a"]!.status, "up-to-date");
  assert.equal(snapshot.checks["b"]!.status, "update-available");
  // 快照里不再有凭据模式 / 剩余配额（使用者决定去掉「⋯」里的 GitHub 凭据项）
  assert.equal("auth" in snapshot, false);
  assert.equal("rateLimitRemaining" in snapshot, false);
});

test("订阅：变更会通知，取消订阅后不再通知，订阅者抛错不影响别人", () => {
  const store = createRemoteStore();
  let hits = 0;
  const unsubscribe = store.state.subscribe(() => {
    hits += 1;
  });
  const boom = store.state.subscribe(() => {
    throw new Error("订阅者自己的异常");
  });
  store.state.patch({ checking: true });
  assert.equal(hits, 1);
  assert.equal(store.state.get().checking, true);
  unsubscribe();
  boom();
  store.state.patch({ checking: false });
  assert.equal(hits, 1);
});

test("reset 回到初始态", () => {
  const store = createRemoteStore();
  store.setSources([entry("a")]);
  store.setChecks([{ skillId: "a", status: "up-to-date" }]);
  store.reset();
  assert.equal(store.state.get().sourcesLoaded, false);
  assert.deepEqual(store.state.get().checks, {});
});
