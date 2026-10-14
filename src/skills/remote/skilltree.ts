/**
 * 按目录取上游技能内容（D-B18）：检查更新、安装、应用更新共用这一条通路。
 *
 * 旧做法：每个来源仓库下载一次 codeload tar.gz（archify 700MB / agentic-awesome-skills
 * 327MB，一次检查要 4~5 分钟）。新做法：
 *
 *   1. 每个 repo+ref 一次 trees API（`?recursive=1`）—— 一次就给出全树每条目录的 sha；
 *   2. 只对**该技能目录下**的 blob 发 raw 请求（`https://raw.githubusercontent.com/{repo}/{ref}/{path}`），
 *      拼成 TarEntry[] 后套用既有的 upstreamSkillHash / upstreamSkillFiles —— 哈希与写盘口径完全不变；
 *   3. mode=120000 的符号链接与 type=commit 的子模块**跳过**（与 tar 里 symlink 不参与哈希一致）。
 *
 * 两种情况回退到整份 tar.gz（旧路径）：
 *   - trees 响应 truncated=true（树被 GitHub 截断，拿不到完整目录）；
 *   - 根级技能（skillPath === "SKILL.md"，哈希按整个仓库根算）—— 根级内容的文件集合由
 *     rootskill.ts 决定（排除 .git / .github 等元数据目录），逐文件 raw 太脆，直接回退。
 *
 * 除此之外 trees 请求失败（限流 / 网络 / 仓库不存在）**不**回退：直接把这一个仓库的每个技能
 * 报成 error。理由有二 —— ① 回退会让「被限流」这件事从界面上消失（codeload 不消耗 API 配额，
 * 于是检查照常成功，用户永远看不到「去设置 GITHUB_TOKEN」的提示）；② 树的失败原因（404、
 * 限流）比 codeload 的失败原因更准确。
 *
 * 回退是**懒**的：只有真的要下载内容时才拉 tar.gz，因此「指纹命中」的快速路径一个字节都不下载。
 */

import { filesUnderDirectory, locateSkillDirectory, type TarEntry } from "./tar.ts";
import { hashFiles, type FolderHash, type HashFile } from "./hash.ts";
import { upstreamSkillFiles, upstreamSkillHash } from "./rootskill.ts";
import { skillDirOf } from "./sourceurl.ts";
import { mapLimited, type Limiter } from "./limited.ts";
import { upstream } from "../../shared/errors.ts";
import type { GitHubClient, TarballResult, TreeSnapshot } from "./github.ts";

/** 取内容只需要 GitHub 客户端的这几个方法（便于测试注入） */
export type ContentGitHub = Pick<GitHubClient, "tree" | "rawFile" | "downloadTarball" | "defaultBranch">;

/** 一个技能的上游内容：文件（写盘口径）、哈希（npx 口径）、实际 ref 与目录 tree sha */
export interface SkillContent {
  files: HashFile[];
  hash: FolderHash;
  ref: string;
  /** 该目录的 git tree sha（回退 tar.gz 的路径没有） */
  treeSha?: string;
}

export interface ContentPlan {
  /** 仓库内技能目录（"" = 仓库根） */
  dir: string;
  /**
   * 该目录的 git tree sha（根级技能用**根** tree sha）；没有可用树（truncated / trees 失败 /
   * 目录不在树里）时 undefined —— 此时调用方必须下载内容才能判断。
   */
  treeSha?: string;
  /** 下载这个技能的内容（树命中走 raw；否则回退整份 tar.gz 再切片） */
  load(): Promise<SkillContent>;
}

export interface RepoContentsPlan {
  /** 未截断时的树快照（回退 tar.gz 时为 undefined） */
  tree?: TreeSnapshot;
  /** 回退 tar.gz 的原因（中文，写日志用） */
  fallbackReason?: string;
  /** key = 调用方给的原始 skillPath；值 = 计划或「定位失败」的 Error */
  plans: Map<string, ContentPlan | Error>;
}

/** 目录树里「文件」的判定：blob 且不是符号链接（mode 120000）；子模块是 type=commit，天然不在内 */
function isFileBlob(entry: { type: string; mode?: string }): boolean {
  return entry.type === "blob" && entry.mode !== "120000";
}

