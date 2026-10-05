import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createSkillsLocalModule } from "../../../src/skills/local/module.ts";
import type { RouteHandler, RouteRequest } from "../../../src/platform/contract/host.ts";
import { agentsRoot, makeCtx, makeTempArea, skillMd, writeSkill, type TempArea, LOCAL_DEPS } from "./fixtures.ts";

interface HttpError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

async function withRoutes(
  label: string,
  fn: (area: TempArea, route: (key: string, req?: Partial<RouteRequest>) => Promise<unknown>) => Promise<void>,
): Promise<void> {
  const area = await makeTempArea(label);
  try {
    const module = createSkillsLocalModule(makeCtx(area), LOCAL_DEPS);
    const route = async (key: string, req: Partial<RouteRequest> = {}) => {
      const handler: RouteHandler | undefined = module.routes[key];
      assert.ok(handler !== undefined, "路由不存在：" + key);
      return await handler({
        query: req.query ?? {},
        body: req.body,
        signal: req.signal ?? new AbortController().signal,
      });
    };
    await fn(area, route);
  } finally {
    await area.cleanup();
  }
}

async function expectError(
  fn: () => Promise<unknown>,
  status: number,
  code: string,
  contains?: string,
): Promise<HttpError> {
  try {
    await fn();
  } catch (error) {
    const e = error as HttpError;
    assert.equal(e.status, status, "状态码应为 " + status + "，实际 " + String(e.status) + "（" + e.message + "）");
    assert.equal(e.code, code, "错误码应为 " + code + "，实际 " + String(e.code));
    assert.equal(typeof e.message, "string");
    assert.equal(e.message.length > 0, true);
    if (contains !== undefined)
      assert.equal(e.message.includes(contains), true, "错误信息应包含「" + contains + "」：" + e.message);
    return e;
  }
  throw new Error("预期抛出错误，但没有抛出");
}

test("路由：GET skills/list 返回 roots/skills/warnings", async () => {
  await withRoutes("route-list", async (area, route) => {
    await writeSkill(agentsRoot(area), "demo", skillMd("demo", "d"));
    const data = (await route("GET skills/list", { query: {} })) as {
      roots: unknown[];
      skills: unknown[];
      warnings: unknown[];
    };
    assert.equal(Array.isArray(data.roots), true);
    assert.equal(Array.isArray(data.skills), true);
    assert.equal(Array.isArray(data.warnings), true);
    assert.equal((data.skills[0] as { id: string }).id, "user-agents:demo");

    const withWs = (await route("GET skills/list", { query: { workspace: area.workspace } })) as {
      roots: { rootId: string }[];
    };
    assert.equal(
      withWs.roots.some((r) => r.rootId === "project-agents"),
      true,
    );
    void area;
  });
});

test("路由：GET skills/list 的 workspace 必须是字符串", async () => {
  await withRoutes("route-list-badws", async (_area, route) => {
    await expectError(
      () => route("GET skills/list", { query: { workspace: 42 as unknown as string } }),
      400,
      "BAD_REQUEST",
      "workspace",
    );
  });
});

test("路由：GET skills/view 缺 id / id 不存在 / 正常返回", async () => {
  await withRoutes("route-view", async (area, route) => {
    const original = "---\nname: demo\ndescription: d\n---\n\n正文\n";
    await writeSkill(agentsRoot(area), "demo", original, { "a/b.md": "x" });
    await expectError(() => route("GET skills/view", { query: {} }), 400, "BAD_REQUEST", "id");
    await expectError(() => route("GET skills/view", { query: { id: "user-agents:nope" } }), 404, "NOT_FOUND");
    await expectError(() => route("GET skills/view", { query: { id: "badformat" } }), 400, "BAD_REQUEST");
    const data = (await route("GET skills/view", { query: { id: "user-agents:demo" } })) as {
      content: string;
      files: { path: string }[];
      skill: { id: string };
    };
    assert.equal(data.content, original);
    assert.equal(data.skill.id, "user-agents:demo");
    assert.equal(
      data.files.some((f) => f.path === "a/b.md"),
      true,
    );
  });
});

test("路由：POST skills/set-enabled 参数校验与错误码", async () => {
  await withRoutes("route-set", async (area, route) => {
    await writeSkill(agentsRoot(area), "demo", skillMd("demo", "d"));
    await expectError(() => route("POST skills/set-enabled", { body: [] }), 400, "BAD_REQUEST", "JSON 对象");
    await expectError(() => route("POST skills/set-enabled", { body: undefined }), 400, "BAD_REQUEST");
    await expectError(() => route("POST skills/set-enabled", { body: { enabled: true } }), 400, "BAD_REQUEST", "id");
    await expectError(
      () => route("POST skills/set-enabled", { body: { id: "user-agents:demo" } }),
      400,
      "BAD_REQUEST",
      "enabled",
    );
    await expectError(
      () => route("POST skills/set-enabled", { body: { id: "user-agents:demo", enabled: "yes" } }),
      400,
      "BAD_REQUEST",
      "布尔值",
    );
    await expectError(
      () => route("POST skills/set-enabled", { body: { id: "user-agents:nope", enabled: true } }),
      404,
      "NOT_FOUND",
    );

    const disabled = (await route("POST skills/set-enabled", { body: { id: "user-agents:demo", enabled: false } })) as {
      skill: { modelInvocationDisabled: boolean; modelVisible: boolean };
    };
    assert.equal(disabled.skill.modelInvocationDisabled, true);
    assert.equal(disabled.skill.modelVisible, false);

    const enabled = (await route("POST skills/set-enabled", {
      body: { id: "user-agents:demo", enabled: true, workspace: null },
    })) as { skill: { modelInvocationDisabled: boolean } };
    assert.equal(enabled.skill.modelInvocationDisabled, false);
  });
});

