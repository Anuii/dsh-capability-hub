/**
 * 测试夹具：把「一个仓库」同时表示成 GitHub trees API 的响应与 raw 文件的字节表。
 *
 * 两者由**同一批** FixtureEntry 派生，因此可以断言「经 trees+raw 拼出的条目」与
 * 「经 tar.gz 得到的条目」算出的哈希完全相同（验收标准 g）。
 *
 * tree sha 用 git 的口径现算（blob = sha1("blob\0"+内容)，tree = sha1(子项名+sha 排序拼接)），
 * 于是「改了目录里某个文件」必然让该目录的 sha 变 —— 指纹命中的断言才有意义。
 */

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { hashFiles, type HashFile } from "../../../src/skills/remote/hash.ts";
import { filesUnderDirectory, readTarEntries } from "../../../src/skills/remote/tar.ts";
import { upstreamSkillHash } from "../../../src/skills/remote/rootskill.ts";
import { jsonResponse } from "./helpers.ts";
import type { FakeFetchRoute } from "./helpers.ts";
import type { FixtureEntry } from "./tarfixture.ts";

export interface TreeItem {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

export interface TreeFixture {
  /** GET /repos/{repo}/git/trees/{ref}?recursive=1 的响应体 */
  payload: { sha: string; truncated: boolean; tree: TreeItem[] };
  /** path → 文件字节（raw 请求据此返回） */
  raw: Map<string, Buffer>;
  /** 目录路径（"" = 仓库根）→ tree sha */
  dirSha: Map<string, string>;
}

function blobSha(data: Buffer): string {
  return createHash("sha1").update(`blob ${data.length}\u0000`).update(data).digest("hex");
}

function treeShaOf(children: { name: string; sha: string }[]): string {
  const sorted = [...children].sort((a, b) => a.name.localeCompare(b.name));
  const hash = createHash("sha1");
  for (const child of sorted) hash.update(`${child.name}\u0000`).update(Buffer.from(child.sha, "hex"));
  return hash.digest("hex");
}

/**
 * 由仓库内的条目（相对路径，不含 codeload 的根前缀）造出树 + raw 表。
 * options.truncated = true 时响应体里 truncated 为 true（模拟 GitHub 截断大仓库的树）。
 */
export function buildTreeFixture(entries: FixtureEntry[], options: { truncated?: boolean } = {}): TreeFixture {
  const raw = new Map<string, Buffer>();
  const items: TreeItem[] = [];
  /** 目录路径 → 子项（名字 + sha），自底向上算 sha */
  const dirs = new Map<string, { name: string; sha: string }[]>();

  const ensureDir = (dir: string): { name: string; sha: string }[] => {
    const existing = dirs.get(dir);
    if (existing !== undefined) return existing;
    const created: { name: string; sha: string }[] = [];
    dirs.set(dir, created);
    return created;
  };
  ensureDir("");

  for (const entry of entries) {
    const path = entry.path.replace(/^\/+/, "");
    const isDir = entry.type === "dir" || path.endsWith("/");
    const clean = path.replace(/\/+$/, "");
    const segments = clean.split("/");
    // 逐级登记祖先目录
    for (let i = 1; i < segments.length; i++) ensureDir(segments.slice(0, i).join("/"));
    if (isDir) {
      ensureDir(clean);
      continue;
    }
    const data = Buffer.from(entry.data ?? "");
    raw.set(clean, data);
    const sha = blobSha(data);
    items.push({ path: clean, mode: "100644", type: "blob", sha });
    ensureDir(segments.slice(0, -1).join("/")).push({ name: segments.at(-1)!, sha });
  }

  // 自底向上：深的目录先算
  const dirPaths = [...dirs.keys()].sort((a, b) => b.length - a.length);
  const dirSha = new Map<string, string>();
  for (const dir of dirPaths) {
    const children = dirs.get(dir)!;
    const sha = treeShaOf(children);
    dirSha.set(dir, sha);
    if (dir !== "") items.push({ path: dir, mode: "040000", type: "tree", sha });
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    if (dir !== "") ensureDir(parent).push({ name: dir.split("/").at(-1)!, sha });
  }

  return { payload: { sha: dirSha.get("") ?? "", truncated: options.truncated === true, tree: items }, raw, dirSha };
}

/** 树响应（按仓库名分发；options.fallback 给「不关心是哪个仓库」的旧测试用） */
export function treeRoutes(
  fixtures: Record<string, TreeFixture>,
  options: { onTree?: (repo: string) => void; fallback?: TreeFixture } = {},
): FakeFetchRoute[] {
  return [
    {
      match: (url) => url.includes("api.github.com") && url.includes("/git/trees/"),
      response: (url) => {
        const repo = url.split("api.github.com/repos/")[1]!.split("/git/trees/")[0]!;
        const fixture = fixtures[repo] ?? fixtures[repo.toLowerCase()] ?? options.fallback;
        options.onTree?.(repo);
        if (fixture === undefined) return new Response("no such repo", { status: 404 });
        return jsonResponse(fixture.payload);
      },
    },
  ];
}

/** raw 文件路由（按仓库名分发；未登记的路径 404） */
export function rawRoutes(
  fixtures: Record<string, TreeFixture>,
  options: { fallback?: TreeFixture } = {},
): FakeFetchRoute[] {
  return [
    {
      match: (url) => url.includes("raw.githubusercontent.com/"),
      response: (url) => {
        const rest = url.split("raw.githubusercontent.com/")[1]!;
        // 形态：{owner}/{name}/{ref}/{path}（ref 也可能是 refs/heads/{branch}）
        const parts = rest.split("/");
        const repo = `${parts[0]}/${parts[1]}`;
        const refLength = parts[2] === "refs" ? 3 : 1;
        const path = parts
          .slice(2 + refLength)
          .map((p) => decodeURIComponent(p))
          .join("/");
        const fixture = fixtures[repo] ?? fixtures[repo.toLowerCase()] ?? options.fallback;
        const data = fixture?.raw.get(path);
        if (data === undefined) return new Response("not found", { status: 404 });
        return new Response(new Uint8Array(data), { status: 200 });
      },
    },
  ];
}

/**
 * 给「只 stub 了 codeload 的旧测试」补上 trees + raw 路由：同一份条目集既当归档又当目录树。
 *
 * 行为变化（D-B18）后安装/更新走 trees+raw，旧的「只 stub codeload」测试必须补上这两条路由
 * 才走得到落盘逻辑 —— 这正是「与下载整个仓库相关」的那一处改动。
 */
export function archiveRoutes(entries: FixtureEntry[], options: { truncated?: boolean } = {}): FakeFetchRoute[] {
  const fixture = buildTreeFixture(entries, options);
  return [...treeRoutes({}, { fallback: fixture }), ...rawRoutes({}, { fallback: fixture })];
}

/**
 * 从一份 codeload 形态的 tar.gz 直接造出 trees + raw 路由（顺序：trees 在前，避免被
 * 「/repos/ 通配」吃掉）。给「只准备了一份归档的旧安全回归测试」用：同一批条目既当归档又当树。
 */
export function routesFromArchive(gz: Buffer): FakeFetchRoute[] {
  const entries = readTarEntries(gunzipSync(gz))
    .filter((entry) => entry.type === "file")
    .map((entry) => ({ path: entry.path, data: entry.data }));
  const fixture = buildTreeFixture(entries);
  return [...treeRoutes({}, { fallback: fixture }), ...rawRoutes({}, { fallback: fixture })];
}

/** 该仓库某目录（"" = 根）的内容哈希 —— 与模块写入 lock 的口径完全相同 */
export function fixtureHash(entries: FixtureEntry[], dir: string): string {
  const tarEntries = entries.map((entry) => ({
    path: entry.path.replace(/^\/+/, ""),
    type: (entry.type === "dir" || entry.path.endsWith("/") ? "dir" : "file") as "dir" | "file",
    data: Buffer.from(entry.data ?? ""),
  }));
  return upstreamSkillHash(tarEntries, dir).normalized;
}

/** 同一条目集的 tar.gz 版本哈希（等价性断言用：两条路径必须给出同一个值） */
export function tarGzHash(gz: Buffer, skillPath: string): string {
  const entries = readTarEntries(gunzipSync(gz));
  const dir = /^SKILL\.md$/i.test(skillPath) ? "" : skillPath.replace(/\/SKILL\.md$/i, "");
  return upstreamSkillHash(entries, dir).normalized;
}

/** 该目录下的文件（写盘口径）；测试断言「只请求了该目录下的 raw」时用它做对照 */
export function fixtureFiles(entries: FixtureEntry[], dir: string): HashFile[] {
  const tarEntries = entries.map((entry) => ({
    path: entry.path.replace(/^\/+/, ""),
    type: (entry.type === "dir" || entry.path.endsWith("/") ? "dir" : "file") as "dir" | "file",
    data: Buffer.from(entry.data ?? ""),
  }));
  return filesUnderDirectory(tarEntries, dir).map((file) => ({ rel: file.rel, data: file.data }));
}

/** 目录内容哈希（从 HashFile 直接算，供对照） */
export function filesHash(files: HashFile[]): string {
  return hashFiles(files).normalized;
}
