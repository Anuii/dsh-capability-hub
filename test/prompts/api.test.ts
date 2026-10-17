/**
 * prompts-files 的读写实现：view、save（正常 / 版本冲突 / 旧内容进回收站）、create、
 * set-enabled、trash list / restore / purge。全部在 os.tmpdir() 夹具里。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createPromptsFilesImpl, isCreateLocation, tooLargeError } from "../../src/prompts/files/api.ts";
import { makeCtx, makePromptArea, makeSettings, readBytes, writeAt, type PromptArea } from "./fixtures.ts";
import type { PromptSettings } from "../../src/prompts/files/settings.ts";
import type { PromptFile } from "../../src/prompts/contract/prompts.ts";

interface HttpError {
  status: number;
  code: string;
  message: string;
}

function implOf(area: PromptArea, settings?: PromptSettings) {
  const value = settings ?? makeSettings();
  return createPromptsFilesImpl(makeCtx(area), { settings: () => value });
}

async function expectError(fn: () => Promise<unknown>, status: number, code: string, contains?: string) {
  try {
    await fn();
  } catch (error) {
    const e = error as HttpError;
    assert.equal(e.status, status, "状态码应为 " + status + "，实际 " + String(e.status) + "（" + e.message + "）");
    assert.equal(e.code, code);
    assert.equal(typeof e.message, "string");
    assert.equal(e.message.length > 0, true);
    if (contains !== undefined)
      assert.equal(e.message.includes(contains), true, "错误应含「" + contains + "」：" + e.message);
    return e;
  }
  throw new Error("预期抛出错误，但没有抛出");
}

const wsAgents = (area: PromptArea) => path.join(area.workspace, "AGENTS.md");
const globalAgents = (area: PromptArea) => path.join(area.dshHome, "AGENTS.md");

test("api：list 的预算、warnings、loaderDisabled、projectRoot", async () => {
  const area = await makePromptArea("api-list");
  try {
    await writeAt(area, "home/.dsh/AGENTS.md", "g\n");
    await writeAt(area, "workspace/AGENTS.md", "w\n");
    const list = await implOf(area).list({ workspace: area.workspace });
    assert.equal(list.layers.length, 2);
    assert.deepEqual(
      list.layers.map((layer) => layer.inGit),
      [false, false],
      "没有 .git 时两层都不在仓库里；全局层恒 false",
    );
    assert.equal(list.projectRoot, area.workspace);
    assert.equal(list.budget.maxBytes, 65536);
    assert.equal(list.budget.source, "default");
    assert.equal(list.loaderDisabled, undefined);
    const expected =
      2 +
      Buffer.byteLength("Instructions from: ~/.dsh/AGENTS.md\n\n") +
      2 +
      Buffer.byteLength("Instructions from: AGENTS.md\n\n");
    assert.equal(list.budget.usedBytes, expected);

    const disabled = await implOf(area, makeSettings({ loaderDisabled: true })).list({ workspace: area.workspace });
    assert.equal(disabled.loaderDisabled, true);

    const custom = await implOf(
      area,
      makeSettings({ maxBytes: 1234, source: "dsh-config", notes: ["配置来自预设"] }),
    ).list({
      workspace: area.workspace,
    });
    assert.equal(custom.budget.maxBytes, 1234);
    assert.equal(custom.budget.source, "dsh-config");
    assert.equal(custom.warnings.includes("配置来自预设"), true);
  } finally {
    await area.cleanup();
  }
});

test("api：view 返回原文（保留 BOM 与 CRLF）与版本", async () => {
  const area = await makePromptArea("api-view");
  try {
    const original = "\uFEFF# 标题\r\n\r\n正文\r\n";
    await writeAt(area, "workspace/AGENTS.md", original);
    const view = await implOf(area).view(wsAgents(area), { workspace: area.workspace });
    assert.equal(view.content, original, "BOM 与 CRLF 原样返回");
    assert.equal(view.file.version.length, 16);
    assert.equal(view.file.size, Buffer.byteLength(original));
    assert.equal(view.file.disabled, false);
  } finally {
    await area.cleanup();
  }
});

test("api：view 对过大文件返回 413（PAYLOAD_TOO_LARGE）", async () => {
  const area = await makePromptArea("api-view-large");
  try {
    await writeAt(area, "workspace/AGENTS.md", Buffer.alloc(100, 0x61));
    const impl = implOf(area, makeSettings({ maxSourceBytes: 10 }));
    await expectError(
      () => impl.view(wsAgents(area), { workspace: area.workspace }),
      413,
      "PAYLOAD_TOO_LARGE",
      "单文件上限",
    );
    const direct = tooLargeError(100, 10);
    assert.equal(direct.status, 413);
    assert.equal(direct.code, "PAYLOAD_TOO_LARGE");
  } finally {
    await area.cleanup();
  }
});

test("api：save 正常 —— 原子写、版本更新、旧内容进回收站", async () => {
  const area = await makePromptArea("api-save");
  try {
    await writeAt(area, "workspace/AGENTS.md", "old\n");
    const impl = implOf(area);
    const before = await impl.view(wsAgents(area), { workspace: area.workspace });
    const saved = await impl.save({
      id: wsAgents(area),
      content: "new\n",
      baseVersion: before.file.version,
      workspace: area.workspace,
    });
    assert.equal(await fs.readFile(wsAgents(area), "utf8"), "new\n");
    assert.notEqual(saved.file.version, before.file.version);

    const trash = await impl.trashList();
    assert.equal(trash.length, 1);
    assert.equal(trash[0]!.reason, "save");
    assert.equal(trash[0]!.fileId, wsAgents(area));
    assert.equal(trash[0]!.displayPath, "AGENTS.md");
    assert.equal(trash[0]!.size, 4);
    assert.equal(
      await fs.readFile(path.join(area.hubHome, "prompts", "trash", trash[0]!.trashId, "content"), "utf8"),
      "old\n",
    );
  } finally {
    await area.cleanup();
  }
});

test("api：save 逐字节写回界面给的文本（不做行尾转换、保留 BOM）", async () => {
  const area = await makePromptArea("api-save-bytes");
  try {
    const original = "\uFEFFa\r\nb\r\n";
    await writeAt(area, "workspace/AGENTS.md", original);
    const impl = implOf(area);
    const before = await impl.view(wsAgents(area), { workspace: area.workspace });
    const next = "\uFEFFc\r\nd\r\n";
    await impl.save({ id: wsAgents(area), content: next, baseVersion: before.file.version, workspace: area.workspace });
    assert.equal((await readBytes(wsAgents(area))).toString("utf8"), next);
    assert.equal((await readBytes(wsAgents(area)))[0], 0xef, "BOM 保留");
  } finally {
    await area.cleanup();
  }
});

test("api：save 版本冲突 409，磁盘与回收站都不动", async () => {
  const area = await makePromptArea("api-save-conflict");
  try {
    await writeAt(area, "workspace/AGENTS.md", "old\n");
    const impl = implOf(area);
    await expectError(
      () =>
        impl.save({ id: wsAgents(area), content: "new\n", baseVersion: "0000000000000000", workspace: area.workspace }),
      409,
      "CONFLICT",
      "别处被改过",
    );
    assert.equal(await fs.readFile(wsAgents(area), "utf8"), "old\n");
    assert.deepEqual(await impl.trashList(), [], "冲突时不该往回收站放东西");
  } finally {
    await area.cleanup();
  }
});

test("api：save 缺 baseVersion / content 不是字符串 → 400", async () => {
  const area = await makePromptArea("api-save-bad");
  try {
    await writeAt(area, "workspace/AGENTS.md", "old\n");
    const impl = implOf(area);
    const view = await impl.view(wsAgents(area), { workspace: area.workspace });
    await expectError(
      () => impl.save({ id: wsAgents(area), content: "x", baseVersion: "", workspace: area.workspace }),
      400,
      "BAD_REQUEST",
    );
    await expectError(
      () =>
        impl.save({
          id: wsAgents(area),
          content: 1 as never,
          baseVersion: view.file.version,
          workspace: area.workspace,
        }),
      400,
      "BAD_REQUEST",
      "content",
    );
  } finally {
    await area.cleanup();
  }
});

test("api：create 三个位置，只建 AGENTS.md，已存在 409", async () => {
  const area = await makePromptArea("api-create");
  try {
    await fs.mkdir(path.join(area.root, "repo", ".git"), { recursive: true });
    const ws = path.join(area.root, "repo", "sub");
    await fs.mkdir(ws, { recursive: true });
    const impl = implOf(area);

    const globalFile = await impl.create("global");
    assert.equal(globalFile.file.id, globalAgents(area));
    assert.equal(await fs.readFile(globalAgents(area), "utf8"), "");
    assert.equal(globalFile.file.name, "AGENTS.md");

    const rootFile = await impl.create("project-root", { workspace: ws });
    assert.equal(rootFile.file.id, path.join(area.root, "repo", "AGENTS.md"));

    const wsFile = await impl.create("workspace", { workspace: ws });
    assert.equal(wsFile.file.id, path.join(ws, "AGENTS.md"));

    await expectError(() => impl.create("workspace", { workspace: ws }), 409, "CONFLICT", "已经有");
    await expectError(() => impl.create("global"), 409, "CONFLICT");

    // .disabled 也算已存在
    const other = await makePromptArea("api-create-disabled");
    try {
      await writeAt(other, "workspace/AGENTS.md.disabled", "x\n");
      await expectError(() => implOf(other).create("workspace", { workspace: other.workspace }), 409, "CONFLICT");
    } finally {
      await other.cleanup();
    }

    // 位置枚举封死
    await expectError(() => impl.create("elsewhere" as never), 400, "BAD_REQUEST", "location");
    assert.equal(isCreateLocation("global"), true);
    assert.equal(isCreateLocation("workspace"), true);
    assert.equal(isCreateLocation("project-root"), true);
    assert.equal(isCreateLocation("projectRoot"), false);
    assert.equal(isCreateLocation(""), false);
    assert.equal(isCreateLocation(1), false);

    // 没有工作区时 project-root / workspace 不能建
    await expectError(() => impl.create("project-root"), 400, "BAD_REQUEST", "没有工作区");
    await expectError(() => impl.create("workspace"), 400, "BAD_REQUEST");
  } finally {
    await area.cleanup();
  }
});

test("api：create 在候选名里没有 AGENTS.md 时拒绝（409）", async () => {
  const area = await makePromptArea("api-create-noname");
  try {
    const impl = implOf(area, makeSettings({ fileNames: ["OTHER.md"] }));
    await expectError(() => impl.create("global"), 409, "CONFLICT", "候选文件名");
  } finally {
    await area.cleanup();
  }
});

test("api：set-enabled 两个方向改名；目标已存在 409 且什么都不动", async () => {
  const area = await makePromptArea("api-toggle");
  try {
    await writeAt(area, "workspace/AGENTS.md", "a\n");
    const impl = implOf(area);

    const off = await impl.setEnabled(wsAgents(area), false, { workspace: area.workspace });
    assert.equal(off.file.disabled, true);
    assert.equal(off.file.id, wsAgents(area), "id 不变");
    assert.equal(off.file.path, wsAgents(area) + ".disabled");
    assert.equal(await fs.readFile(wsAgents(area) + ".disabled", "utf8"), "a\n");

    const on = await impl.setEnabled(wsAgents(area), true, { workspace: area.workspace });
    assert.equal(on.file.disabled, false);
    assert.equal(on.file.path, wsAgents(area));
    assert.equal(await fs.readFile(wsAgents(area), "utf8"), "a\n");

    // 目标名已存在：409 且两边内容都不动
    await writeAt(area, "workspace/AGENTS.md.disabled", "occupied\n");
    await expectError(
      () => impl.setEnabled(wsAgents(area), false, { workspace: area.workspace }),
      409,
      "CONFLICT",
      "什么都不动",
    );
    assert.equal(await fs.readFile(wsAgents(area), "utf8"), "a\n");
    assert.equal(await fs.readFile(wsAgents(area) + ".disabled", "utf8"), "occupied\n");

    // 已经是目标状态：幂等返回
    await fs.unlink(wsAgents(area) + ".disabled");
    const again = await impl.setEnabled(wsAgents(area), true, { workspace: area.workspace });
    assert.equal(again.file.disabled, false);
  } finally {
    await area.cleanup();
  }
});

test("api：trash list 按时间倒序；purge 指定 / 全部", async () => {
  const area = await makePromptArea("api-trash");
  try {
    await writeAt(area, "workspace/AGENTS.md", "v1\n");
    const impl = implOf(area);
    const v1 = await impl.view(wsAgents(area), { workspace: area.workspace });
    await impl.save({ id: wsAgents(area), content: "v2\n", baseVersion: v1.file.version, workspace: area.workspace });
    const v2 = await impl.view(wsAgents(area), { workspace: area.workspace });
    await impl.save({ id: wsAgents(area), content: "v3\n", baseVersion: v2.file.version, workspace: area.workspace });

    const items = await impl.trashList();
    assert.equal(items.length, 2);
    assert.equal(items[0]!.savedAt >= items[1]!.savedAt, true, "按时间倒序");

    await expectError(() => impl.purge(".."), 400, "BAD_REQUEST", "trashId");
    await expectError(() => impl.purge("nope"), 404, "NOT_FOUND");
    assert.equal(await impl.purge(items[0]!.trashId), 1);
    assert.equal((await impl.trashList()).length, 1);
    assert.equal(await impl.purge(), 1);
    assert.deepEqual(await impl.trashList(), []);
    assert.equal(await impl.purge(), 0);
  } finally {
    await area.cleanup();
  }
});

test("api：restore 写回原文；写回前当前内容也进回收站", async () => {
  const area = await makePromptArea("api-restore");
  try {
    await writeAt(area, "workspace/AGENTS.md", "old\n");
    const impl = implOf(area);
    const view = await impl.view(wsAgents(area), { workspace: area.workspace });
    await impl.save({
      id: wsAgents(area),
      content: "new\n",
      baseVersion: view.file.version,
      workspace: area.workspace,
    });

    const trash = await impl.trashList();
    const restored = await impl.restore(trash[0]!.trashId, { workspace: area.workspace });
    assert.equal(await fs.readFile(wsAgents(area), "utf8"), "old\n");
    assert.equal(restored.file.disabled, false);

    const after = await impl.trashList();
    assert.equal(after.length, 1, "写回前的 new 也进了回收站");
    assert.equal(after[0]!.reason, "restore");
    assert.equal(
      await fs.readFile(path.join(area.hubHome, "prompts", "trash", after[0]!.trashId, "content"), "utf8"),
      "new\n",
    );
  } finally {
    await area.cleanup();
  }
});

test("api：restore 写回停用态的 .disabled（文件现在是停用的就写回那个）", async () => {
  const area = await makePromptArea("api-restore-disabled");
  try {
    await writeAt(area, "workspace/AGENTS.md", "old\n");
    const impl = implOf(area);
    const view = await impl.view(wsAgents(area), { workspace: area.workspace });
    await impl.save({
      id: wsAgents(area),
      content: "new\n",
      baseVersion: view.file.version,
      workspace: area.workspace,
    });
    const trash = await impl.trashList();
    await impl.setEnabled(wsAgents(area), false, { workspace: area.workspace });

    await impl.restore(trash[0]!.trashId, { workspace: area.workspace });
    assert.equal(await fs.readFile(wsAgents(area) + ".disabled", "utf8"), "old\n", "写回停用态那个文件");
    assert.equal(await fs.readFile(wsAgents(area), "utf8").catch(() => undefined), undefined);
  } finally {
    await area.cleanup();
  }
});

test("api：restore 的 fileId 不在本次发现范围 → 409，且不往别处写", async () => {
  const area = await makePromptArea("api-restore-outside");
  try {
    await writeAt(area, "workspace/AGENTS.md", "old\n");
    const impl = implOf(area);
    const view = await impl.view(wsAgents(area), { workspace: area.workspace });
    await impl.save({
      id: wsAgents(area),
      content: "new\n",
      baseVersion: view.file.version,
      workspace: area.workspace,
    });
    const trash = await impl.trashList();

    // 换一个没有这个文件的工作区
    const other = path.join(area.root, "elsewhere");
    await fs.mkdir(other, { recursive: true });
    await expectError(() => impl.restore(trash[0]!.trashId, { workspace: other }), 409, "CONFLICT", "发现范围");
    assert.equal(await fs.readFile(wsAgents(area), "utf8"), "new\n", "原文件没被动过");
    assert.equal((await impl.trashList()).length, 1, "条目还在");
  } finally {
    await area.cleanup();
  }
});

test("api：restore 非法 trashId / 不存在", async () => {
  const area = await makePromptArea("api-restore-bad");
  try {
    const impl = implOf(area);
    await expectError(() => impl.restore(".."), 400, "BAD_REQUEST", "trashId");
    await expectError(() => impl.restore("a/b"), 400, "BAD_REQUEST");
    await expectError(() => impl.restore("nope"), 404, "NOT_FOUND");
  } finally {
    await area.cleanup();
  }
});

test("api：回收站的目录形状（content + meta.json），drop 不递归", async () => {
  const area = await makePromptArea("api-trash-shape");
  try {
    await writeAt(area, "workspace/AGENTS.md", "old\n");
    const impl = implOf(area);
    const view = await impl.view(wsAgents(area), { workspace: area.workspace });
    await impl.save({
      id: wsAgents(area),
      content: "new\n",
      baseVersion: view.file.version,
      workspace: area.workspace,
    });
    const trashId = (await impl.trashList())[0]!.trashId;
    const dir = path.join(area.hubHome, "prompts", "trash", trashId);
    const entries = (await fs.readdir(dir)).sort();
    assert.deepEqual(entries, ["content", "meta.json"]);
    const meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8")) as Record<string, unknown>;
    assert.equal(meta.version, 1);
    assert.equal(meta.trashId, trashId);
    assert.equal(meta.reason, "save");

    // 人为塞一个子目录：drop 必须拒绝（绝不递归删）
    await fs.mkdir(path.join(dir, "nested"));
    await expectError(() => impl.purge(trashId), 500, "INTERNAL", "不递归删除");
  } finally {
    await area.cleanup();
  }
});

test("api：文件被外面删掉后 view/save 给 404（不凭 id 拼路径去读）", async () => {
  const area = await makePromptArea("api-gone");
  try {
    await writeAt(area, "workspace/AGENTS.md", "old\n");
    const impl = implOf(area);
    await fs.unlink(wsAgents(area));
    await expectError(() => impl.view(wsAgents(area), { workspace: area.workspace }), 404, "NOT_FOUND");
    await expectError(
      () => impl.save({ id: wsAgents(area), content: "x", baseVersion: "0", workspace: area.workspace }),
      404,
      "NOT_FOUND",
    );
  } finally {
    await area.cleanup();
  }
});

test("api：PromptFile 的形状完整（id/name/path/displayPath/disabled/size/mtimeMs/version）", async () => {
  const area = await makePromptArea("api-shape");
  try {
    await writeAt(area, "workspace/AGENTS.md", "hello\n");
    const impl = implOf(area);
    const view = await impl.view(wsAgents(area), { workspace: area.workspace });
    const file: PromptFile = view.file;
    assert.equal(file.id, wsAgents(area));
    assert.equal(file.name, "AGENTS.md");
    assert.equal(file.path, wsAgents(area));
    assert.equal(file.displayPath, "AGENTS.md");
    assert.equal(file.disabled, false);
    assert.equal(file.size, 6);
    assert.equal(file.mtimeMs > 0, true);
    assert.match(file.version, /^[0-9a-f]{16}$/);
  } finally {
    await area.cleanup();
  }
});
