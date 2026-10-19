/**
 * D-B18：检查更新比 GitHub 目录指纹；安装 / 更新只下载技能目录；GitHub 镜像。
 *
 * 全部用假 fetch（helpers.ts / treefixture.ts 的夹具），不碰网络、不碰真实用户目录。
 * 验收标准 a–i 逐条对应下面的分节标题。
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { fingerprintKey } from "../../../src/skills/remote/fingerprints.ts";
import { normalizeMirror } from "../../../src/skills/remote/settings.ts";
import {
  applyMirror,
  ghCandidatePaths,
  ghAuthToken,
  isApiUrl,
  isExecutableMissing,
  isMirroredUrl,
} from "../../../src/skills/remote/github.ts";
import { archiveInstalledHash, jsonResponse, readTree, tarGzOf, writeTree } from "./helpers.ts";
import { repoArchive, skillFixture } from "./tarfixture.ts";
import { buildTreeFixture, fixtureHash, rawRoutes, tarGzHash, treeRoutes } from "./treefixture.ts";
import { buildRemoteEnv, callsMatching, lockEntry } from "./env.ts";
import type { FixtureEntry } from "./tarfixture.ts";

const REPO = "acme/tools";
const OTHER_REPO = "acme/other";
const SKILL_DIR = "skills/productivity/grilling";
const SKILL_PATH = `${SKILL_DIR}/SKILL.md`;
const HASH = (char: string): string => char.repeat(64);

function entriesV1(): FixtureEntry[] {
  return skillFixture("productivity", "grilling", { description: "v1" });
}

/** 造一个装了 grilling 的本地技能目录 + 对应的 lock 条目 */
async function seedSkill(
  env: Awaited<ReturnType<typeof buildRemoteEnv>>,
  options: { dirName?: string; repo?: string; skillPath?: string; hash: string; ref?: string } = { hash: "" },
) {
  const dirName = options.dirName ?? "grilling";
  const dir = path.join(env.userAgents, dirName);
  await writeTree(dir, { "SKILL.md": "---\nname: grilling\ndescription: v1\n---\n" });
  env.skills.skills.push({ rootId: "user-agents", dirName, path: dir, name: dirName });
  const repo = options.repo ?? REPO;
  const skillPath = options.skillPath ?? SKILL_PATH;
  const existing = await env.readLock().catch(() => ({ version: 3, skills: {} }));
  await env.writeLock({
    ...existing.skills,
    [dirName]: lockEntry({ repo, ref: options.ref, skillPath, hash: options.hash }),
  });
  return dir;
}

