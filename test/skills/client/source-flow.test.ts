/**
 * source-flow.ts：详情抽屉「来源」一段的推测 / 登记 / 取消登记流程。HTTP 与共享来源表用内存 fake。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createSourceFlow, type SourceFlowAdapter } from "../../../src/skills/client/remote/source-flow.ts";
import type { DiscoverCandidate, SourceEntry } from "../../../src/skills/contract/remote.ts";

const SKILL = { id: "user-agents:demo", dirName: "demo" };

function candidate(repo: string, extra: Partial<DiscoverCandidate> = {}): DiscoverCandidate {
  return {
    skillId: SKILL.id,
    repo,
    skillPath: "skills/demo/SKILL.md",
    confidence: "high",
    reason: "名字一致",
    ...extra,
  } as DiscoverCandidate;
}

function setup(options: { candidates?: DiscoverCandidate[]; failRegister?: boolean; failDiscover?: boolean } = {}) {
  const calls: string[] = [];
  let changed = 0;
  const adapter: SourceFlowAdapter = {
    async discover(skillId) {
      calls.push("discover " + skillId);
      if (options.failDiscover) throw new Error("GitHub 限流了");
      return options.candidates ?? [];
    },
    async register(input) {
      calls.push("register " + JSON.stringify(input));
      if (options.failRegister)
        throw Object.assign(new Error("参数不合法"), {
          code: "VALIDATION",
          details: [{ path: "repo", message: "仓库格式不对" }],
        });
      return {
        skillId: input.skillId,
        repo: input.repo,
        ...(input.ref ? { ref: input.ref } : {}),
        skillPath: input.skillPath,
      } as SourceEntry;
    },
    async unregister(skillId) {
      calls.push("unregister " + skillId);
    },
    sourceSaved: (entry) => void calls.push("saved " + entry.repo),
    sourceRemoved: (skillId) => void calls.push("removed " + skillId),
  };
  const flow = createSourceFlow(adapter, { skill: SKILL, workspace: undefined, onChanged: () => (changed += 1) });
  return { flow, calls, changed: () => changed };
}

test("推测：候选默认全选；登记只用勾选里的第一个，成功后回到查看并通知外面", async () => {
  const { flow, calls, changed } = setup({ candidates: [candidate("a/one"), candidate("b/two")] });
  const pending = flow.discover();
  assert.equal(flow.state.get().step, "discover");
  assert.equal(flow.state.get().busy, true);
  await pending;
  assert.equal(flow.state.get().selected.size, 2);
  flow.toggleCandidate(candidate("a/one"), false);
  await flow.registerSelected();
  assert.ok(
    calls.includes('register {"skillId":"user-agents:demo","repo":"b/two","skillPath":"skills/demo/SKILL.md"}'),
  );
  assert.ok(calls.includes("saved b/two"));
  assert.equal(flow.state.get().step, "view");
  assert.match(flow.state.get().done!, /b\/two/);
  assert.equal(changed(), 1);
});

test("推测失败或什么都没勾：给出原因，不发登记请求", async () => {
  const failing = setup({ failDiscover: true });
  await failing.flow.discover();
  assert.equal(failing.flow.state.get().error, "GitHub 限流了");
  assert.deepEqual(failing.flow.state.get().candidates, []);
  const none = setup({ candidates: [candidate("a/one")] });
  await none.flow.discover();
  none.flow.toggleCandidate(candidate("a/one"), false);
  await none.flow.registerSelected();
  assert.ok(none.flow.state.get().error !== undefined);
  assert.equal(
    none.calls.some((call) => call.startsWith("register")),
    false,
  );
});

test("手动登记：预填已有来源，没有就默认「<目录名>/SKILL.md」；仓库为空不发请求", async () => {
  const { flow, calls } = setup();
  flow.openManual(undefined);
  assert.deepEqual(flow.state.get().manual, { repo: "", ref: "", skillPath: "demo/SKILL.md" });
  await flow.submitManual();
  assert.deepEqual(
    flow.state.get().errors.map((error) => error.path),
    ["repo"],
  );
  assert.equal(calls.length, 0);
  flow.openManual({ skillId: SKILL.id, repo: "o/r", ref: "main", skillPath: "x/SKILL.md" } as SourceEntry);
  assert.deepEqual(flow.state.get().manual, { repo: "o/r", ref: "main", skillPath: "x/SKILL.md" });
  flow.setManual("repo", "o/r2");
  await flow.submitManual();
  assert.ok(calls.some((call) => call.includes('"repo":"o/r2"')));
});

test("登记失败：中文原因与逐字段错误，停在原步骤", async () => {
  const { flow, changed } = setup({ failRegister: true });
  flow.openManual(undefined);
  flow.setManual("repo", "bad");
  await flow.submitManual();
  assert.equal(flow.state.get().step, "manual");
  assert.equal(flow.state.get().error, "参数不合法");
  assert.deepEqual(flow.state.get().errors, [{ path: "repo", message: "仓库格式不对" }]);
  assert.equal(changed(), 0);
  flow.back();
  assert.equal(flow.state.get().error, undefined);
  assert.equal(flow.state.get().step, "view");
});

test("取消登记：先确认，成功后从共享来源表去掉并通知外面", async () => {
  const { flow, calls, changed } = setup();
  flow.askUnregister();
  assert.equal(flow.state.get().step, "unregister");
  await flow.unregister();
  assert.deepEqual(calls, ["unregister user-agents:demo", "removed user-agents:demo"]);
  assert.equal(flow.state.get().step, "view");
  assert.ok(flow.state.get().done !== undefined);
  assert.equal(changed(), 1);
});
