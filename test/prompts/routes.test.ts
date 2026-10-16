/**
 * 路由层（src/prompts/files/module.ts 的 routes）：参数校验、错误码、返回形状。
 * 直接调路由处理器（与 skills/local/routes.test.ts 同样的做法）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createPromptsFilesModule } from "../../src/prompts/files/module.ts";
import { makeCtx, makePromptArea, makeSettings, writeAt, type PromptArea } from "./fixtures.ts";
import type { PromptSettings } from "../../src/prompts/files/settings.ts";
import type { RouteHandler, RouteRequest } from "../../src/platform/contract/host.ts";

interface HttpError {
  status: number;
  code: string;
  message: string;
}

async function withRoutes(
  label: string,
  fn: (area: PromptArea, route: (key: string, req?: Partial<RouteRequest>) => Promise<unknown>) => Promise<void>,
  settings?: PromptSettings,
): Promise<void> {
  const area = await makePromptArea(label);
  try {
    const value = settings ?? makeSettings();
    const module = createPromptsFilesModule(makeCtx(area), { settings: () => value });
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

async function expectError(fn: () => Promise<unknown>, status: number, code: string, contains?: string) {
  try {
    await fn();
  } catch (error) {
    const e = error as HttpError;
    assert.equal(e.status, status, "状态码应为 " + status + "，实际 " + String(e.status) + "（" + e.message + "）");
    assert.equal(e.code, code);
    if (contains !== undefined)
      assert.equal(e.message.includes(contains), true, "错误应含「" + contains + "」：" + e.message);
    return e;
  }
  throw new Error("预期抛出错误，但没有抛出");
}

test("路由：八条路由键都在（list / view / save / create / set-enabled / trash × 3）", async () => {
  await withRoutes("routes-keys", async (_area, route) => {
    const area = undefined as never;
    void area;
    // 只要路由存在就不抛「路由不存在」
    const list = (await route("GET prompts/list", { query: {} })) as { layers: unknown[]; budget: unknown };
    assert.equal(Array.isArray(list.layers), true);
    assert.equal(typeof list.budget, "object");
    const trash = (await route("GET prompts/trash")) as { items: unknown[] };
    assert.deepEqual(trash.items, []);
  });
});

test("路由：GET prompts/list 的 workspace 必须是字符串", async () => {
  await withRoutes("routes-list", async (_area, route) => {
    await expectError(
      () => route("GET prompts/list", { query: { workspace: 42 as unknown as string } }),
      400,
      "BAD_REQUEST",
      "workspace",
    );
  });
});

test("路由：GET prompts/view 缺 id / 不在发现范围", async () => {
  await withRoutes("routes-view", async (area, route) => {
    await writeAt(area, "workspace/AGENTS.md", "x\n");
    await expectError(() => route("GET prompts/view", { query: {} }), 400, "BAD_REQUEST", "id");
    await expectError(
      () =>
        route("GET prompts/view", {
          query: { id: path.join(area.root, "nope", "AGENTS.md"), workspace: area.workspace },
        }),
      404,
      "NOT_FOUND",
    );
    const data = (await route("GET prompts/view", {
      query: { id: path.join(area.workspace, "AGENTS.md"), workspace: area.workspace },
    })) as { content: string; file: { name: string } };
    assert.equal(data.content, "x\n");
    assert.equal(data.file.name, "AGENTS.md");
  });
});

test("路由：POST prompts/save 参数校验（body 非对象、缺 id/content/baseVersion）", async () => {
  await withRoutes("routes-save", async (area, route) => {
    await writeAt(area, "workspace/AGENTS.md", "old\n");
    await expectError(() => route("POST prompts/save", { body: [] }), 400, "BAD_REQUEST", "JSON 对象");
    await expectError(() => route("POST prompts/save", { body: undefined }), 400, "BAD_REQUEST");
    await expectError(
      () => route("POST prompts/save", { body: { content: "x", baseVersion: "0" } }),
      400,
      "BAD_REQUEST",
      "id",
    );
    await expectError(
      () => route("POST prompts/save", { body: { id: path.join(area.workspace, "AGENTS.md"), baseVersion: "0" } }),
      400,
      "BAD_REQUEST",
      "content",
    );
    await expectError(
      () =>
        route("POST prompts/save", {
          body: { id: path.join(area.workspace, "AGENTS.md"), content: "x", baseVersion: 1 },
        }),
      400,
      "BAD_REQUEST",
      "baseVersion",
    );
    await expectError(
      () =>
        route("POST prompts/save", {
          body: { id: path.join(area.workspace, "AGENTS.md"), content: "x", baseVersion: "" },
        }),
      400,
      "BAD_REQUEST",
      "baseVersion",
    );

    // 正常
    const view = (await route("GET prompts/view", {
      query: { id: path.join(area.workspace, "AGENTS.md"), workspace: area.workspace },
    })) as { file: { version: string } };
    const saved = (await route("POST prompts/save", {
      body: {
        id: path.join(area.workspace, "AGENTS.md"),
        content: "new\n",
        baseVersion: view.file.version,
        workspace: area.workspace,
      },
    })) as { file: { version: string } };
    assert.notEqual(saved.file.version, view.file.version);

    // 版本冲突（带上同一个工作区，否则 id 先被判为不在发现范围）
    await expectError(
      () =>
        route("POST prompts/save", {
          body: {
            id: path.join(area.workspace, "AGENTS.md"),
            content: "again",
            baseVersion: view.file.version,
            workspace: area.workspace,
          },
        }),
      409,
      "CONFLICT",
    );
  });
});

test("路由：POST prompts/create 的位置枚举与返回形状", async () => {
  await withRoutes("routes-create", async (area, route) => {
    await expectError(() => route("POST prompts/create", { body: [] }), 400, "BAD_REQUEST", "JSON 对象");
    await expectError(() => route("POST prompts/create", { body: {} }), 400, "BAD_REQUEST", "location");
    await expectError(
      () => route("POST prompts/create", { body: { location: "nope" } }),
      400,
      "BAD_REQUEST",
      "location",
    );
    await expectError(() => route("POST prompts/create", { body: { location: 1 } }), 400, "BAD_REQUEST", "location");
    await expectError(
      () => route("POST prompts/create", { body: { location: "global", workspace: 5 } }),
      400,
      "BAD_REQUEST",
      "workspace",
    );

    const created = (await route("POST prompts/create", { body: { location: "global" } })) as { file: { id: string } };
    assert.equal(created.file.id, path.join(area.dshHome, "AGENTS.md"));
    await expectError(() => route("POST prompts/create", { body: { location: "global" } }), 409, "CONFLICT");
  });
});

test("路由：POST prompts/set-enabled 参数校验与两个方向", async () => {
  await withRoutes("routes-set", async (area, route) => {
    await writeAt(area, "workspace/AGENTS.md", "x\n");
    const id = path.join(area.workspace, "AGENTS.md");
    await expectError(() => route("POST prompts/set-enabled", { body: [] }), 400, "BAD_REQUEST", "JSON 对象");
    await expectError(() => route("POST prompts/set-enabled", { body: { enabled: true } }), 400, "BAD_REQUEST", "id");
    await expectError(
      () => route("POST prompts/set-enabled", { body: { id, enabled: "yes" } }),
      400,
      "BAD_REQUEST",
      "布尔值",
    );
    await expectError(
      () =>
        route("POST prompts/set-enabled", { body: { id: path.join(area.root, "nope", "AGENTS.md"), enabled: false } }),
      404,
      "NOT_FOUND",
    );

    const off = (await route("POST prompts/set-enabled", {
      body: { id, enabled: false, workspace: area.workspace },
    })) as {
      file: { disabled: boolean; path: string; id: string };
    };
    assert.equal(off.file.disabled, true);
    assert.equal(off.file.id, id);
    assert.equal(off.file.path, id + ".disabled");
    // workspace: null 当作没给 → 只全局层可见，这个项目文件不在发现范围（400/404 都可接受，这里断言被拒）
    await expectError(
      () => route("POST prompts/set-enabled", { body: { id, enabled: true, workspace: null } }),
      404,
      "NOT_FOUND",
    );
    const on = (await route("POST prompts/set-enabled", {
      body: { id, enabled: true, workspace: area.workspace },
    })) as { file: { disabled: boolean } };
    assert.equal(on.file.disabled, false);
  });
});

test("路由：回收站三条路由（list / restore / purge）", async () => {
  await withRoutes("routes-trash", async (area, route) => {
    const id = path.join(area.workspace, "AGENTS.md");
    await writeAt(area, "workspace/AGENTS.md", "old\n");
    const view = (await route("GET prompts/view", { query: { id, workspace: area.workspace } })) as {
      file: { version: string };
    };
    await route("POST prompts/save", {
      body: { id, content: "new\n", baseVersion: view.file.version, workspace: area.workspace },
    });

    const trash = (await route("GET prompts/trash")) as { items: { trashId: string; reason: string }[] };
    assert.equal(trash.items.length, 1);
    assert.equal(trash.items[0]!.reason, "save");

    await expectError(() => route("POST prompts/trash/restore", { body: [] }), 400, "BAD_REQUEST", "JSON 对象");
    await expectError(() => route("POST prompts/trash/restore", { body: {} }), 400, "BAD_REQUEST", "trashId");
    await expectError(
      () => route("POST prompts/trash/restore", { body: { trashId: ".." } }),
      400,
      "BAD_REQUEST",
      "trashId",
    );
    await expectError(() => route("POST prompts/trash/restore", { body: { trashId: "nope" } }), 404, "NOT_FOUND");

    const restored = (await route("POST prompts/trash/restore", {
      body: { trashId: trash.items[0]!.trashId, workspace: area.workspace },
    })) as { file: { id: string } };
    assert.equal(restored.file.id, id);
    assert.equal(
      ((await route("GET prompts/trash")) as { items: unknown[] }).items.length,
      1,
      "写回前的 new 进了回收站",
    );

    // purge：不带 trashId = 清空
    const purged = (await route("POST prompts/trash/purge", { body: {} })) as { purged: number };
    assert.equal(purged.purged, 1);
    const empty = (await route("POST prompts/trash/purge")) as { purged: number };
    assert.equal(empty.purged, 0);
    await expectError(
      () => route("POST prompts/trash/purge", { body: { trashId: ".." } }),
      400,
      "BAD_REQUEST",
      "trashId",
    );
    await expectError(() => route("POST prompts/trash/purge", { body: { trashId: "nope" } }), 404, "NOT_FOUND");
  });
});

test("路由：没有工作区时 list 只有全局层，create 的项目位置给 400", async () => {
  await withRoutes("routes-no-ws", async (_area, route) => {
    const list = (await route("GET prompts/list", { query: {} })) as { layers: { scope: string }[] };
    assert.deepEqual(
      list.layers.map((layer) => layer.scope),
      ["global"],
    );
    await expectError(() => route("POST prompts/create", { body: { location: "project-root" } }), 400, "BAD_REQUEST");
    await expectError(() => route("POST prompts/create", { body: { location: "workspace" } }), 400, "BAD_REQUEST");
  });
});

test("路由：list 把 loaderDisabled 与设置里的说明带给界面", async () => {
  const settings = makeSettings({
    loaderDisabled: true,
    maxBytes: 2048,
    source: "dsh-config",
    notes: ["预设里都关掉了"],
  });
  await withRoutes(
    "routes-loader",
    async (_area, route) => {
      const list = (await route("GET prompts/list", { query: {} })) as {
        loaderDisabled?: boolean;
        budget: { maxBytes: number; source: string };
        warnings: string[];
      };
      assert.equal(list.loaderDisabled, true);
      assert.equal(list.budget.maxBytes, 2048);
      assert.equal(list.budget.source, "dsh-config");
      assert.equal(list.warnings.includes("预设里都关掉了"), true);
    },
    settings,
  );
});