function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("等待超时"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/* =========================== a. 指纹命中：只发 trees =========================== */

test("D-B18 a：有有效指纹且 treeSha 相同 → 只发 trees 请求，没有任何 raw / archive 请求", async () => {
  const entries = entriesV1();
  const fixture = buildTreeFixture(entries);
  const env = await buildRemoteEnv({ routes: [...treeRoutes({ [REPO]: fixture }), ...rawRoutes({ [REPO]: fixture })] });
  await seedSkill(env, { hash: fixtureHash(entries, SKILL_DIR) });
  await env.writeFile(
    "fingerprints.json",
    JSON.stringify({
      version: 1,
      entries: {
        [fingerprintKey(REPO, undefined, SKILL_PATH)]: {
          contentHash: fixtureHash(entries, SKILL_DIR),
          treeSha: fixture.dirSha.get(SKILL_DIR),
          verifiedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    }),
  );

  const result = await env.call("POST skills/updates/check", { body: {} });
  const items = result.results as { skillId: string; status: string }[];
  assert.equal(items[0]!.status, "up-to-date");
  assert.equal(callsMatching(env, "/git/trees/").length, 1, "每个仓库只发一次 trees 请求");
  assert.equal(callsMatching(env, "raw.githubusercontent.com").length, 0, "指纹命中时不得请求任何 raw 文件");
  assert.equal(callsMatching(env, "/archive/").length, 0, "指纹命中时不得下载归档");
});

/* =========================== b. 首次检查与指纹写入 =========================== */

test("D-B18 b：首次（无指纹）只请求该技能目录下的 raw；哈希相等 → up-to-date 且写指纹；第二次只剩 trees", async () => {
  const entries = entriesV1();
  const fixture = buildTreeFixture(entries);
  const env = await buildRemoteEnv({ routes: [...treeRoutes({ [REPO]: fixture }), ...rawRoutes({ [REPO]: fixture })] });
  await seedSkill(env, { hash: fixtureHash(entries, SKILL_DIR) });

  const first = await env.call("POST skills/updates/check", { body: {} });
  assert.equal((first.results as { status: string }[])[0]!.status, "up-to-date");
  assert.equal(callsMatching(env, "/archive/").length, 0, "不得下载整个仓库");

  const raws = callsMatching(env, "raw.githubusercontent.com").map((call) => call.url);
  assert.deepEqual(
    raws.map((url) => url.split(`raw.githubusercontent.com/${REPO}/HEAD/`)[1]).sort(),
    [`${SKILL_DIR}/SKILL.md`, `${SKILL_DIR}/agents/openai.yaml`],
    "只请求该技能目录下的文件",
  );

  const saved = await env.readFingerprints();
  const record = saved.entries[fingerprintKey(REPO, undefined, SKILL_PATH)];
  assert.equal(record?.treeSha, fixture.dirSha.get(SKILL_DIR), "指纹里存的是该目录的 tree sha");
  assert.equal(record?.contentHash, fixtureHash(entries, SKILL_DIR), "指纹里存的是当时的 skillFolderHash");

  // 紧接着第二次检查：只发 trees
  const before = env.fake.calls.length;
  const second = await env.call("POST skills/updates/check", { body: {} });
  assert.equal((second.results as { status: string }[])[0]!.status, "up-to-date");
  const during = env.fake.calls.slice(before);
  assert.equal(during.filter((c) => c.url.includes("/git/trees/")).length, 1);
  assert.equal(during.filter((c) => c.url.includes("raw.githubusercontent.com")).length, 0);
});

/* =========================== c. treeSha 变化 =========================== */

test("D-B18 c1：treeSha 变了但内容哈希仍相等 → up-to-date 且刷新指纹", async () => {
  const entries = entriesV1();
  const fixture = buildTreeFixture(entries);
  const env = await buildRemoteEnv({ routes: [...treeRoutes({ [REPO]: fixture }), ...rawRoutes({ [REPO]: fixture })] });
  const hash = fixtureHash(entries, SKILL_DIR);
  await seedSkill(env, { hash });
  // 旧指纹：treeSha 与现在不同（例如上游 rebase 过），但内容基准没变
  await env.writeFile(
    "fingerprints.json",
    JSON.stringify({
      version: 1,
      entries: {
        [fingerprintKey(REPO, undefined, SKILL_PATH)]: { contentHash: hash, treeSha: HASH("a"), verifiedAt: "x" },
      },
    }),
  );

  const result = await env.call("POST skills/updates/check", { body: {} });
  assert.equal((result.results as { status: string }[])[0]!.status, "up-to-date");
  assert.ok(callsMatching(env, "raw.githubusercontent.com").length > 0, "指纹不匹配时要下载该目录核对");
  const saved = await env.readFingerprints();
  assert.equal(saved.entries[fingerprintKey(REPO, undefined, SKILL_PATH)]!.treeSha, fixture.dirSha.get(SKILL_DIR));
});

test("D-B18 c2：treeSha 变了且内容确实不同 → update-available，并把结论记进指纹", async () => {
  const upstream = skillFixture("productivity", "grilling", { description: "v2" });
  const fixture = buildTreeFixture(upstream);
  const env = await buildRemoteEnv({ routes: [...treeRoutes({ [REPO]: fixture }), ...rawRoutes({ [REPO]: fixture })] });
  const oldHash = fixtureHash(entriesV1(), SKILL_DIR);
  await seedSkill(env, { hash: oldHash });
  await env.writeFile(
    "fingerprints.json",
    JSON.stringify({
      version: 1,
      entries: {
        [fingerprintKey(REPO, undefined, SKILL_PATH)]: { contentHash: oldHash, treeSha: HASH("a"), verifiedAt: "x" },
      },
    }),
  );

  const result = await env.call("POST skills/updates/check", { body: {} });
  const item = (result.results as { status: string; message?: string }[])[0]!;
  assert.equal(item.status, "update-available");
  assert.match(item.message!, /内容哈希不一致/);
  const saved = await env.readFingerprints();
  const record = saved.entries[fingerprintKey(REPO, undefined, SKILL_PATH)]!;
  assert.equal(record.treeSha, fixture.dirSha.get(SKILL_DIR), "核对过就把当时的目录 sha 记下");
  assert.equal(record.contentHash, oldHash, "内容基准仍是 lock 里的记录值");
  assert.equal(record.upToDate, false, "结论是「有更新」，要一并记下");
});

/* =========================== d. 外部改了 lock → 指纹失效 =========================== */

test("D-B18 d：lock 的 skillFolderHash 被外部改了 → 指纹失效，重新下载该目录核对", async () => {
  const entries = entriesV1();
  const fixture = buildTreeFixture(entries);
  const env = await buildRemoteEnv({ routes: [...treeRoutes({ [REPO]: fixture }), ...rawRoutes({ [REPO]: fixture })] });
  const current = fixtureHash(entries, SKILL_DIR);
  await seedSkill(env, { hash: current });
  // 指纹里记的是「npx skills 在外面更新过」之前的内容基准
  await env.writeFile(
    "fingerprints.json",
    JSON.stringify({
      version: 1,
      entries: {
        [fingerprintKey(REPO, undefined, SKILL_PATH)]: {
          contentHash: HASH("0"),
          treeSha: fixture.dirSha.get(SKILL_DIR),
          verifiedAt: "x",
        },
      },
    }),
  );

  const result = await env.call("POST skills/updates/check", { body: {} });
  assert.equal((result.results as { status: string }[])[0]!.status, "up-to-date");
  assert.ok(callsMatching(env, "raw.githubusercontent.com").length > 0, "指纹失效必须重新核对内容");
});

/* =========================== e. 找不到目录 / truncated / 根级技能 =========================== */

test("D-B18 e1：目录在树里找不到 → error（沿用「在上游 … 里找不到 …」文案）", async () => {
  const fixture = buildTreeFixture(entriesV1());
  const env = await buildRemoteEnv({ routes: [...treeRoutes({ [REPO]: fixture }), ...rawRoutes({ [REPO]: fixture })] });
  await seedSkill(env, { hash: HASH("a"), skillPath: "skills/gone/vanished/SKILL.md" });

  const result = await env.call("POST skills/updates/check", { body: {} });
  const item = (result.results as { status: string; message?: string }[])[0]!;
  assert.equal(item.status, "error");
  assert.match(item.message!, /在上游 acme\/tools@HEAD 里找不到 skills\/gone\/vanished\/SKILL\.md/);
  assert.match(item.message!, /上游可能改名或删除了这个技能/);
  assert.equal(callsMatching(env, "raw.githubusercontent.com").length, 0, "找不到目录时不该请求任何文件");
});

test("D-B18 e1b：目录名在树里唯一命中 → 按 tar.ts 的老规则找回（上游挪了分类目录）", async () => {
  const entries = entriesV1();
  const fixture = buildTreeFixture(entries);
  const env = await buildRemoteEnv({ routes: [...treeRoutes({ [REPO]: fixture }), ...rawRoutes({ [REPO]: fixture })] });
  await seedSkill(env, { hash: fixtureHash(entries, SKILL_DIR), skillPath: "skills/old-place/grilling/SKILL.md" });

  const result = await env.call("POST skills/updates/check", { body: {} });
  assert.equal((result.results as { status: string }[])[0]!.status, "up-to-date");
});

test("D-B18 e2：trees 响应 truncated → 回退下载整份 tar.gz", async () => {
  const entries = entriesV1();
  const fixture = buildTreeFixture(entries, { truncated: true });
  const gz = tarGzOf(entries, "tools-main");
  const env = await buildRemoteEnv({
    routes: [
      ...treeRoutes({ [REPO]: fixture }),
      { match: (u) => u.includes("/archive/"), response: () => new Response(new Uint8Array(gz), { status: 200 }) },
    ],
  });
  await seedSkill(env, { hash: fixtureHash(entries, SKILL_DIR) });

  const result = await env.call("POST skills/updates/check", { body: {} });
  assert.equal((result.results as { status: string }[])[0]!.status, "up-to-date");
  assert.equal(callsMatching(env, "/archive/").length, 1, "截断时必须回退下载整份归档");
  assert.equal(callsMatching(env, "raw.githubusercontent.com").length, 0);
});

test("D-B18 e3：根级技能（skillPath = SKILL.md）→ 回退下载整份 tar.gz", async () => {
  const entries: FixtureEntry[] = [
    { path: "SKILL.md", data: "---\nname: rooty\ndescription: d\n---\n" },
    { path: "README.md", data: "# readme\n" },
  ];
  const fixture = buildTreeFixture(entries);
  const gz = tarGzOf(entries, "single-main");
  const env = await buildRemoteEnv({
    routes: [
      ...treeRoutes({ [REPO]: fixture }),
      { match: (u) => u.includes("/archive/"), response: () => new Response(new Uint8Array(gz), { status: 200 }) },
    ],
  });
  await seedSkill(env, { dirName: "rooty", hash: fixtureHash(entries, ""), skillPath: "SKILL.md" });

  const result = await env.call("POST skills/updates/check", { body: {} });
  assert.equal((result.results as { status: string }[])[0]!.status, "up-to-date");
  assert.equal(callsMatching(env, "/archive/").length, 1);
  assert.equal(callsMatching(env, "raw.githubusercontent.com").length, 0, "根级技能不走逐文件 raw");
});

test("D-B18 e3b：根级技能的指纹用根 tree sha，指纹有效且相同时不下载", async () => {
  const entries: FixtureEntry[] = [{ path: "SKILL.md", data: "---\nname: rooty\ndescription: d\n---\n" }];
  const fixture = buildTreeFixture(entries);
  const gz = tarGzOf(entries, "single-main");
  const env = await buildRemoteEnv({
    routes: [
      ...treeRoutes({ [REPO]: fixture }),
      { match: (u) => u.includes("/archive/"), response: () => new Response(new Uint8Array(gz), { status: 200 }) },
    ],
  });
  const hash = fixtureHash(entries, "");
  await seedSkill(env, { dirName: "rooty", hash, skillPath: "SKILL.md" });
  await env.writeFile(
    "fingerprints.json",
    JSON.stringify({
      version: 1,
      entries: {
        [fingerprintKey(REPO, undefined, "SKILL.md")]: {
          contentHash: hash,
          treeSha: fixture.dirSha.get(""),
          verifiedAt: "x",
        },
      },
    }),
  );

  const result = await env.call("POST skills/updates/check", { body: {} });
  assert.equal((result.results as { status: string }[])[0]!.status, "up-to-date");
  assert.equal(callsMatching(env, "/archive/").length, 0, "根 tree sha 相同 → 一个字节都不下载");
});

/* =========================== f. 各组并行 =========================== */

test("D-B18 f：两个仓库的 trees 请求并行发出（第一个未返回时第二个已发出）", async () => {
  const entries = entriesV1();
  const fixtures = { [REPO]: buildTreeFixture(entries), [OTHER_REPO]: buildTreeFixture(entries) };
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const env = await buildRemoteEnv({
    routes: [
      {
        match: (url) => url.includes("api.github.com") && url.includes("/git/trees/"),
        response: async (url) => {
          const repo = url.split("api.github.com/repos/")[1]!.split("/git/trees/")[0]!;
          order.push(repo);
          if (order.length === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
          return jsonResponse(fixtures[repo as keyof typeof fixtures].payload);
        },
      },
      ...rawRoutes(fixtures),
    ],
  });
  await seedSkill(env, { dirName: "grilling", repo: REPO, hash: fixtureHash(entries, SKILL_DIR) });
  await seedSkill(env, { dirName: "grilling2", repo: OTHER_REPO, hash: fixtureHash(entries, SKILL_DIR) });

  const pending = env.call("POST skills/updates/check", { body: {} });
  await waitFor(() => order.length === 2);
  assert.deepEqual(order.slice().sort(), [OTHER_REPO, REPO].sort(), "第一个仓库还没返回，第二个请求就应该已经发出");
  releaseFirst!();
  const result = await pending;
  assert.equal((result.results as unknown[]).length, 2);
  assert.equal(callsMatching(env, "/git/trees/").length, 2, "每个仓库一次 trees");
});

/* =========================== g. 等价性 =========================== */

test("D-B18 g1：trees+raw 拼出的条目与 tar.gz 得到的 upstreamSkillHash 完全相同", () => {
  const entries = entriesV1();
  const gz = tarGzOf(entries, "tools-main");
  assert.equal(fixtureHash(entries, SKILL_DIR), tarGzHash(gz, SKILL_PATH), "两条路径的哈希必须同源");
  // 根级技能同样等价
  const rootEntries: FixtureEntry[] = [
    { path: "SKILL.md", data: "---\nname: rooty\ndescription: d\n---\n" },
    { path: ".github/workflows/ci.yml", data: "on: push\n" },
    { path: "README.md", data: "# r\n" },
  ];
  assert.equal(fixtureHash(rootEntries, ""), tarGzHash(tarGzOf(rootEntries, "single-main"), "SKILL.md"));
});

test("D-B18 g2：安装经 trees+raw 写出的文件与哈希，与经 tar.gz 的旧路径相同", async () => {
  const entries = entriesV1();
  const fixture = buildTreeFixture(entries);
  const gz = tarGzOf(entries, "tools-main");
  const env = await buildRemoteEnv({
    routes: [
      ...treeRoutes({ [REPO]: fixture }),
      ...rawRoutes({ [REPO]: fixture }),
      { match: (u) => u.includes("/archive/"), response: () => new Response(new Uint8Array(gz), { status: 200 }) },
    ],
  });

  const result = await env.call("POST skills/install", {
    body: { repo: REPO, skillPaths: [SKILL_PATH], target: "user-agents" },
  });
  const item = (result.results as { ok: boolean; message?: string }[])[0]!;
  assert.equal(item.ok, true, item.message);
  assert.equal(callsMatching(env, "/archive/").length, 0, "安装也不下载整个仓库");

  const onDisk = await readTree(path.join(env.userAgents, "grilling"));
  assert.ok(onDisk["SKILL.md"]?.includes("name: grilling"));
  assert.ok(onDisk["agents/openai.yaml"]);
  const lock = await env.readLock();
  assert.equal(lock.skills.grilling!.skillFolderHash, tarGzHash(gz, SKILL_PATH), "哈希与 tar.gz 路径一致");
  assert.equal(lock.skills.grilling!.skillFolderHash, archiveInstalledHash(gz), "与旧实现的记录值一致");
});

test("D-B18 g3：应用更新经新路径写出的文件与哈希，与旧路径相同", async () => {
  const upstream = skillFixture("productivity", "grilling", { description: "v2", extraFiles: { "extra.txt": "new" } });
  const fixture = buildTreeFixture(upstream);
  const gz = tarGzOf(upstream, "tools-main");
  const env = await buildRemoteEnv({
    routes: [
      ...treeRoutes({ [REPO]: fixture }),
      ...rawRoutes({ [REPO]: fixture }),
      { match: (u) => u.includes("/archive/"), response: () => new Response(new Uint8Array(gz), { status: 200 }) },
    ],
  });
  await seedSkill(env, { hash: HASH("0") });

  const result = await env.call("POST skills/updates/apply", { body: { ids: ["user-agents:grilling"] } });
  const item = (result.results as { ok: boolean; message?: string }[])[0]!;
  assert.equal(item.ok, true, item.message);
  assert.equal(callsMatching(env, "/archive/").length, 0);
  const onDisk = await readTree(path.join(env.userAgents, "grilling"));
  assert.match(onDisk["SKILL.md"]!, /v2/);
  assert.equal(onDisk["extra.txt"], "new");
  const lock = await env.readLock();
  assert.equal(lock.skills.grilling!.skillFolderHash, archiveInstalledHash(gz));
});

/* =========================== h. GitHub 镜像 =========================== */

test("D-B18 h1 / D-B19：raw 与 archive 带镜像前缀，api 直连成功时不带", async () => {
  const entries = entriesV1();
  const fixture = buildTreeFixture(entries, { truncated: true });
  const gz = tarGzOf(entries, "tools-main");
  const env = await buildRemoteEnv({
    routes: [
      ...treeRoutes({ [REPO]: fixture }),
      {
        match: (u) => u.includes("/archive/"),
        response: () => new Response(new Uint8Array(gz), { status: 200 }),
      },
      {
        match: (u) => u.includes("ghfast.top") && u.includes("raw.githubusercontent.com"),
        response: () => new Response(new Uint8Array(Buffer.from("x")), { status: 200 }),
      },
    ],
    settings: { version: 1, githubMirror: "https://ghfast.top/" },
  });
  await seedSkill(env, { hash: fixtureHash(entries, SKILL_DIR) });

  await env.call("POST skills/updates/check", { body: {} });
  const archived = callsMatching(env, "/archive/");
  assert.equal(archived.length, 1);
  // D-B19：整包下载统一走 github.com 的 archive 形态（codeload 形式的地址镜像普遍 403）
  assert.ok(archived[0]!.url.startsWith("https://ghfast.top/https://github.com/"), archived[0]!.url);
  assert.ok(archived[0]!.url.endsWith(".tar.gz"), archived[0]!.url);
  const trees = callsMatching(env, "/git/trees/");
  assert.equal(trees.length, 1);
  assert.ok(trees[0]!.url.startsWith("https://api.github.com/"), "直连成功时不走镜像");
});

test("D-B18 h7：保存镜像后立刻生效（无需重建客户端），清空后恢复直连", async () => {
  const entries = entriesV1();
  const fixture = buildTreeFixture(entries);
  const env = await buildRemoteEnv({
    routes: [
      ...treeRoutes({ [REPO]: fixture }),
      ...rawRoutes({ [REPO]: fixture }),
      {
        match: (u) => u.includes("ghfast.top"),
        response: () => new Response(new Uint8Array(Buffer.from("x")), { status: 200 }),
      },
    ],
  });
  await seedSkill(env, { hash: fixtureHash(entries, SKILL_DIR) });

  await env.call("POST skills/settings", { body: { githubMirror: "https://ghfast.top" } });
  await env.call("POST skills/updates/check", { body: {} });
  assert.ok(
    callsMatching(env, "raw.githubusercontent.com").every((call) => call.url.startsWith("https://ghfast.top/")),
    "保存后立刻就走镜像",
  );

  await env.call("POST skills/settings", { body: { githubMirror: "" } });
  const before = env.fake.calls.length;
  await env.call("POST skills/updates/check", { body: {} });
  assert.ok(
    env.fake.calls
      .slice(before)
      .filter((call) => call.url.includes("raw.githubusercontent.com"))
      .every((call) => call.url.startsWith("https://raw.githubusercontent.com/")),
    "清空后恢复直连",
  );
});

test("D-B18 h2：走镜像的请求没有 Authorization；直连 api.github.com 的有", async () => {
  const entries = entriesV1();
  const fixture = buildTreeFixture(entries);
  const env = await buildRemoteEnv({
    routes: [
      ...treeRoutes({ [REPO]: fixture }),
      {
        match: (u) => u.includes("ghfast.top"),
        response: () => new Response(new Uint8Array(Buffer.from("x")), { status: 200 }),
      },
    ],
    envToken: "ghp_" + "a".repeat(36),
    settings: { version: 1, githubMirror: "https://ghfast.top/" },
  });
  await seedSkill(env, { hash: fixtureHash(entries, SKILL_DIR) });

  await env.call("POST skills/updates/check", { body: {} });
  const mirrored = callsMatching(env, "ghfast.top");
  assert.ok(mirrored.length > 0, "应当经镜像取文件");
  for (const call of mirrored) assert.equal(call.headers["authorization"], undefined, "镜像请求绝不带令牌");
  assert.equal(callsMatching(env, "api.github.com")[0]!.headers["authorization"], "Bearer ghp_" + "a".repeat(36));
});

test("D-B18 h3：镜像失败不静默回退直连，文案写明镜像地址与清空指引", async () => {
  const entries = entriesV1();
  const fixture = buildTreeFixture(entries);
  const env = await buildRemoteEnv({
    routes: [
      ...treeRoutes({ [REPO]: fixture }),
      { match: (u) => u.includes("ghfast.top"), response: () => new Response("nope", { status: 502 }) },
    ],
    settings: { version: 1, githubMirror: "https://ghfast.top/" },
  });
  await seedSkill(env, { hash: fixtureHash(entries, SKILL_DIR) });

  const result = await env.call("POST skills/updates/check", { body: {} });
  const item = (result.results as { status: string; message?: string }[])[0]!;
  assert.equal(item.status, "error");
  assert.match(item.message!, /通过镜像 https:\/\/ghfast\.top\/ 下载失败/);
  assert.match(item.message!, /GitHub 镜像/);
  assert.equal(callsMatching(env, "raw.githubusercontent.com").filter((c) => !c.url.includes("ghfast.top")).length, 0);
});

test("D-B18 h4：设置校验 —— http:// 拒绝、补齐结尾 /、空串清除", async () => {
  const env = await buildRemoteEnv({});
  const bad = await env.call("POST skills/settings", { body: { githubMirror: "http://ghfast.top/" } }).then(
    () => undefined,
    (error: { code?: string; message: string }) => error,
  );
  assert.equal(bad?.code, "VALIDATION");
  assert.match(bad!.message, /https:\/\//);

  const saved = await env.call("POST skills/settings", { body: { githubMirror: "https://ghfast.top" } });
  assert.equal(saved.githubMirror, "https://ghfast.top/", "保存时补齐结尾 /");
  assert.equal((await env.readSettings()).githubMirror, "https://ghfast.top/");

  const read = await env.call("GET skills/settings", { query: {} });
  assert.equal(read.githubMirror, "https://ghfast.top/");

  const cleared = await env.call("POST skills/settings", { body: { githubMirror: "" } });
  assert.equal(cleared.githubMirror, undefined);
  assert.equal((await env.readSettings()).githubMirror, undefined);

  assert.deepEqual(normalizeMirror(""), {});
  assert.deepEqual(normalizeMirror("https://ghfast.top"), { mirror: "https://ghfast.top/" });
  assert.ok("error" in normalizeMirror("ghfast.top"));
});

test("D-B18 h5：test-mirror 成功与失败两种都不抛错", async () => {
  const ok = await buildRemoteEnv({
    routes: [
      {
        match: (u) => u.includes("ghfast.top") && u.includes("raw.githubusercontent.com"),
        response: () => new Response(new Uint8Array(Buffer.from("hi")), { status: 200 }),
      },
    ],
  });
  const okResult = await ok.call("POST skills/settings/test-mirror", { body: { githubMirror: "https://ghfast.top" } });
  assert.equal(okResult.ok, true);
  assert.equal(typeof okResult.ms, "number");
  assert.equal(await fs.readFile(ok.settingsFile, "utf8").catch(() => ""), "", "自检不保存设置");

  const failing = await buildRemoteEnv({
    routes: [{ match: (u) => u.includes("ghfast.top"), response: () => new Response("nope", { status: 503 }) }],
  });
  const failResult = await failing.call("POST skills/settings/test-mirror", {
    body: { githubMirror: "https://ghfast.top/" },
  });
  assert.equal(failResult.ok, false);
  assert.match(String(failResult.message), /HTTP 503/);

  const broken = await buildRemoteEnv({
    routes: [
      {
        match: () => true,
        response: () => {
          throw new Error("ECONNREFUSED");
        },
      },
    ],
  });
  const brokenResult = await broken.call("POST skills/settings/test-mirror", {
    body: { githubMirror: "https://ghfast.top/" },
  });
  assert.equal(brokenResult.ok, false);
  assert.match(String(brokenResult.message), /连接镜像失败/);

  // 非法 / 空地址也只回 ok:false，不抛错
  const invalid = await buildRemoteEnv({});
  const invalidResult = await invalid.call("POST skills/settings/test-mirror", { body: { githubMirror: "ftp://x/" } });
  assert.equal(invalidResult.ok, false);
  assert.equal(typeof invalidResult.message, "string");
});

test("D-B18 h6 / D-B19：applyMirror / isMirroredUrl 的判据", () => {
  // 下载类：archive 形态与 raw 都加前缀
  assert.equal(
    applyMirror("https://github.com/a/b/archive/main.tar.gz", "https://ghfast.top/"),
    "https://ghfast.top/https://github.com/a/b/archive/main.tar.gz",
  );
  assert.equal(
    applyMirror("https://raw.githubusercontent.com/a/b/main/SKILL.md", "https://ghfast.top"),
    "https://ghfast.top/https://raw.githubusercontent.com/a/b/main/SKILL.md",
  );
  // D-B19：api.github.com 允许「直连失败后无令牌经镜像重试」→ 前缀对它同样适用
  assert.equal(
    applyMirror("https://api.github.com/repos/a/b", "https://ghfast.top/"),
    "https://ghfast.top/https://api.github.com/repos/a/b",
  );
  // skills.sh 永不走镜像
  assert.equal(applyMirror("https://skills.sh/api/search", "https://ghfast.top/"), "https://skills.sh/api/search");
  // 没设镜像时一切原样返回
  assert.equal(
    applyMirror("https://github.com/a/b/archive/main.tar.gz", undefined),
    "https://github.com/a/b/archive/main.tar.gz",
  );
  // isMirroredUrl 只表达「下载类」（api 的降级重试是另一条判据 isApiUrl，不在这个函数里）
  assert.equal(isMirroredUrl("https://raw.githubusercontent.com/x"), true);
  assert.equal(isMirroredUrl("https://github.com/a/b/archive/x.tar.gz"), true);
  assert.equal(isMirroredUrl("https://api.github.com/x"), false);
  assert.equal(isApiUrl("https://api.github.com/x"), true);
  assert.equal(isApiUrl("https://github.com/x"), false);
});

/* =========================== j. 性能：指纹结论与并行下载 =========================== */

test("D-B18 j1：「可更新」也记指纹 —— 第二次检查只发 trees、0 个 raw，结论与文案都不变", async () => {
  const upstream = skillFixture("productivity", "grilling", { description: "v2" });
  const fixture = buildTreeFixture(upstream);
  const env = await buildRemoteEnv({ routes: [...treeRoutes({ [REPO]: fixture }), ...rawRoutes({ [REPO]: fixture })] });
  await seedSkill(env, { hash: fixtureHash(entriesV1(), SKILL_DIR) });

  const first = await env.call("POST skills/updates/check", { body: {} });
  const firstItem = (first.results as { status: string; message?: string }[])[0]!;
  assert.equal(firstItem.status, "update-available");
  assert.ok(callsMatching(env, "raw.githubusercontent.com").length > 0, "首次要下载目录核对");
  const saved = await env.readFingerprints();
  assert.equal(saved.entries[fingerprintKey(REPO, undefined, SKILL_PATH)]!.upToDate, false, "结论要记下来");

  // 第二次：什么都没变 → 只发一次 trees，一个 raw 都不发，结论与文案逐字相同
  const before = env.fake.calls.length;
  const second = await env.call("POST skills/updates/check", { body: {} });
  const secondItem = (second.results as { status: string; message?: string }[])[0]!;
  assert.equal(secondItem.status, "update-available");
  assert.equal(secondItem.message, firstItem.message, "指纹命中时文案必须与下载核对那次一致");
  const during = env.fake.calls.slice(before);
  assert.equal(during.filter((c) => c.url.includes("/git/trees/")).length, 1, "每个仓库一次 trees");
  assert.equal(during.filter((c) => c.url.includes("raw.githubusercontent.com")).length, 0, "不得再下载任何文件");
});

test("D-B18 j2：旧格式指纹（没有 upToDate 字段）按「最新」处理", async () => {
  const entries = entriesV1();
  const fixture = buildTreeFixture(entries);
  const env = await buildRemoteEnv({ routes: [...treeRoutes({ [REPO]: fixture }), ...rawRoutes({ [REPO]: fixture })] });
  const hash = fixtureHash(entries, SKILL_DIR);
  await seedSkill(env, { hash });
  // 0.7.1 之前写下的指纹：只有 contentHash / treeSha / verifiedAt
  await env.writeFile(
    "fingerprints.json",
    JSON.stringify({
      version: 1,
      entries: {
        [fingerprintKey(REPO, undefined, SKILL_PATH)]: {
          contentHash: hash,
          treeSha: fixture.dirSha.get(SKILL_DIR),
          verifiedAt: "2026-10-01T00:00:00.000Z",
        },
      },
    }),
  );

  const result = await env.call("POST skills/updates/check", { body: {} });
  assert.equal((result.results as { status: string }[])[0]!.status, "up-to-date");
  assert.equal(callsMatching(env, "raw.githubusercontent.com").length, 0, "老指纹照旧命中，不下载");
  assert.equal(callsMatching(env, "/archive/").length, 0);
});
test("D-B18 j3：同一目录的 raw 并行下载 —— 第一个未返回时第二个已发出", async () => {
  const entries = skillFixture("productivity", "grilling", {
    description: "v1",
    extraFiles: { "a.txt": "a", "b.txt": "b", "c.txt": "c" },
  });
  const fixture = buildTreeFixture(entries);
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const env = await buildRemoteEnv({
    routes: [
      ...treeRoutes({ [REPO]: fixture }),
      {
        match: (u) => u.includes("raw.githubusercontent.com"),
        response: async (url) => {
          order.push(url.split("/HEAD/")[1]!);
          if (order.length === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
          const path = url.split("/HEAD/")[1]!;
          return new Response(new Uint8Array(fixture.raw.get(path)!), { status: 200 });
        },
      },
    ],
  });
  await seedSkill(env, { hash: fixtureHash(entries, SKILL_DIR) });

  const pending = env.call("POST skills/updates/check", { body: {} });
  await waitFor(() => order.length >= 2);
  assert.ok(order.length >= 2, "第一个 raw 还没返回，第二个就应该已经发出（并行）");
  releaseFirst!();
  const result = await pending;
  assert.equal((result.results as { status: string }[])[0]!.status, "up-to-date");
  assert.equal(order.length, 5, "SKILL.md + agents/openai.yaml + a/b/c.txt");
});

test("D-B18 j4：一次检查里同时在途的 raw 请求数从不超过 12", async () => {
  // 一个仓库、一个技能，目录下 30 个文件 —— 远超上限，必须被闸门卡住
  const extra: Record<string, string> = {};
  for (let i = 0; i < 30; i++) extra[`f${String(i).padStart(2, "0")}.txt`] = `内容 ${i}`;
  const entries = skillFixture("productivity", "grilling", { description: "v1", extraFiles: extra });
  const fixture = buildTreeFixture(entries);
  const env = await buildRemoteEnv({
    routes: [
      ...treeRoutes({ [REPO]: fixture }),
      {
        match: (u) => u.includes("raw.githubusercontent.com"),
        response: async (url) => {
          // 让每个请求都停一会儿，好让并发真的叠起来
          await new Promise((resolve) => setTimeout(resolve, 5));
          const path = url.split("/HEAD/")[1]!;
          return new Response(new Uint8Array(fixture.raw.get(path)!), { status: 200 });
        },
      },
    ],
  });
  await seedSkill(env, { hash: fixtureHash(entries, SKILL_DIR) });

  const result = await env.call("POST skills/updates/check", { body: {} });
  assert.equal((result.results as { status: string }[])[0]!.status, "up-to-date");
  assert.equal(callsMatching(env, "raw.githubusercontent.com").length, 32, "32 个文件都要下到");
  assert.ok(env.fake.maxInFlight() <= 12, `在途请求数不得超过 12，实际峰值 ${env.fake.maxInFlight()}`);
  assert.ok(env.fake.maxInFlight() > 1, "应当是并行的");
});

test("D-B18 j5：并行下载不改变哈希 —— 结果与串行口径一致", async () => {
  const extra: Record<string, string> = {};
  for (let i = 0; i < 20; i++) extra[`g${String(i).padStart(2, "0")}.txt`] = `x${i}`;
  const entries = skillFixture("productivity", "grilling", { description: "v1", extraFiles: extra });
  const fixture = buildTreeFixture(entries);
  const gz = tarGzOf(entries, "tools-main");
  const env = await buildRemoteEnv({
    routes: [...treeRoutes({ [REPO]: fixture }), ...rawRoutes({ [REPO]: fixture })],
  });
  const expected = tarGzHash(gz, SKILL_PATH);
  await seedSkill(env, { hash: expected });

  const result = await env.call("POST skills/updates/check", { body: {} });
  assert.equal(
    (result.results as { status: string }[])[0]!.status,
    "up-to-date",
    "并行下载拼出的哈希必须与 tar.gz 路径一致",
  );
});
test("D-B18 j6：一次安装里多个技能目录并行下载，在途请求数不超过 12", async () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 25; i++) many[`h${String(i).padStart(2, "0")}.txt`] = `v${i}`;
  const entries = [
    ...skillFixture("productivity", "grilling", { description: "v1", extraFiles: many }),
    ...skillFixture("engineering", "tdd", { description: "v1", extraFiles: many }),
  ];
  const fixture = buildTreeFixture(entries);
  const env = await buildRemoteEnv({
    routes: [
      ...treeRoutes({ [REPO]: fixture }),
      {
        match: (u) => u.includes("raw.githubusercontent.com"),
        response: async (url) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          const path = url.split("/HEAD/")[1]!;
          return new Response(new Uint8Array(fixture.raw.get(path)!), { status: 200 });
        },
      },
    ],
  });

  const result = await env.call("POST skills/install", {
    body: {
      repo: REPO,
      skillPaths: ["skills/productivity/grilling/SKILL.md", "skills/engineering/tdd/SKILL.md"],
      target: "user-agents",
    },
  });
  const items = result.results as { ok: boolean; message?: string }[];
  assert.equal(items.length, 2);
  assert.ok(
    items.every((item) => item.ok),
    JSON.stringify(items),
  );
  assert.ok(env.fake.maxInFlight() <= 12, `在途请求数不得超过 12，实际峰值 ${env.fake.maxInFlight()}`);
  assert.ok(env.fake.maxInFlight() > 1, "应当是并行的");
  assert.equal(callsMatching(env, "/git/trees/").length, 1, "同一仓库多个技能共用一次 trees");
  assert.deepEqual((await readTree(path.join(env.userAgents, "grilling")))["h00.txt"], "v0");
  assert.deepEqual((await readTree(path.join(env.userAgents, "tdd")))["h00.txt"], "v0");
});
/* =========================== i. gh 候选路径 =========================== */

test("D-B18 i：gh 候选路径纯函数（非 win32 只有 gh；win32 给出常见安装位置）", () => {
  assert.deepEqual(ghCandidatePaths({}, "linux"), ["gh"]);
  assert.deepEqual(ghCandidatePaths({}, "darwin"), ["gh"]);

  const env = {
    LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    USERPROFILE: "C:\\Users\\me",
  };
  const candidates = ghCandidatePaths(env, "win32");
  assert.equal(candidates[0], "gh", "先走 PATH");
  assert.deepEqual(candidates.slice(1), [
    path.join(env.LOCALAPPDATA, "Programs", "GitHub CLI", "gh.exe"),
    path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "gh.exe"),
    path.join(env["ProgramFiles"], "GitHub CLI", "gh.exe"),
    path.join(env["ProgramFiles(x86)"], "GitHub CLI", "gh.exe"),
    path.join(env.USERPROFILE, "scoop", "shims", "gh.exe"),
  ]);

  // 环境变量缺失时不拼出坏路径
  assert.deepEqual(ghCandidatePaths({}, "win32"), ["gh"]);
  assert.equal(isExecutableMissing({ code: "ENOENT" }), true);
  assert.equal(isExecutableMissing(new Error("'gh' 不是内部或外部命令，也不是可运行的程序")), true);
  assert.equal(isExecutableMissing(new Error("gh: not logged in")), false);
});

test("D-B18 i2：PATH 找不到 gh 时才去候选路径；命令存在但未登录就此打住", async () => {
  const probed: string[] = [];
  const localAppData = "C:\\Users\\me\\AppData\\Local";
  const token = await ghAuthToken({
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    probe: async (command) => {
      probed.push(command);
      return command === "gh" ? { missing: true } : { token: "gho_example", missing: false };
    },
  });
  assert.equal(token, "gho_example");
  assert.deepEqual(probed, ["gh", path.join(localAppData, "Programs", "GitHub CLI", "gh.exe")]);

  // 命令存在但失败（未登录）→ 不再试其它候选
  const notLoggedIn: string[] = [];
  const none = await ghAuthToken({
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    probe: async (command) => {
      notLoggedIn.push(command);
      return { missing: false };
    },
  });
  assert.equal(none, undefined);
  assert.deepEqual(notLoggedIn, ["gh"]);

  // 全部不存在 → undefined，且把候选试完
  const tried: string[] = [];
  const allMissing = await ghAuthToken({
    platform: "win32",
    env: { LOCALAPPDATA: localAppData },
    probe: async (command) => {
      tried.push(command);
      return { missing: true };
    },
  });
  assert.equal(allMissing, undefined);
  assert.deepEqual(tried, ghCandidatePaths({ LOCALAPPDATA: localAppData }, "win32"));
});

/* =========================== 回归：限流提示仍在 =========================== */

test("D-B18 附加：被限流时返回的错误里带「设置 GITHUB_TOKEN 或 gh auth login」提示", async () => {
  const env = await buildRemoteEnv({
    routes: [
      {
        match: (u) => u.includes("/git/trees/"),
        response: () =>
          new Response("rate limited", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) },
          }),
      },
    ],
  });
  await seedSkill(env, { hash: HASH("a") });
  const result = await env.call("POST skills/updates/check", { body: {} });
  const item = (result.results as { status: string; message?: string }[])[0]!;
  assert.equal(item.status, "error");
  assert.match(item.message!, /GITHUB_TOKEN/);
  assert.match(item.message!, /gh auth login/);
});

test("D-B18 附加：安装时被限流 → 错误里带「设置 GITHUB_TOKEN 或 gh auth login」提示（不包装成 404）", async () => {
  const env = await buildRemoteEnv({
    routes: [
      {
        match: (u) => u.includes("/git/trees/"),
        response: () =>
          new Response("rate limited", {
            status: 403,
            headers: {
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600),
            },
          }),
      },
    ],
  });
  const result = await env.call("POST skills/install", {
    body: { repo: REPO, skillPaths: [SKILL_PATH], target: "user-agents" },
  });
  const item = (result.results as { ok: boolean; message?: string }[])[0]!;
  assert.equal(item.ok, false);
  assert.match(item.message!, /速率限制/);
  assert.match(item.message!, /GITHUB_TOKEN/);
  assert.match(item.message!, /gh auth login/);
});
