/**
 * FIX-5：回收站 trashId 的格式校验（restore / purge）。
 *
 * 之前的校验只拒绝 "/" 与 "\"，"." / ".." 能穿过 —— trash.dirOf(id) 是
 * path.join(回收站根, id)，".." 会把目标指到回收站根之外。这里固定新的判据：
 * 必须是「安全单段名」；同时兼容历史/手工写下的条目（非时间戳形态但仍是安全单段）。
 *
 * 全程只用 os.tmpdir() 下的临时目录（PLAN §4 红线）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createSkillsLocalImpl } from "../../../src/skills/local/api.ts";
import { TRASH_ID_PATTERN, isValidTrashId, newTrashId } from "../../../src/skills/local/trash.ts";
import { agentsRoot, makeCtx, makeTempArea, skillMd, writeSkill, type TempArea, LOCAL_DEPS } from "./fixtures.ts";

async function withArea(label: string, fn: (area: TempArea) => Promise<void>): Promise<void> {
  const area = await makeTempArea(label);
  try {
    await fn(area);
  } finally {
    await area.cleanup();
  }
}

const BAD_IDS: string[] = [
  ".",
  "..",
  "../evil",
  "..\\evil",
  "a/b",
  "a\\b",
  "/abs",
  "C:\\abs",
  "",
  "   ",
  ".hidden",
  "evil\u0000",
  "x".repeat(65),
];

function is400(error: { status: number; code: string; message: string }): boolean {
  assert.equal(error.status, 400);
  assert.equal(error.code, "BAD_REQUEST");
  assert.match(error.message, /trashId/);
  assert.match(error.message, /[一-龥]/, "错误说明必须是中文");
  return true;
}

test('FIX-5 trashId：restore / purge 拒绝 "." / ".." / 路径分隔符 / 控制字符 / 超长', async () => {
  await withArea("fix5-trashid-bad", async (area) => {
    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    for (const bad of BAD_IDS) {
      await assert.rejects(() => impl.restore(bad, {}), is400, "restore 必须拒绝：" + JSON.stringify(bad));
      await assert.rejects(() => impl.purge(bad), is400, "purge 必须拒绝：" + JSON.stringify(bad));
    }
    // 合法形态：newTrashId 的输出必须通过校验（且符合时间戳形态），只是找不到条目 → 404
    const id = newTrashId();
    assert.match(id, /^[0-9TZ]+-[a-z0-9]{1,12}$/, "newTrashId 的输出形态");
    assert.equal(TRASH_ID_PATTERN.test(id), true);
    assert.equal(isValidTrashId(id), true);
    await assert.rejects(
      () => impl.restore(id, {}),
      (error: { status: number }) => {
        assert.equal(error.status, 404);
        return true;
      },
    );
    await assert.rejects(
      () => impl.purge(id),
      (error: { status: number }) => {
        assert.equal(error.status, 404);
        return true;
      },
    );
  });
});

test("FIX-5 trashId：真实条目照常删除 → 恢复 / 清理（校验不能误伤正常流程）", async () => {
  await withArea("fix5-trashid-ok", async (area) => {
    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    await writeSkill(agentsRoot(area), "demo", skillMd("demo", "d"));
    const item = await impl.moveToTrash("user-agents:demo", { reason: "delete" });
    assert.equal(isValidTrashId(item.trashId), true, "真实 trashId 必须通过校验");
    const restored = await impl.restore(item.trashId, {});
    assert.equal(restored.id, "user-agents:demo");

    const again = await impl.moveToTrash("user-agents:demo", { reason: "delete" });
    assert.equal(await impl.purge(again.trashId), 1);
  });
});

test("FIX-5 trashId：历史/手工条目（非时间戳形态但仍是安全单段名）照常可恢复", async () => {
  await withArea("fix5-trashid-legacy", async (area) => {
    const root = agentsRoot(area);
    await fs.mkdir(root, { recursive: true });
    const trashId = "legacy-2026-entry";
    const dir = path.join(area.hubHome, "skills", "trash", trashId);
    await fs.mkdir(path.join(dir, "payload"), { recursive: true });
    await fs.writeFile(path.join(dir, "payload", "SKILL.md"), skillMd("legacy", "d"));
    await fs.writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({
        version: 1,
        trashId,
        skillId: "user-agents:legacy",
        rootId: "user-agents",
        dirName: "legacy",
        originalPath: path.join(root, "legacy"),
        rootPath: root,
        reason: "delete",
        deletedAt: new Date().toISOString(),
        hasLockEntry: false,
        kind: "dir",
      }),
    );
    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    const restored = await impl.restore(trashId, {});
    assert.equal(restored.id, "user-agents:legacy");
    assert.equal(await fs.readFile(path.join(root, "legacy", "SKILL.md"), "utf8"), skillMd("legacy", "d"));
  });
});
