/** kit/store.ts：极小的外部状态仓库。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../../src/kit/store.ts";

test("set / patch 替换快照并通知；值没变不通知；订阅者异常不影响别人", () => {
  const store = createStore({ a: 1, b: "x" });
  let seen = 0;
  const off = store.subscribe(() => {
    seen += 1;
  });
  store.subscribe(() => {
    throw new Error("坏订阅者");
  });
  const before = store.get();
  store.patch({ a: 2 });
  assert.deepEqual(store.get(), { a: 2, b: "x" });
  assert.deepEqual(before, { a: 1, b: "x" }, "旧快照不被修改");
  store.set((current) => current);
  assert.equal(seen, 1, "值没变不通知");
  off();
  store.set({ a: 3, b: "y" });
  assert.equal(seen, 1, "退订后不再通知");
});