function underDirectory(entryPath: string, dir: string): boolean {
  return entryPath.startsWith(dir === "" ? "" : `${dir}/`);
}

/**
 * 为一个 repo+ref 准备内容计划（每个仓库一次 trees 调用）。
 *
 * skillPaths 是 lock 里的 skillPath 原样值（"SKILL.md" = 仓库根）。目录在树里找不到 →
 * 该项是一个 Error（文案与旧路径一致：「在上游 … 里找不到 …（上游可能改名或删除了这个技能）」）。
 */
export async function planRepoContents(
  deps: { github: ContentGitHub },
  options: {
    repo: string;
    ref?: string;
    skillPaths: string[];
    signal?: AbortSignal;
    /**
     * ref 缺省时是否先解析默认分支（安装用；检查/应用更新不需要）。
     * 解析出来的是真实分支名 —— 写回 lock 的 ref 与旧实现（codeload 解析出的分支）一致，
     * 而不是 "HEAD"。解析不到就退回 HEAD。
     */
    resolveDefaultBranch?: boolean;
    /**
     * 整次操作共用的并发闸门（检查更新 / 安装 / 应用更新各建一个）。
     * 所有 raw 请求都从这里过 —— 一次操作在途的请求数因此有硬上限，
     * 而不是「仓库数 × 每仓库上限」。不给就不过闸门（单测里逐文件直发）。
     */
    limiter?: Limiter;
  },
): Promise<RepoContentsPlan> {
  let requestedRef = options.ref !== undefined && options.ref.trim() !== "" ? options.ref.trim() : undefined;
  if (requestedRef === undefined && options.resolveDefaultBranch === true) {
    requestedRef = await deps.github.defaultBranch(options.repo).catch(() => undefined);
  }
  /** 解析到的分支（写回 lock 的 ref 用）；解析不到就是 undefined，下载侧按候选分支自己回退 */
  const resolvedRef = requestedRef;
  let tree: TreeSnapshot | undefined;
  let fallbackReason: string | undefined;
  let treeError: Error | undefined;
  try {
    const loaded = await deps.github.tree(options.repo, requestedRef, options.signal);
    if (loaded.truncated) fallbackReason = `${options.repo} 的目录树被 GitHub 截断，回退下载整份归档。`;
    else tree = loaded;
  } catch (error) {
    treeError = error instanceof Error ? error : new Error(String(error));
  }

  const plans = new Map<string, ContentPlan | Error>();
  /** 回退时整份 tar.gz 只下载一次，多个技能共用 */
  let tarballPromise: Promise<TarballResult> | undefined;
  const tarball = (): Promise<TarballResult> => {
    tarballPromise ??= deps.github.downloadTarball(options.repo, resolvedRef, options.signal);
    return tarballPromise;
  };

  for (const skillPath of options.skillPaths) {
    const dir = skillDirOf(skillPath).dirPath;
    if (dir === "") {
      // 根级技能：内容一律从 tar.gz 取（rootskill.ts 的文件集合口径）；有树时用**根** tree sha 做指纹。
      const rootSha = tree?.sha;
      plans.set(skillPath, {
        dir,
        ...(rootSha === undefined ? {} : { treeSha: rootSha }),
        load: async () => {
          const loaded = await loadFromTarball(tarball, skillPath, options.repo);
          return rootSha === undefined ? loaded : { ...loaded, treeSha: rootSha };
        },
      });
      continue;
    }
    if (tree === undefined) {
      // 没有可用的树：截断 → 回退 tar.gz；树请求失败 → 这一项就是 error（见文件头注释）
      plans.set(skillPath, treeError === undefined ? tarPlan(tarball, skillPath, options.repo) : treeError);
      continue;
    }
    // 先按 skillPath 的目录直接命中；未命中时按目录名唯一匹配（与 tar.ts 的
    // locateSkillDirectory 同一套规则）—— 上游把技能挪了分类目录时仍能找回，
    // 而「目录路径本身不安全」的情况也照旧会在调用方被 safepath 拦下。
    const entry = tree.byPath.get(dir);
    const resolvedDir = entry !== undefined && entry.type === "tree" ? dir : matchByDirectoryName(tree, dir);
    if (resolvedDir === undefined) {
      plans.set(
        skillPath,
        new Error(`在上游 ${options.repo}@${tree.ref} 里找不到 ${skillPath}（上游可能改名或删除了这个技能）。`),
      );
      continue;
    }
    const dirSha = tree.byPath.get(resolvedDir)?.sha;
    plans.set(skillPath, {
      dir: resolvedDir,
      ...(dirSha === undefined ? {} : { treeSha: dirSha }),
      load: () => loadFromTree(deps.github, options.repo, tree!, resolvedDir, options.signal, options.limiter),
    });
  }

  const out: RepoContentsPlan = { plans };
  if (tree !== undefined) out.tree = tree;
  if (fallbackReason !== undefined) out.fallbackReason = fallbackReason;
  return out;
}

