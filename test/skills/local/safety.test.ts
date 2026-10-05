import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSkillsLocalImpl } from "../../../src/skills/local/api.ts";
import { agentsRoot, makeCtx, makeLockStashStub, makeTempArea, skillMd, writeSkill, LOCAL_DEPS } from "./fixtures.ts";

/**
 * 安全红线（PLAN §4）可执行核对：
 * 跑完整套读写 API（用临时 ctx）前后，对真实用户目录做指纹比对，必须逐字节不变。
 * 只读，不写入任何真实目录；真实目录不存在时自动跳过。
 */

const REAL_WATCH = [
  path.join(os.homedir(), ".agents"),
  path.join(os.homedir(), ".dsh", "skills"),
  path.join(os.homedir(), ".dsh", "storages", "dsh-capability-hub"),
  path.join(os.homedir(), ".cc-switch", ".dsh-capability-hub-sentinel"),
];

async function fingerprint(root: string, limit = 4000): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      const rel = prefix === "" ? entry.name : prefix + "/" + entry.name;
      const abs = path.join(dir, entry.name);
      let st;
      try {
        st = await fs.lstat(abs);
      } catch {
        out.push(rel + "|missing");
        continue;
      }
      out.push(rel + "|" + String(st.size) + "|" + String(st.mtimeMs) + "|" + (st.isDirectory() ? "d" : "f"));
      if (st.isDirectory() && !st.isSymbolicLink()) await visit(abs, rel);
    }
  }
  await visit(root, "");
  return out;
}

async function snapshotAll(): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  for (const root of REAL_WATCH) {
    try {
      await fs.stat(root);
    } catch {
      continue;
    }
    map.set(root, await fingerprint(root));
  }
  return map;
}

test("安全红线：整套读写 API 前后，真实用户目录指纹不变", async () => {
  const before = await snapshotAll();
  const area = await makeTempArea("safety");
  try {
    // 用临时 ctx 跑完整套读写路径
    await writeSkill(agentsRoot(area), "alpha", skillMd("alpha", "a"));
    await writeSkill(agentsRoot(area), "beta", skillMd("beta", "b", ["disable-model-invocation: true"]));
    await writeSkill(agentsRoot(area), "gamma", "\uFEFF---\nname: gamma\ndescription: g\n---\n");
    const impl = createSkillsLocalImpl(makeCtx(area), LOCAL_DEPS);
    impl.bindLockStash(makeLockStashStub({ "user-agents:alpha": { source: "x/y" } }));

    await impl.list({ workspace: area.workspace });
    await impl.get("user-agents:alpha", {});
    await impl.view("user-agents:alpha", {});
    await impl.setEnabled("user-agents:beta", true, {});
    await impl.setEnabled("user-agents:alpha", false, {});
    await assert.rejects(
      () => impl.setEnabled("user-agents:gamma", false, {}),
      (e: { code: string }) => e.code === "CONFLICT",
    );
    const item = await impl.moveToTrash("user-agents:alpha", { reason: "delete" });
    await impl.trashList();
    await impl.restore(item.trashId, {});
    await impl.moveToTrash("user-agents:beta", { reason: "delete" });
    await impl.purge();

    // 改动必须全部落在临时目录
    assert.equal(
      await fs.stat(path.join(area.hubHome, "skills", "trash")).then(
        () => true,
        () => false,
      ),
      true,
    );
  } finally {
    await area.cleanup();
  }

  const after = await snapshotAll();
  assert.deepEqual([...after.keys()], [...before.keys()], "被监测的真实目录集合不应变化");
  for (const [root, entries] of before) {
    assert.deepEqual(after.get(root), entries, "真实目录内容发生了变化：" + root);
  }
});

test("安全红线：源码里没有硬编码的真实用户路径", async () => {
  const dir = path.join(process.cwd(), "src", "skills", "local");
  const files = await fs.readdir(dir);
  for (const name of files) {
    if (!name.endsWith(".ts")) continue;
    const text = await fs.readFile(path.join(dir, name), "utf8");
    // types.ts 里的 "os.homedir()" 只出现在注释中（描述契约），代码里不得真的调用
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/C:[\\/]Users/i.test(withoutComments), false, name + " 不应出现硬编码的 C:\\Users 路径");
    assert.equal(
      withoutComments.includes("homedir()"),
      false,
      name + " 不应自行调用 os.homedir()，homeDir 必须由注入的 HubContext 提供",
    );
  }
});
