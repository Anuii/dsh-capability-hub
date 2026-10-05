/**
 * FIX-1 回归：平铺 .md 技能（官方「一层深：<dir>/SKILL.md 或 <name>.md」的后者）。
 *
 * 缺陷（界面开发者 T4a-1 发现、调度者核实）：scan.ts 把平铺候选的 path 填成了**所在根目录**，
 * 于是 SkillSummary.path 违背契约（types.ts:34「平铺 .md 技能为该 .md 文件本身的绝对路径」），
 * 后果是 moveToTrash 会用 source = 根目录去 movePath —— 删掉一个平铺技能会把整个技能根移入回收站。
 *
 * 本文件固定修复后的行为：path 是文件、删除只移动该文件、恢复逐字节相同、
 * view 只含它自己、启停只改它、遮蔽与 skillId 正确，以及「目标不得是根 / 不得在根外」的防护。
 * 全部夹具都在 os.tmpdir() 下自建。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { assertTrashTargetInsideRoot, createSkillsLocalImpl } from "../../../src/skills/local/api.ts";
import {
  agentsRoot,
  dshSkillsRoot,
  exists,
  fingerprintDir,
  makeCtx,
  makeLockStashStub,
  makeTempArea,
  readBytes,
  sha256Of,
  skillMd,
  writeFlatSkill,
  writeSkill,
  type TempArea,
  LOCAL_DEPS,
} from "./fixtures.ts";

async function withArea(label: string, fn: (area: TempArea) => Promise<void>): Promise<void> {
  const area = await makeTempArea(label);
  try {
    await fn(area);
  } finally {
    await area.cleanup();
  }
}

/* ---------------- F1：path 契约 ---------------- */

test("平铺技能：list 的 path 是该 .md 文件本身（绝不是技能根），dirName 是文件名", async () => {
  await withArea("flat-list", async (area) => {
    const root = agentsRoot(area);
    const flat = await writeFlatSkill(root, "solo.md", skillMd("solo", "平铺技能"));
    await writeSkill(root, "boxed", skillMd("boxed", "目录技能"));

    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    const list = await impl.list({});
    const byId = new Map(list.skills.map((s) => [s.id, s]));

    const solo = byId.get("user-agents:solo.md");
    assert.ok(solo !== undefined, "平铺 .md 必须被识别为技能");
    assert.equal(solo.path, flat, "path 必须是 .md 文件本身");
    assert.equal(solo.path === root, false, "path 绝不能是技能根目录");
    assert.equal(solo.dirName, "solo.md");
    assert.equal(solo.name, "solo", "name 取自 frontmatter");
    assert.equal(solo.loadable, true);
    assert.equal(solo.modelVisible, true);
    assert.equal(solo.writable, true);

    const boxed = byId.get("user-agents:boxed");
    assert.equal(boxed?.path, path.join(root, "boxed"), "目录型技能的 path 仍是技能目录");
    assert.equal(boxed?.dirName, "boxed");
  });
});

test("平铺技能：view 只返回它自己，绝不列出整个技能根", async () => {
  await withArea("flat-view", async (area) => {
    const root = agentsRoot(area);
    const original = skillMd("solo", "平铺技能") + "\n正文\n";
    const flat = await writeFlatSkill(root, "solo.md", original);
    await writeSkill(root, "other", skillMd("other", "邻居"), { "assets/x.txt": "X" });
    await fs.writeFile(path.join(root, "loose.txt"), "散落文件");

    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    const view = await impl.view("user-agents:solo.md", {});
    assert.equal(view.content, original, "content 必须是这个文件的原文");
    assert.equal(view.skill.path, flat);
    assert.deepEqual(view.files, [{ path: "solo.md", size: Buffer.byteLength(original), isDir: false }]);
    const paths = view.files.map((f) => f.path);
    assert.equal(paths.includes("other"), false, "绝不能列出根里的其他技能目录");
    assert.equal(paths.includes("loose.txt"), false, "绝不能列出根里的其他文件");
    assert.equal(paths.includes("SKILL.md"), false);
  });
});

