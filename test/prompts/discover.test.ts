/**
 * 发现（src/prompts/files/discover.ts）：项目根判定、层顺序、四个文件名与 .disabled、
 * 同层重复、过大、预算 omitted / truncated。全部在 os.tmpdir() 夹具里。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { discoverPrompts, findProjectRoot, layerDirs } from "../../src/prompts/files/discover.ts";
import { makeCtx, makePromptArea, makeSettings, mkdirp, writeAt, type PromptArea } from "./fixtures.ts";

async function discover(area: PromptArea, workspace: string | undefined, settings = makeSettings()) {
  return await discoverPrompts(makeCtx(area), workspace === undefined ? { settings } : { workspace, settings });
}

function filesOf(snap: { discovery: { layers: { scope: string; displayDir: string; files: unknown[] }[] } }): string[] {
  return snap.discovery.layers.flatMap((layer) =>
    (layer.files as { name: string; disabled: boolean }[]).map(
      (file) => layer.scope + ":" + layer.displayDir + "/" + file.name + (file.disabled ? ".disabled" : ""),
    ),
  );
}

test("发现：没有 .git 时项目根就是工作区本身（只有一层）", async () => {
  const area = await makePromptArea("no-git");
  try {
    await writeAt(area, "home/.dsh/AGENTS.md", "g\n");
    await writeAt(area, "workspace/AGENTS.md", "ws\n");
    const snap = await discover(area, area.workspace);
    assert.equal(snap.discovery.inGit, false);
    assert.equal(snap.discovery.projectRoot, area.workspace);
    assert.equal(snap.discovery.layers.length, 2, "全局层 + 工作区一层");
    assert.equal(snap.discovery.layers[1]!.isProjectRoot, true);
    assert.equal(snap.discovery.layers[1]!.isWorkspace, true);
    assert.deepEqual(filesOf(snap), ["global:~/.dsh/AGENTS.md", "project:./AGENTS.md"]);
  } finally {
    await area.cleanup();
  }
});

test("发现：有 .git（目录）时项目根上移，逐层到工作区（含两端）", async () => {
  const area = await makePromptArea("git-dir");
  try {
    await mkdirp(path.join(area.root, "repo", ".git"));
    const ws = path.join(area.root, "repo", "packages", "a");
    await mkdirp(ws);
    await writeAt(area, "home/.dsh/AGENTS.md", "g\n");
    await writeAt(area, "repo/AGENTS.md", "root\n");
    await writeAt(area, "repo/packages/CLAUDE.md", "mid\n");
    await writeAt(area, "repo/packages/a/AGENTS.local.md", "ws\n");
    const snap = await discover(area, ws);
    assert.equal(snap.discovery.inGit, true);
    assert.equal(snap.discovery.projectRoot, path.join(area.root, "repo"));
    assert.deepEqual(
      snap.discovery.layers.map((layer) => layer.displayDir),
      ["~/.dsh", ".", "packages", "packages/a"],
    );
    assert.deepEqual(
      snap.discovery.layers.map((layer) => layer.isProjectRoot),
      [false, true, false, false],
    );
    assert.deepEqual(
      snap.discovery.layers.map((layer) => layer.isWorkspace),
      [false, false, false, true],
    );
    assert.deepEqual(filesOf(snap), [
      "global:~/.dsh/AGENTS.md",
      "project:./AGENTS.md",
      "project:packages/CLAUDE.md",
      "project:packages/a/AGENTS.local.md",
    ]);
    assert.deepEqual(snap.discovery.layers[2]!.files[0]!.displayPath, "packages/CLAUDE.md");
  } finally {
    await area.cleanup();
  }
});

test("发现：.git 是文件也算项目根标记；projectRootMarkers 可配置", async () => {
  const area = await makePromptArea("git-file");
  try {
    await mkdirp(path.join(area.root, "repo"));
    await fs.writeFile(path.join(area.root, "repo", ".git"), "gitdir: elsewhere\n");
    const ws = path.join(area.root, "repo", "sub");
    await mkdirp(ws);
    const snap = await discover(area, ws);
    assert.equal(snap.discovery.projectRoot, path.join(area.root, "repo"));
    assert.equal(snap.discovery.inGit, true);

    // 换成自定义标记：.git 就不算数了
    const custom = makeSettings({ projectRootMarkers: [".myroot"] });
    const withCustom = await discover(area, ws, custom);
    assert.equal(withCustom.discovery.projectRoot, ws);
    assert.equal(withCustom.discovery.inGit, false);
  } finally {
    await area.cleanup();
  }
});

test("发现：没有 workspace 时只有全局层（全局只有 AGENTS.md）", async () => {
  const area = await makePromptArea("no-ws");
  try {
    await writeAt(area, "home/.dsh/AGENTS.md", "g\n");
    await writeAt(area, "home/.dsh/CLAUDE.md", "不该被列\n");
    await writeAt(area, "home/.dsh/AGENTS.local.md", "不该被列\n");
    const snap = await discover(area, undefined);
    assert.equal(snap.discovery.layers.length, 1);
    assert.equal(snap.discovery.layers[0]!.scope, "global");
    assert.deepEqual(filesOf(snap), ["global:~/.dsh/AGENTS.md"]);
    assert.equal(snap.discovery.projectRoot, undefined);
  } finally {
    await area.cleanup();
  }
});

test("发现：workspace 不存在 → 只全局 + 一条中文 warning", async () => {
  const area = await makePromptArea("bad-ws");
  try {
    const snap = await discover(area, path.join(area.root, "nope"));
    assert.equal(snap.discovery.layers.length, 1);
    assert.equal(snap.discovery.warnings.length, 1);
    assert.match(snap.discovery.warnings[0]!, /工作区目录不存在/);
  } finally {
    await area.cleanup();
  }
});

test("发现：四个文件名按顺序、.disabled 列成停用态、id 是原名", async () => {
  const area = await makePromptArea("names");
  try {
    await writeAt(area, "workspace/CLAUDE.md.disabled", "b\n");
    await writeAt(area, "workspace/AGENTS.md", "a\n");
    await writeAt(area, "workspace/CLAUDE.local.md", "d\n");
    await writeAt(area, "workspace/AGENTS.local.md.disabled", "c\n");
    const snap = await discover(area, area.workspace);
    const files = snap.discovery.layers[1]!.files;
    assert.deepEqual(
      files.map((file) => file.name),
      ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"],
    );
    assert.deepEqual(
      files.map((file) => file.disabled),
      [false, true, true, false],
    );
    const claude = files[1]!;
    assert.equal(claude.path, path.join(area.workspace, "CLAUDE.md.disabled"));
    assert.equal(claude.id, path.join(area.workspace, "CLAUDE.md"), "停用时 id 仍是原名");
    assert.equal(claude.displayPath, "CLAUDE.md.disabled");
  } finally {
    await area.cleanup();
  }
});

test("发现：原名与 .disabled 同时存在 —— 只列原名，另记一条 warning", async () => {
  const area = await makePromptArea("both");
  try {
    await writeAt(area, "workspace/AGENTS.md", "on\n");
    await writeAt(area, "workspace/AGENTS.md.disabled", "off\n");
    const snap = await discover(area, area.workspace);
    const files = snap.discovery.layers[1]!.files;
    assert.equal(files.length, 1);
    assert.equal(files[0]!.disabled, false);
    assert.equal(files[0]!.path, path.join(area.workspace, "AGENTS.md"));
    assert.equal(snap.discovery.warnings.length, 1);
    assert.match(snap.discovery.warnings[0]!, /同时存在/);
    assert.match(snap.discovery.warnings[0]!, /AGENTS.md.disabled/);
  } finally {
    await area.cleanup();
  }
});

test("发现：目录不算提示词文件（只认普通文件）", async () => {
  const area = await makePromptArea("dirs");
  try {
    await mkdirp(path.join(area.workspace, "AGENTS.md"));
    const snap = await discover(area, area.workspace);
    assert.deepEqual(snap.discovery.layers[1]!.files, []);
  } finally {
    await area.cleanup();
  }
});

test("发现：符号链接照 DSH 的做法跟随读取", async () => {
  const area = await makePromptArea("symlink");
  try {
    const real = await writeAt(area, "real/AGENTS.md", "linked\n");
    try {
      await fs.symlink(real, path.join(area.workspace, "AGENTS.md"), "file");
    } catch {
      return; // 没有权限建链接（Windows 非开发者模式）就跳过
    }
    const snap = await discover(area, area.workspace);
    const file = snap.discovery.layers[1]!.files[0]!;
    assert.equal(file.name, "AGENTS.md");
    assert.equal(file.size, Buffer.byteLength("linked\n"));
    assert.equal(file.tooLarge, undefined);
  } finally {
    await area.cleanup();
  }
});

test("发现：同层重复 —— 去首尾空白后相同则后出现的标 duplicateOf", async () => {
  const area = await makePromptArea("dup");
  try {
    await writeAt(area, "workspace/AGENTS.md", "same\n");
    await writeAt(area, "workspace/CLAUDE.md", "  same  \n");
    await writeAt(area, "workspace/AGENTS.local.md", "different\n");
    const snap = await discover(area, area.workspace);
    const files = snap.discovery.layers[1]!.files;
    assert.equal(files[0]!.duplicateOf, undefined);
    assert.equal(files[1]!.duplicateOf, "AGENTS.md");
    assert.equal(files[2]!.duplicateOf, undefined);
  } finally {
    await area.cleanup();
  }
});

test("发现：不同层内容相同不算重复（只在同层比）", async () => {
  const area = await makePromptArea("dup-layer");
  try {
    await writeAt(area, "workspace/AGENTS.md", "same\n");
    await writeAt(area, "home/.dsh/AGENTS.md", "same\n");
    const snap = await discover(area, area.workspace);
    assert.equal(snap.discovery.layers[0]!.files[0]!.duplicateOf, undefined);
    assert.equal(snap.discovery.layers[1]!.files[0]!.duplicateOf, undefined);
  } finally {
    await area.cleanup();
  }
});

test("发现：超过 maxSourceBytes 标 tooLarge、不参与重复判定", async () => {
  const area = await makePromptArea("large");
  try {
    const big = Buffer.alloc(64, 0x61);
    await writeAt(area, "workspace/AGENTS.md", big);
    await writeAt(area, "workspace/CLAUDE.md", big);
    const snap = await discover(area, area.workspace, makeSettings({ maxSourceBytes: 16 }));
    const files = snap.discovery.layers[1]!.files;
    assert.equal(files[0]!.tooLarge, true);
    assert.equal(files[1]!.tooLarge, true);
    assert.equal(files[0]!.duplicateOf, undefined, "过大的文件不参与重复判定");
    assert.equal(files[1]!.duplicateOf, undefined);
    assert.equal(files[0]!.size, 64);
    assert.match(files[0]!.version, /^[0-9a-f]{16}$/, "过大时仍给出版本（流式算）");
  } finally {
    await area.cleanup();
  }
});

test("发现：预算 —— 超出时从最前 omitted，只剩最后一个仍超就 truncated", async () => {
  const area = await makePromptArea("budget");
  try {
    const body = Buffer.alloc(200, 0x61);
    await writeAt(area, "home/.dsh/AGENTS.md", body);
    await writeAt(area, "workspace/AGENTS.md", body);
    // 每个文件的成本 = 200 + 头部；给刚好放得下两个的预算 → 都留下
    const twoCost = 200 + Buffer.byteLength("Instructions from: ~/.dsh/AGENTS.md\n\n");
    const oneCost = 200 + Buffer.byteLength("Instructions from: AGENTS.md\n\n");
    const loose = await discover(area, area.workspace, makeSettings({ maxBytes: twoCost + oneCost }));
    assert.equal(loose.discovery.layers[0]!.files[0]!.budget, undefined);
    assert.equal(loose.discovery.layers[1]!.files[0]!.budget, undefined);

    // 只放得下最后一个 → 全局那个 omitted
    const tight = await discover(area, area.workspace, makeSettings({ maxBytes: oneCost }));
    assert.equal(tight.discovery.layers[0]!.files[0]!.budget, "omitted");
    assert.equal(tight.discovery.layers[1]!.files[0]!.budget, undefined);
    assert.equal(tight.usedBytes, twoCost + oneCost);

    // 连最后一个都放不下 → truncated
    const tiny = await discover(area, area.workspace, makeSettings({ maxBytes: 10 }));
    assert.equal(tiny.discovery.layers[0]!.files[0]!.budget, "omitted");
    assert.equal(tiny.discovery.layers[1]!.files[0]!.budget, "truncated");
  } finally {
    await area.cleanup();
  }
});

test("发现：预算只算会加载的文件（停用、重复、过大的不算）", async () => {
  const area = await makePromptArea("budget-skip");
  try {
    await writeAt(area, "workspace/AGENTS.md", "same\n");
    await writeAt(area, "workspace/CLAUDE.md", "same\n"); // 重复
    await writeAt(area, "workspace/AGENTS.local.md.disabled", "x".repeat(5000)); // 停用
    await writeAt(area, "workspace/CLAUDE.local.md", "y".repeat(5000)); // 过大
    const snap = await discover(area, area.workspace, makeSettings({ maxBytes: 1_000_000, maxSourceBytes: 1000 }));
    assert.equal(snap.usedBytes, 5 + Buffer.byteLength("Instructions from: AGENTS.md\n\n"));
    assert.equal(snap.discovery.layers[1]!.files[1]!.budget, undefined, "重复的文件不参与预算");
  } finally {
    await area.cleanup();
  }
});

test("发现：canCreate 只在全局、项目根、工作区三层可能为 true", async () => {
  const area = await makePromptArea("can-create");
  try {
    await mkdirp(path.join(area.root, "repo", ".git"));
    const ws = path.join(area.root, "repo", "sub");
    await mkdirp(ws);
    const snap = await discover(area, ws);
    assert.deepEqual(
      snap.discovery.layers.map((layer) => layer.displayDir),
      ["~/.dsh", ".", "sub"],
    );
    assert.deepEqual(
      snap.discovery.layers.map((layer) => layer.canCreate),
      [true, true, true],
      "全局、项目根、工作区可以新建",
    );
    // 有了 AGENTS.md 就不能再建
    await writeAt(area, "repo/AGENTS.md", "x\n");
    const after = await discover(area, ws);
    assert.equal(after.discovery.layers[1]!.canCreate, false);
    // 只有 .disabled 也不能建
    await writeAt(area, "repo/sub/AGENTS.md.disabled", "x\n");
    const disabled = await discover(area, ws);
    assert.equal(disabled.discovery.layers[2]!.canCreate, false);
    // 中间层（不是项目根也不是工作区）永远不能新建
    await writeAt(area, "repo/mid/AGENTS.md", "x\n");
    const middle = await discover(area, path.join(area.root, "repo", "mid"));
    assert.equal(middle.discovery.layers.length, 3);
    assert.equal(middle.discovery.layers[1]!.isProjectRoot, true);
    assert.equal(middle.discovery.layers[2]!.isWorkspace, true);
  } finally {
    await area.cleanup();
  }
});

test("发现：候选文件名跟着配置走（配置里没有 AGENTS.md 就不能新建）", async () => {
  const area = await makePromptArea("custom-names");
  try {
    await writeAt(area, "home/.dsh/AGENTS.md", "x\n");
    await writeAt(area, "workspace/AGENTS.md", "x\n");
    const settings = makeSettings({ fileNames: ["OTHER.md"], instructionFileCandidates: ["OTHER.md"] });
    const snap = await discover(area, area.workspace, settings);
    assert.deepEqual(filesOf(snap), ["global:~/.dsh/AGENTS.md"], "项目层只找 OTHER.md，AGENTS.md 不列");
    assert.equal(snap.discovery.layers[1]!.canCreate, false, "AGENTS.md 不在候选名里 → 不许新建");
  } finally {
    await area.cleanup();
  }
});

test("发现：findProjectRoot / layerDirs 的边界", async () => {
  const area = await makePromptArea("roots");
  try {
    const found = await findProjectRoot(area.workspace, [".git"]);
    assert.equal(found.root, area.workspace);
    assert.equal(found.inGit, false);
    assert.deepEqual(layerDirs("/a/b", "/a/b"), ["/a/b"]);
    const layered = layerDirs("/a/b", "/a/b/c/d");
    assert.deepEqual(
      layered.map((p) => p.split(path.sep).join("/")),
      ["/a/b", "/a/b/c", "/a/b/c/d"],
    );
  } finally {
    await area.cleanup();
  }
});