function tarPlan(tarball: () => Promise<TarballResult>, skillPath: string, repo: string): ContentPlan {
  return {
    dir: skillDirOf(skillPath).dirPath,
    load: () => loadFromTarball(tarball, skillPath, repo),
  };
}

/**
 * 目录名唯一匹配（tar.ts 的 locateSkillDirectory 兜底规则的树版本）：
 * 找那些「父目录名 === base 且以 SKILL.md 结尾」的 blob，唯一命中才算。
 */
function matchByDirectoryName(tree: TreeSnapshot, dir: string): string | undefined {
  const base = dir.split("/").pop() ?? dir;
  if (base === "") return undefined;
  const matches = [...tree.byPath.values()].filter(
    (entry) =>
      entry.type === "blob" && /\/SKILL\.md$/i.test(entry.path) && (entry.path.split("/").at(-2) ?? "") === base,
  );
  if (matches.length !== 1) return undefined;
  return matches[0]!.path.replace(/\/SKILL\.md$/i, "");
}

/** 回退路径：整份 tar.gz → 定位目录 → 与旧实现完全相同的文件集合与哈希 */
async function loadFromTarball(
  tarball: () => Promise<TarballResult>,
  skillPath: string,
  repo: string,
): Promise<SkillContent> {
  const downloaded = await tarball();
  const located = locateSkillDirectory(downloaded.entries, skillPath, { allowRoot: true });
  if (located === undefined) {
    throw upstream(`在上游 ${repo}@${downloaded.ref} 里找不到 ${skillPath}（上游可能改名或删除了这个技能）。`);
  }
  return {
    files: upstreamSkillFiles(downloaded.entries, located.path),
    hash: upstreamSkillHash(downloaded.entries, located.path),
    ref: downloaded.ref,
  };
}

/**
 * 树命中路径：只下载该目录下的 blob，拼成 TarEntry[] 后走**同一个** filesUnderDirectory
 * （路径安全校验与 rel 口径完全一致），哈希用 hashFiles —— 与 hashTarDirectory 等价。
 */
async function loadFromTree(
  github: ContentGitHub,
  repo: string,
  tree: TreeSnapshot,
  dir: string,
  signal?: AbortSignal,
  limiter?: Limiter,
): Promise<SkillContent> {
  // 先把顺序定下来（按 rel 排序），再并行下载：mapLimited 按下标写回结果，
  // 因此 filesUnderDirectory 拿到的顺序、以及最终哈希都与串行时完全一致。
  const blobs = [...tree.byPath.values()]
    .filter((entry) => isFileBlob(entry) && underDirectory(entry.path, dir))
    .sort((a, b) => a.path.localeCompare(b.path));
  const through = limiter ?? (async <R>(run: () => Promise<R>): Promise<R> => await run());
  const loaded = await mapLimited(blobs, blobs.length, async (entry) => {
    const data = await through(() => github.rawFile(repo, tree.ref, entry.path, signal));
    return { path: entry.path, data };
  });
  const entries: TarEntry[] = loaded.map((item) => ({ path: item.path, type: "file", data: item.data }));
  const files = filesUnderDirectory(entries, dir);
  // 指纹记的是**这个技能目录**的 tree sha（不是仓库根）—— 上游动别的目录不该让指纹失效
  const dirEntry = tree.byPath.get(dir);
  const out: SkillContent = { files, hash: hashFiles(files), ref: tree.ref };
  if (dirEntry !== undefined) out.treeSha = dirEntry.sha;
  return out;
}