/* ---------------- F1：删除 / 恢复 / 清空 ---------------- */

test("删除平铺技能：只把这一个 .md 移入回收站，技能根与其他内容逐字节不变", async () => {
  await withArea("flat-delete", async (area) => {
    const root = agentsRoot(area);
    const original = skillMd("solo", "要被删掉的平铺技能");
    const flat = await writeFlatSkill(root, "solo.md", original);
    await writeSkill(root, "keep", skillMd("keep", "必须留下的邻居"), { "assets/a.txt": "A", "refs/b.md": "B" });
    await fs.writeFile(path.join(root, "loose.txt"), "根里的散落文件");

    const before = await fingerprintDir(root);
    assert.equal(before.length > 3, true);

    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    const stash = makeLockStashStub({ "user-agents:solo.md": { source: "owner/repo", skillPath: "solo.md" } });
    impl.bindLockStash(stash);

    const item = await impl.moveToTrash("user-agents:solo.md", { reason: "delete" });
    assert.equal(item.skillId, "user-agents:solo.md");
    assert.equal(item.dirName, "solo.md");
    assert.equal(item.originalPath, flat, "入回收站的必须是这个文件");
    assert.equal(item.hasLockEntry, true);
    assert.equal(stash.calls.length, 1);
    assert.equal(stash.calls[0].op, "take");
    assert.equal(stash.calls[0].path, flat, "LockStash 的 path 参数必须是这个文件");

    assert.equal(await exists(root), true, "技能根必须原封不动");
    assert.equal(await exists(flat), false, "只有这个文件消失");
    assert.equal(await exists(path.join(root, "keep", "SKILL.md")), true);
    assert.equal(await exists(path.join(root, "keep", "assets", "a.txt")), true);
    assert.equal(await exists(path.join(root, "loose.txt")), true);

    const after = await fingerprintDir(root);
    assert.deepEqual(
      after,
      before.filter((e) => e.rel !== "solo.md"),
      "除 solo.md 外根内每一条都必须逐字节不变",
    );

    // 回收站里是一个「文件」而不是目录
    const trashDir = path.join(area.hubHome, "skills", "trash", item.trashId);
    const payload = path.join(trashDir, "payload");
    assert.equal((await fs.lstat(payload)).isFile(), true, "payload 必须是文件（不是整个根目录）");
    assert.equal(await fs.readFile(payload, "utf8"), original);
    const metaRaw = JSON.parse(await fs.readFile(path.join(trashDir, "meta.json"), "utf8"));
    assert.equal(metaRaw.kind, "file");
    assert.equal(metaRaw.originalPath, flat);
    assert.equal(metaRaw.rootPath, root);
    assert.equal(metaRaw.lockEntry.source, "owner/repo");

    const list = await impl.list({});
    assert.deepEqual(
      list.skills.map((s) => s.id),
      ["user-agents:keep"],
    );
  });
});

test("恢复平铺技能：文件回到原处、字节完全相同，其他内容不受影响", async () => {
  await withArea("flat-restore", async (area) => {
    const root = agentsRoot(area);
    const original = Buffer.from(skillMd("solo", "恢复我") + "\nCRLF 之外的普通内容\n", "utf8");
    const flat = await writeFlatSkill(root, "solo.md", original);
    await writeSkill(root, "keep", skillMd("keep", "邻居"), { "assets/a.txt": "A" });

    const before = await fingerprintDir(root);
    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    const stash = makeLockStashStub({ "user-agents:solo.md": { source: "o/r" } });
    impl.bindLockStash(stash);

    const item = await impl.moveToTrash("user-agents:solo.md", { reason: "delete" });
    const restored = await impl.restore(item.trashId, {});
    assert.equal(restored.id, "user-agents:solo.md");
    assert.equal(restored.path, flat, "恢复后 path 仍是这个文件");
    assert.equal(restored.name, "solo");
    assert.equal(restored.description, "恢复我");

    assert.equal(sha256Of(await readBytes(flat)), sha256Of(original), "字节必须完全相同");
    assert.deepEqual(await fingerprintDir(root), before, "整根指纹必须回到删除前");
    assert.equal((await impl.trashList()).length, 0, "恢复后回收站条目应删除");
    assert.equal(stash.calls.filter((c) => c.op === "put").length, 1);
    assert.equal(stash.calls.find((c) => c.op === "put")?.path, flat, "put 的 path 参数也是这个文件");
  });
});