test("路由：只读根与 L2 结构分别返回 READ_ONLY / CONFLICT", async () => {
  const area = await makeTempArea("route-errors");
  try {
    const customDir = path.join(area.root, "custom-skills");
    const module = createSkillsLocalModule(makeCtx(area, { customSkillDirs: [customDir] }), LOCAL_DEPS);
    await writeSkill(customDir, "ro", skillMd("ro", "d"));
    await writeSkill(agentsRoot(area), "l2", "---\nname: l2\ndescription: d\ntags: [a]\n---\n");
    const call = (body: unknown) =>
      module.routes["POST skills/set-enabled"]({ query: {}, body, signal: new AbortController().signal });
    await expectError(() => call({ id: "custom-0:ro", enabled: false }), 403, "READ_ONLY");
    await expectError(() => call({ id: "user-agents:l2", enabled: false }), 409, "CONFLICT");
  } finally {
    await area.cleanup();
  }
});

test("路由：POST skills/delete、GET skills/trash、restore、purge 全链路", async () => {
  await withRoutes("route-trash", async (area, route) => {
    await writeSkill(agentsRoot(area), "demo", skillMd("demo", "d"));
    await expectError(() => route("POST skills/delete", { body: {} }), 400, "BAD_REQUEST", "id");
    await expectError(() => route("POST skills/delete", { body: { id: "user-agents:nope" } }), 404, "NOT_FOUND");

    const deleted = (await route("POST skills/delete", { body: { id: "user-agents:demo" } })) as {
      item: { trashId: string; reason: string };
    };
    assert.equal(deleted.item.reason, "delete");

    const trash = (await route("GET skills/trash")) as { items: { trashId: string }[] };
    assert.equal(trash.items.length, 1);
    assert.equal(trash.items[0].trashId, deleted.item.trashId);

    await expectError(() => route("POST skills/trash/restore", { body: {} }), 400, "BAD_REQUEST", "trashId");
    await expectError(
      () => route("POST skills/trash/restore", { body: { trashId: deleted.item.trashId, replace: "yes" } }),
      400,
      "BAD_REQUEST",
      "布尔值",
    );
    await expectError(() => route("POST skills/trash/restore", { body: { trashId: "nope" } }), 404, "NOT_FOUND");

    const restored = (await route("POST skills/trash/restore", { body: { trashId: deleted.item.trashId } })) as {
      skill: { id: string };
    };
    assert.equal(restored.skill.id, "user-agents:demo");
    assert.equal(((await route("GET skills/trash")) as { items: unknown[] }).items.length, 0);

    await route("POST skills/delete", { body: { id: "user-agents:demo" } });
    const purgedOne = (await route("POST skills/trash/purge", { body: {} })) as { purged: number };
    assert.equal(purgedOne.purged, 1);
    assert.equal(((await route("GET skills/trash")) as { items: unknown[] }).items.length, 0);
  });
});

test("路由：POST skills/trash/purge 支持省略 body（清空全部）与参数校验", async () => {
  await withRoutes("route-purge", async (area, route) => {
    await writeSkill(agentsRoot(area), "a", skillMd("a", "d"));
    await writeSkill(agentsRoot(area), "b", skillMd("b", "d"));
    await route("POST skills/delete", { body: { id: "user-agents:a" } });
    await route("POST skills/delete", { body: { id: "user-agents:b" } });
    const all = (await route("POST skills/trash/purge")) as { purged: number };
    assert.equal(all.purged, 2);
    await expectError(() => route("POST skills/trash/purge", { body: { trashId: 5 } }), 400, "BAD_REQUEST", "trashId");
    await expectError(() => route("POST skills/trash/purge", { body: { trashId: "nope" } }), 404, "NOT_FOUND");
  });
});

test("路由：错误对象带 status/code/message，可直接被平台层序列化", async () => {
  await withRoutes("route-shape", async (_area, route) => {
    const error = await expectError(() => route("GET skills/view", { query: {} }), 400, "BAD_REQUEST");
    assert.equal(Object.hasOwn(error, "details"), false, "没有 details 时不应虚构字段");
    assert.equal(Object.getPrototypeOf(error) !== null, true);
    assert.doesNotThrow(() => JSON.stringify({ code: error.code, message: error.message, status: error.status }));
  });
});
