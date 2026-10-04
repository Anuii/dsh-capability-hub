/**
 * 远程共享 store 的单测（纯数据，不碰 DOM / React）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteStore } from "../../src/client/skills/remote/store.ts";
import type { SourceEntry } from "../../src/client/skills/remote/types.ts";

function entry(skillId: string): SourceEntry {
  return { skillId, repo: "a/b", ref: "main", skillPath: "x/SKILL.md", store: "hub" };
}

test("初始快照：未加载、无来源、无检查结果", () => {
  const store = createRemoteStore();
  const snapshot = store.snapshot();
  assert.equal(snapshot.sourcesLoaded, false);
  assert.deepEqual(snapshot.sources, {});
  assert.deepEqual(snapshot.checks, {});
  assert.equal(snapshot.auth, undefined);
  assert.equal(snapshot.checking, false);
  assert.equal(snapshot.applying, false);
});

test("setSources 建索引并置已加载；upsert / remove 只动一条", () => {
  const store = createRemoteStore();
  store.setSources([entry("user-agents:a"), entry("user-dsh:b")]);
  let snapshot = store.snapshot();
  assert.equal(snapshot.sourcesLoaded, true);
  assert.equal(Object.keys(snapshot.sources).length, 2);
  assert.equal(snapshot.sources["user-dsh:b"]!.repo, "a/b");

  store.upsertSource(entry("user-agents:c"));
  assert.equal(Object.keys(store.snapshot().sources).length, 3);

  store.removeSource("user-agents:a");
  snapshot = store.snapshot();
  assert.equal(snapshot.sources["user-agents:a"], undefined);
  assert.equal(Object.keys(snapshot.sources).length, 2);
});

test("setChecks 合并结果并带上凭据模式与配额", () => {
  const store = createRemoteStore();
  store.setChecks([{ skillId: "a", status: "up-to-date" }], { mode: "gh", rateLimitRemaining: 4999 });
  assert.equal(store.snapshot().auth, "gh");
  assert.equal(store.snapshot().rateLimitRemaining, 4999);
  store.setChecks([{ skillId: "b", status: "update-available" }]);
  const snapshot = store.snapshot();
  assert.equal(snapshot.checks["a"]!.status, "up-to-date");
  assert.equal(snapshot.checks["b"]!.status, "update-available");
  // 不带凭据时保留上一次的值
  assert.equal(snapshot.auth, "gh");
});

test("订阅：变更会通知，取消订阅后不再通知，订阅者抛错不影响别人", () => {
  const store = createRemoteStore();
  let hits = 0;
  const unsubscribe = store.subscribe(() => {
    hits += 1;
  });
  const boom = store.subscribe(() => {
    throw new Error("订阅者自己的异常");
  });
  store.patch({ checking: true });
  assert.equal(hits, 1);
  assert.equal(store.snapshot().checking, true);
  unsubscribe();
  boom();
  store.patch({ checking: false });
  assert.equal(hits, 1);
});

test("reset 回到初始态", () => {
  const store = createRemoteStore();
  store.setSources([entry("a")]);
  store.setAuth("env", 12);
  store.reset();
  assert.equal(store.snapshot().sourcesLoaded, false);
  assert.equal(store.snapshot().auth, undefined);
});