test("恢复平铺技能：原文件已存在 -> CONFLICT；replace=true 的覆盖流程照常", async () => {
  await withArea("flat-restore-replace", async (area) => {
    const root = agentsRoot(area);
    const flat = await writeFlatSkill(root, "solo.md", skillMd("solo", "旧内容"));
    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    const item = await impl.moveToTrash("user-agents:solo.md", { reason: "delete" });

    await writeFlatSkill(root, "solo.md", skillMd("solo", "新内容"));
    await assert.rejects(
      () => impl.restore(item.trashId, {}),
      (error: { status: number; code: string; message: string }) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, "CONFLICT");
        assert.equal(error.message.includes("覆盖"), true);
        assert.equal(error.message.includes("目录/文件"), true, "平铺技能既可能撞目录也可能撞文件，说明里要写清");
        return true;
      },
    );
    assert.equal((await readBytes(flat)).toString("utf8").includes("新内容"), true, "失败时不能动现有文件");

    const restored = await impl.restore(item.trashId, { replace: true });
    assert.equal(restored.description, "旧内容");
    assert.equal((await readBytes(flat)).toString("utf8").includes("旧内容"), true);

    const items = await impl.trashList();
    assert.equal(items.length, 1, "被覆盖的新文件应进回收站");
    assert.equal(items[0].reason, "replace");
    assert.equal(items[0].skillId, "user-agents:solo.md");
    const replaced = path.join(area.hubHome, "skills", "trash", items[0].trashId, "payload");
    assert.equal((await fs.lstat(replaced)).isFile(), true, "被覆盖的平铺技能也是一个文件");
    assert.equal((await fs.readFile(replaced, "utf8")).includes("新内容"), true);
  });
});

test("平铺技能：purge 只清回收站条目，技能根不受影响", async () => {
  await withArea("flat-purge", async (area) => {
    const root = agentsRoot(area);
    await writeFlatSkill(root, "solo.md", skillMd("solo", "d"));
    await writeSkill(root, "keep", skillMd("keep", "邻居"));
    const before = await fingerprintDir(root);

    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    const item = await impl.moveToTrash("user-agents:solo.md", { reason: "delete" });
    assert.equal(await impl.purge(item.trashId), 1);
    assert.equal(await exists(path.join(area.hubHome, "skills", "trash", item.trashId)), false);
    assert.deepEqual(
      await fingerprintDir(root),
      before.filter((e) => e.rel !== "solo.md"),
    );
    assert.equal(await exists(root), true);
  });
});

/* ---------------- F1：启停 ---------------- */

