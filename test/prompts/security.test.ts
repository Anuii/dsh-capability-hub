/**
 * 越权（安全红线，契约注释最后一段）：所有接受 id 的路由，id 必须是本次发现结果里某个文件的 id；
 * 任何别的路径一律被拒，且**不读不写**。逐条覆盖 ..\ 拼接、绝对路径到别的文件、workspace 外的 AGENTS.md。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createPromptsFilesImpl } from "../../src/prompts/files/api.ts";
import { makeCtx, makePromptArea, makeSettings, writeAt, type PromptArea } from "./fixtures.ts";

interface HttpError {
  status: number;
  code: string;
  message: string;
}

function implOf(area: PromptArea) {
  return createPromptsFilesImpl(makeCtx(area), { settings: () => makeSettings() });
}

async function expectRejected(fn: () => Promise<unknown>, label: string): Promise<HttpError> {
  try {
    await fn();
  } catch (error) {
    const e = error as HttpError;
    assert.equal(e.status, 404, label + "：状态码应为 404，实际 " + String(e.status) + "（" + e.message + "）");
    assert.equal(e.code, "NOT_FOUND", label + "：错误码应为 NOT_FOUND");
    return e;
  }
  throw new Error(label + "：预期被拒，但没有抛出");
}

/** 目录内容的指纹（相对路径 + 内容哈希），用来断言「没读没写」。 */
async function fingerprint(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : prefix + "/" + entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        out.push(rel + "|d");
        await visit(abs, rel);
      } else {
        out.push(rel + "|f|" + (await fs.readFile(abs)).toString("base64"));
      }
    }
  }
  await visit(root, "");
  return out;
}

test("越权：id 是 workspace 之外的 AGENTS.md → 404，不读不写", async () => {
  const area = await makePromptArea("sec-outside");
  try {
    // 这个文件在 workspace 的兄弟目录里，不在发现范围内
    const outside = await writeAt(area, "outside/AGENTS.md", "secret\n");
    const inside = await writeAt(area, "workspace/AGENTS.md", "ok\n");
    const impl = implOf(area);
    const before = await fingerprint(area.root);

    await expectRejected(() => impl.view(outside, { workspace: area.workspace }), "view 外部文件");
    await expectRejected(
      () => impl.save({ id: outside, content: "hacked", baseVersion: "0", workspace: area.workspace }),
      "save 外部文件",
    );
    await expectRejected(() => impl.setEnabled(outside, false, { workspace: area.workspace }), "set-enabled 外部文件");

    assert.deepEqual(await fingerprint(area.root), before, "被拒的请求不得改动任何文件");
    assert.equal(await fs.readFile(outside, "utf8"), "secret\n");
    assert.equal(await fs.readFile(inside, "utf8"), "ok\n");
  } finally {
    await area.cleanup();
  }
});

test("越权：.. 拼接出的路径 → 404（id 不参与路径拼接，只做集合查找）", async () => {
  const area = await makePromptArea("sec-dotdot");
  try {
    const outside = await writeAt(area, "outside/AGENTS.md", "secret\n");
    await writeAt(area, "workspace/AGENTS.md", "ok\n");
    const impl = implOf(area);
    const before = await fingerprint(area.root);

    const candidates = [
      path.join(area.workspace, "..", "outside", "AGENTS.md"),
      path.join(area.workspace, "..", "..", "AGENTS.md"),
      path.join(area.workspace, "sub", "..", "..", "outside", "AGENTS.md"),
      "..\\outside\\AGENTS.md",
      "....//....//AGENTS.md",
    ];
    for (const id of candidates) {
      await expectRejected(() => impl.view(id, { workspace: area.workspace }), "view " + id);
      await expectRejected(
        () => impl.save({ id, content: "hacked", baseVersion: "0", workspace: area.workspace }),
        "save " + id,
      );
      await expectRejected(() => impl.setEnabled(id, false, { workspace: area.workspace }), "set-enabled " + id);
    }
    assert.deepEqual(await fingerprint(area.root), before);
    assert.equal(await fs.readFile(outside, "utf8"), "secret\n");
  } finally {
    await area.cleanup();
  }
});

test("越权：绝对路径指向别的文件（全局 AGENTS.md 之外的任何文件）→ 404", async () => {
  const area = await makePromptArea("sec-absolute");
  try {
    await writeAt(area, "home/.dsh/AGENTS.md", "global\n");
    await writeAt(area, "home/.dsh/settings.json", '{"secret":true}\n');
    await writeAt(area, "workspace/notes.md", "notes\n");
    await writeAt(area, "workspace/AGENTS.local.md", "local\n");
    const impl = implOf(area);
    const before = await fingerprint(area.root);

    const ids = [
      path.join(area.dshHome, "settings.json"),
      path.join(area.workspace, "notes.md"),
      path.join(area.homeDir, ".agents", "AGENTS.md"),
      path.join(area.root, "AGENTS.md"),
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
      "AGENTS.md",
    ];
    for (const id of ids) {
      await expectRejected(() => impl.view(id, { workspace: area.workspace }), "view " + JSON.stringify(id));
      await expectRejected(
        () => impl.save({ id, content: "hacked", baseVersion: "0", workspace: area.workspace }),
        "save " + JSON.stringify(id),
      );
    }

    // 空 id / 全空白 id：缺必填参数 → 400（也不读不写）
    for (const id of ["", "   "]) {
      for (const call of [
        () => impl.view(id, { workspace: area.workspace }),
        () => impl.save({ id, content: "hacked", baseVersion: "0", workspace: area.workspace }),
        () => impl.setEnabled(id, false, { workspace: area.workspace }),
      ]) {
        try {
          await call();
          throw new Error("预期被拒：" + JSON.stringify(id));
        } catch (error) {
          const e = error as HttpError;
          assert.equal(e.status, 400, JSON.stringify(id) + " 应为 400，实际 " + String(e.status));
          assert.equal(e.code, "BAD_REQUEST");
        }
      }
    }
    assert.deepEqual(await fingerprint(area.root), before);
    assert.equal(await fs.readFile(path.join(area.dshHome, "settings.json"), "utf8"), '{"secret":true}\n');
  } finally {
    await area.cleanup();
  }
});

