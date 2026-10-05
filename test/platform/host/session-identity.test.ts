/**
 * 会话身份提取的单测（F1-Q5 / V5）。
 *
 * 这里覆盖「子代理会话的 parentSessionId 怎么来的」：exec.agent.session 的 header 里
 * parentSession 只在 origin === "subagent" 时才算父会话。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionIdentityOf } from "../../../src/platform/host/tool-registrar.ts";

test("普通会话：取到 sessionId，无父会话", () => {
  const identity = sessionIdentityOf({
    agent: { session: { id: "session-1", header: { origin: "user" } } },
  });
  assert.deepEqual(identity, { sessionId: "session-1", source: "agent" });
});

test("子代理会话：从 header.parentSession 取到父会话 id", () => {
  const identity = sessionIdentityOf({
    agent: {
      session: {
        id: "session-child",
        requestHeader: () => ({ origin: "subagent", parentSession: "session-parent", title: "子任务" }),
      },
    },
  });
  assert.equal(identity.sessionId, "session-child");
  assert.equal(identity.parentSessionId, "session-parent");
  assert.equal(identity.title, "子任务");
  assert.equal(identity.source, "agent");
});

test("origin 不是 subagent 时忽略 parentSession", () => {
  const identity = sessionIdentityOf({
    agent: { session: { id: "session-2", header: { origin: "user", parentSession: "session-x" } } },
  });
  assert.equal(identity.parentSessionId, undefined);
});

test("没有 agent 上下文时回退为 anonymous（不抛）", () => {
  assert.deepEqual(sessionIdentityOf({}), { sessionId: "anonymous", source: "fallback" });
  assert.deepEqual(sessionIdentityOf(undefined), { sessionId: "anonymous", source: "fallback" });
});

test("回归（FIX-8）：requestHeader() 是 LLM epoch header，父会话必须以 session.header 为准", () => {
  // 实测形状：requestHeader() 返回 request/header 事件的折叠（只有 config/tools，没有
  // parentSession/origin），首次请求前甚至是 undefined。FIX-8 之前这里优先读它 ⇒ 父会话恒丢。
  const identity = sessionIdentityOf({
    agent: {
      session: {
        id: "session-child",
        header: {
          version: 4,
          id: "session-child",
          isSeeded: false,
          parentSession: "session-parent",
          origin: "subagent",
        },
        requestHeader: () => ({ config: { model: "deepseek-official" } }),
      },
    },
  });
  assert.equal(identity.sessionId, "session-child");
  assert.equal(identity.parentSessionId, "session-parent");
});

test("回归（FIX-8）：requestHeader() 还没有值（首次请求前 undefined）时照样取到父会话", () => {
  const identity = sessionIdentityOf({
    agent: {
      session: {
        id: "session-child-2",
        header: { parentSession: "session-parent-2", origin: "subagent" },
        requestHeader: () => undefined,
      },
    },
  });
  assert.equal(identity.parentSessionId, "session-parent-2");
});

test("header.origin 缺失但 parentSession 在时也认（只拒绝非 subagent 的 origin）", () => {
  const identity = sessionIdentityOf({
    agent: { session: { id: "session-child-3", header: { parentSession: "session-parent-3" } } },
  });
  assert.equal(identity.parentSessionId, "session-parent-3");
});

test("header 存在但没有 parentSession 时不看 requestHeader（它不是会话 header）", () => {
  const identity = sessionIdentityOf({
    agent: {
      session: {
        id: "session-4",
        header: { version: 4, id: "session-4", isSeeded: false },
        requestHeader: () => ({ parentSession: "不该被采信", origin: "subagent" }),
      },
    },
  });
  assert.equal(identity.parentSessionId, undefined);
});

test("header.parentSession 为空串时不算父会话", () => {
  const identity = sessionIdentityOf({
    agent: { session: { id: "session-5", header: { parentSession: "", origin: "subagent" } } },
  });
  assert.equal(identity.parentSessionId, undefined);
});