test("启停平铺技能：只改这个 .md 文件，根内其他文件字节不变", async () => {
  await withArea("flat-toggle", async (area) => {
    const root = agentsRoot(area);
    const original = skillMd("solo", "平铺技能");
    const flat = await writeFlatSkill(root, "solo.md", original);
    await writeSkill(root, "keep", skillMd("keep", "邻居"), { "assets/a.txt": "A" });
    await fs.writeFile(path.join(root, "loose.txt"), "散落");
    const before = await fingerprintDir(root);

    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    const off = await impl.setEnabled("user-agents:solo.md", false, {});
    assert.equal(off.modelInvocationDisabled, true);
    assert.equal(off.modelVisible, false);

    const written = await readBytes(flat);
    assert.equal(written.toString("utf8"), skillMd("solo", "平铺技能", ["disable-model-invocation: true"]));
    assert.equal(written.length, Buffer.byteLength(original) + Buffer.byteLength("disable-model-invocation: true\n"));
    assert.deepEqual(
      (await fingerprintDir(root)).filter((e) => e.rel !== "solo.md"),
      before.filter((e) => e.rel !== "solo.md"),
      "启停只能动这一个文件",
    );

    // 「只改一行」语义：启用不删除该键，只把取值改回 false（与目录型技能一致）
    const on = await impl.setEnabled("user-agents:solo.md", true, {});
    assert.equal(on.modelInvocationDisabled, false);
    assert.equal(
      (await readBytes(flat)).toString("utf8"),
      skillMd("solo", "平铺技能", ["disable-model-invocation: false"]),
    );
    assert.deepEqual(
      (await fingerprintDir(root)).filter((e) => e.rel !== "solo.md"),
      before.filter((e) => e.rel !== "solo.md"),
      "整个启停往返都只能动这一个文件",
    );
  });
});

/* ---------------- skillId 与遮蔽 ---------------- */

test("平铺与目录同名（跨根）：skillId 各自独立，遮蔽按根优先级", async () => {
  await withArea("flat-shadow-cross", async (area) => {
    await writeSkill(dshSkillsRoot(area), "dup", skillMd("dup", "user-dsh 的目录型"));
    await writeFlatSkill(agentsRoot(area), "dup.md", skillMd("dup", "user-agents 的平铺型"));

    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    const list = await impl.list({});
    const byId = new Map(list.skills.map((s) => [s.id, s]));

    const winner = byId.get("user-dsh:dup");
    const loser = byId.get("user-agents:dup.md");
    assert.ok(winner !== undefined && loser !== undefined, "两个条目的 skillId 必须各自独立");
    assert.equal(winner.shadowedBy, undefined);
    assert.equal(winner.modelVisible, true);
    assert.equal(loser.shadowedBy, "user-dsh:dup", "跨根同名按 frontmatter name 遮蔽，优先级小者胜");
    assert.equal(loser.modelVisible, false);
    assert.equal(
      loser.diagnostics.some((d) => d.code === "SHADOWED_BY_HIGHER_PRIORITY"),
      true,
    );
  });
});

test("平铺与目录同名（同根）：两个 id 并存，先扫到的目录型胜出", async () => {
  await withArea("flat-shadow-same", async (area) => {
    const root = agentsRoot(area);
    await writeSkill(root, "dup", skillMd("dup", "目录型"));
    await writeFlatSkill(root, "dup.md", skillMd("dup", "平铺型"));

    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    const list = await impl.list({});
    const byId = new Map(list.skills.map((s) => [s.id, s]));
    assert.equal(byId.has("user-agents:dup"), true);
    assert.equal(byId.has("user-agents:dup.md"), true, "同根下两者 id 不同，都必须被列出");
    // 同优先级并列时由扫描顺序（readdir 名排序：'dup' 在 'dup.md' 之前）决定
    assert.equal(byId.get("user-agents:dup")?.modelVisible, true);
    assert.equal(byId.get("user-agents:dup.md")?.shadowedBy, "user-agents:dup");
    assert.equal(byId.get("user-agents:dup.md")?.modelVisible, false);
  });
});

/* ---------------- 根目录下的非技能 .md ---------------- */