test("越权：换一个 workspace 后，旧 workspace 的 id 一律被拒", async () => {
  const area = await makePromptArea("sec-other-ws");
  try {
    await writeAt(area, "workspace/AGENTS.md", "a\n");
    const other = path.join(area.root, "other");
    await fs.mkdir(other, { recursive: true });
    await writeAt(area, "other/AGENTS.md", "b\n");
    const impl = implOf(area);
    const before = await fingerprint(area.root);
    await expectRejected(
      () => impl.view(path.join(area.workspace, "AGENTS.md"), { workspace: other }),
      "跨工作区 view",
    );
    await expectRejected(
      () => impl.setEnabled(path.join(area.workspace, "AGENTS.md"), false, { workspace: other }),
      "跨工作区 set-enabled",
    );
    assert.deepEqual(await fingerprint(area.root), before);
  } finally {
    await area.cleanup();
  }
});

test("越权：停用态文件的 id 只能是「原名」；直接传 .disabled 路径被拒", async () => {
  const area = await makePromptArea("sec-disabled-id");
  try {
    await writeAt(area, "workspace/CLAUDE.md.disabled", "off\n");
    const impl = implOf(area);
    const before = await fingerprint(area.root);
    await expectRejected(
      () => impl.view(path.join(area.workspace, "CLAUDE.md.disabled"), { workspace: area.workspace }),
      "用 .disabled 路径当 id",
    );
    assert.deepEqual(await fingerprint(area.root), before);

    // 用「原名」是合法的
    const view = await impl.view(path.join(area.workspace, "CLAUDE.md"), { workspace: area.workspace });
    assert.equal(view.file.disabled, true);
    assert.equal(view.content, "off\n");
  } finally {
    await area.cleanup();
  }
});

test("越权：create 只认三个枚举位置，别的字符串/对象/数组都被拒", async () => {
  const area = await makePromptArea("sec-create");
  try {
    const impl = implOf(area);
    const before = await fingerprint(area.root);
    const bad: unknown[] = [
      "global/../workspace",
      "../../etc",
      "C:\\Windows",
      "GLOBAL",
      "projectRoot",
      "",
      null,
      0,
      ["global"],
      { location: "global" },
    ];
    for (const location of bad) {
      try {
        await impl.create(location as never);
        throw new Error("预期被拒：" + JSON.stringify(location));
      } catch (error) {
        const e = error as HttpError;
        assert.equal(e.status, 400, JSON.stringify(location) + " 应为 400，实际 " + String(e.status));
        assert.equal(e.code, "BAD_REQUEST");
      }
    }
    assert.deepEqual(await fingerprint(area.root), before, "被拒的 create 不得落任何文件");
  } finally {
    await area.cleanup();
  }
});

test("越权：回收站 trashId 不接受路径穿越（restore / purge 都不动别处）", async () => {
  const area = await makePromptArea("sec-trashid");
  try {
    await writeAt(area, "workspace/AGENTS.md", "old\n");
    const impl = implOf(area);
    const view = await impl.view(path.join(area.workspace, "AGENTS.md"), { workspace: area.workspace });
    await impl.save({
      id: path.join(area.workspace, "AGENTS.md"),
      content: "new\n",
      baseVersion: view.file.version,
      workspace: area.workspace,
    });
    const before = await fingerprint(area.root);
    for (const trashId of ["..", ".", "../..", "a/b", "a\\b", ".hidden", "x".repeat(65), ""]) {
      try {
        await impl.restore(trashId, { workspace: area.workspace });
        throw new Error("预期被拒：" + trashId);
      } catch (error) {
        const e = error as HttpError;
        assert.equal(e.status, 400, trashId + " 应为 400");
        assert.equal(e.code, "BAD_REQUEST");
      }
      try {
        await impl.purge(trashId);
        throw new Error("预期被拒：" + trashId);
      } catch (error) {
        const e = error as HttpError;
        assert.equal(e.status, 400, trashId + " 应为 400");
      }
    }
    assert.deepEqual(await fingerprint(area.root), before);
  } finally {
    await area.cleanup();
  }
});

test("越权：源码里没有硬编码的真实用户路径，也不自行调用 os.homedir()", async () => {
  const dir = path.join(process.cwd(), "src", "prompts");
  const names = await fs.readdir(dir, { recursive: true });
  for (const name of names) {
    if (!name.endsWith(".ts")) continue;
    const text = await fs.readFile(path.join(dir, name), "utf8");
    const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/C:[\\/]Users/i.test(withoutComments), false, name + " 不应出现硬编码的 C:\\Users 路径");
    assert.equal(withoutComments.includes("homedir()"), false, name + " 不应自行调用 os.homedir()");
  }
});