test("根目录下的非技能 .md（README.md）：按官方规则由 frontmatter 决定能否加载", async () => {
  await withArea("flat-readme", async (area) => {
    const root = agentsRoot(area);
    const readme = await writeFlatSkill(root, "README.md", "# 说明\n\n这不是技能，没有 frontmatter。\n");
    const good = await writeFlatSkill(root, "notes.md", skillMd("notes", "有 frontmatter 的平铺技能"));

    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    const list = await impl.list({});
    const byId = new Map(list.skills.map((s) => [s.id, s]));

    const readmeSkill = byId.get("user-agents:README.md");
    assert.ok(readmeSkill !== undefined, "官方会把它当作候选交给解析器，因此本插件也要把它列出来（并给出诊断）");
    assert.equal(readmeSkill.path, readme);
    assert.equal(readmeSkill.loadable, false, "没有 frontmatter -> 官方丢弃该技能");
    assert.equal(readmeSkill.modelVisible, false);
    assert.equal(
      readmeSkill.diagnostics.some((d) => d.code === "FRONTMATTER_MISSING"),
      true,
    );
    assert.equal(
      readmeSkill.diagnostics.some((d) => d.code === "NAME_MISMATCH_DIR"),
      false,
      "平铺技能不该报「目录名与 name 不同」",
    );

    const notes = byId.get("user-agents:notes.md");
    assert.equal(notes?.path, good);
    assert.equal(notes?.loadable, true);
    assert.equal(notes?.name, "notes");

    // 删掉 README.md 也只是移动这一个文件
    const item = await impl.moveToTrash("user-agents:README.md", { reason: "delete" });
    assert.equal(item.originalPath, readme);
    assert.equal(await exists(root), true);
    assert.equal(await exists(good), true, "同根的另一个平铺技能必须还在");
  });
});

/* ---------------- F2：防护 ---------------- */

function expectGuardReject(target: unknown, rootPath: unknown, status: number, code: string, contains: string): void {
  try {
    assertTrashTargetInsideRoot(target, rootPath, "删除");
  } catch (error) {
    const e = error as { status: number; code: string; message: string };
    assert.equal(
      e.status,
      status,
      "状态码应为 " + String(status) + "，实际 " + String(e.status) + "（" + e.message + "）",
    );
    assert.equal(e.code, code);
    assert.equal(e.message.includes(contains), true, "说明必须包含「" + contains + "」：" + e.message);
    return;
  }
  assert.fail("预期被拒绝，但没有抛错：" + String(target));
}

test("防护：目标等于技能根 / 不在根内一律拒绝，根内条目放行", async () => {
  await withArea("flat-guard-unit", async (area) => {
    const root = agentsRoot(area);
    await writeSkill(root, "keep", skillMd("keep", "d"));

    // 放行：根本身之下的一切（不要求存在，只判定词法位置）
    assert.doesNotThrow(() => assertTrashTargetInsideRoot(path.join(root, "demo"), root, "删除"));
    assert.doesNotThrow(() => assertTrashTargetInsideRoot(path.join(root, "demo.md"), root, "删除"));
    assert.doesNotThrow(() => assertTrashTargetInsideRoot(path.join(root, "a", "b.md"), root, "删除"));
    assert.doesNotThrow(() => assertTrashTargetInsideRoot(path.join(root, "keep", "SKILL.md"), root, "删除"));

    // 反例 1：就是技能根本身（含带尾分隔符、大小写不同等变体）-> CONFLICT(409)
    expectGuardReject(root, root, 409, "CONFLICT", "技能根本身");
    expectGuardReject(root + path.sep, root, 409, "CONFLICT", "技能根本身");
    expectGuardReject(root.toUpperCase(), root, 409, "CONFLICT", "技能根本身");
    expectGuardReject(path.relative(process.cwd(), root), root, 409, "CONFLICT", "整个技能根");

    // 反例 2：不在根内 -> INTERNAL(500)
    expectGuardReject(path.join(root, ".."), root, 500, "INTERNAL", "不在技能根");
    expectGuardReject(path.join(area.root, "elsewhere"), root, 500, "INTERNAL", "不在技能根");
    expectGuardReject(root + "-sibling" + path.sep + "demo", root, 500, "INTERNAL", "不在技能根");
    expectGuardReject(path.dirname(root), root, 500, "INTERNAL", "不在技能根");

    // 反例 3：空值/非字符串 -> INTERNAL(500)，绝不静默通过
    expectGuardReject("", root, 500, "INTERNAL", "目标路径为空");
    expectGuardReject(undefined, root, 500, "INTERNAL", "目标路径为空");
    expectGuardReject(null, root, 500, "INTERNAL", "目标路径为空");
    expectGuardReject(root + path.sep + "demo", "", 500, "INTERNAL", "无法确定技能根路径");
    expectGuardReject(root + path.sep + "demo", undefined, 500, "INTERNAL", "无法确定技能根路径");
  });
});

/** 手工造一条回收站条目（模拟被篡改/历史遗留的 meta.json）。 */
async function forgeTrash(area: TempArea, trashId: string, meta: Record<string, unknown>): Promise<string> {
  const dir = path.join(area.hubHome, "skills", "trash", trashId);
  await fs.mkdir(path.join(dir, "payload"), { recursive: true });
  await fs.writeFile(path.join(dir, "payload", "marker.txt"), "payload");
  await fs.writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ version: 1, trashId, deletedAt: new Date().toISOString(), hasLockEntry: false, ...meta }),
  );
  return dir;
}

test("防护（端到端）：伪造 originalPath 等于技能根的历史条目，restore 被拒绝且根一个字节没动", async () => {
  await withArea("flat-guard-restore-root", async (area) => {
    const root = agentsRoot(area);
    await writeFlatSkill(root, "solo.md", skillMd("solo", "平铺"));
    await writeSkill(root, "keep", skillMd("keep", "邻居"), { "assets/a.txt": "A" });
    const before = await fingerprintDir(root);

    const trashId = "forged-root";
    const dir = await forgeTrash(area, trashId, {
      skillId: "user-agents:solo.md",
      rootId: "user-agents",
      dirName: "solo.md",
      originalPath: root, // ← 就是修复前 scan.ts 会填进 SkillSummary.path 的那个值
      rootPath: root,
      reason: "delete",
      kind: "dir",
    });

    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    await assert.rejects(
      () => impl.restore(trashId, {}),
      (error: { status: number; code: string; message: string }) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, "CONFLICT");
        assert.equal(error.message.includes("技能根本身"), true);
        assert.equal(error.message.includes("回收站"), true, "必须说清后果：会把整个技能根移入回收站");
        return true;
      },
    );
    assert.deepEqual(await fingerprintDir(root), before, "被拒绝时技能根必须一个字节都没动");
    assert.equal(await exists(path.join(dir, "payload", "marker.txt")), true, "回收站内容也不能被动过");
    assert.equal((await impl.trashList()).length, 1, "被拒绝时不能把条目 drop 掉");

    // replace=true 也照样拒绝（不能靠「覆盖」绕过防护）
    await assert.rejects(
      () => impl.restore(trashId, { replace: true }),
      (error: { status: number; code: string }) => {
        assert.equal(error.status, 409);
        assert.equal(error.code, "CONFLICT");
        return true;
      },
    );
    assert.deepEqual(await fingerprintDir(root), before);
  });
});

test("防护（端到端）：伪造指向技能根之外的 originalPath，restore 被拒绝（INTERNAL）", async () => {
  await withArea("flat-guard-restore-outside", async (area) => {
    const root = agentsRoot(area);
    await writeFlatSkill(root, "solo.md", skillMd("solo", "平铺"));
    const before = await fingerprintDir(root);

    const outside = path.join(area.root, "outside-target");
    const trashId = "forged-outside";
    const dir = await forgeTrash(area, trashId, {
      skillId: "user-agents:solo.md",
      rootId: "user-agents",
      dirName: "solo.md",
      originalPath: outside,
      rootPath: root,
      reason: "delete",
      kind: "file",
    });

    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    await assert.rejects(
      () => impl.restore(trashId, {}),
      (error: { status: number; code: string; message: string }) => {
        assert.equal(error.status, 500);
        assert.equal(error.code, "INTERNAL");
        assert.equal(error.message.includes("不在技能根"), true);
        return true;
      },
    );
    assert.equal(await exists(outside), false, "绝不能把内容恢复到技能根之外");
    assert.deepEqual(await fingerprintDir(root), before);
    assert.equal(await exists(path.join(dir, "payload", "marker.txt")), true);
  });
});
