/**
 * 仓库根级技能（FIX-7）：SKILL.md 就在仓库根 —— 整个仓库根就是技能目录。
 *
 * 只读查明（npx skills 包 1.7.0 = vercel-labs/skills，本机 npx 缓存
 * %LOCALAPPDATA%\\npm-cache\\_npx\\ac0ed6aa23b37c1e\\node_modules\\skills\\dist\\cli.mjs；只读，未改动）：
 *   - 发现：`discoverSkills()` 先判 searchPath 自身有没有 SKILL.md（1328–1338）——
 *     单技能仓库（SKILL.md 在根）确实会被识别成一个技能；
 *   - 安装目录名：`sanitizeName(skill.name || basename(skill.path))`（2285）—— 技能名清洗后的形态；
 *   - 复制内容：`copyDirectory(<仓库根>, <技能根>/<目录名>)`（2310–2312、2391–2413），
 *     排除 `metadata.json`（文件）与 `.git` / `__pycache__` / `__pypackages__`（目录，任意层级）
 *     —— 注意 CLI 会把 `.github` 之类的仓库元数据一并复制进技能目录；
 *   - 来源记录：`skillFiles[skill.name] = "SKILL.md"`（5592）、
 *     `skillFolderHash = computeSkillFolderHash(join(tempDir, dirname("SKILL.md")))`（5641）
 *     —— 对**仓库根整个目录**套同一套哈希算法（该算法只跳过 `.git` 与 `node_modules`，1150–1165）。
 *
 * 本模块的两条口径（为与 npx skills 兼容而定）：
 *   1. **写盘**：`.github` / `.vscode` 这类仓库与编辑器元数据目录**不写进技能目录**
 *      （`rootSkillFiles`）。CI 配置、issue 模板、编辑器设置不是技能内容，写进技能目录只会污染它。
 *      `.git` / `node_modules` / `__pycache__` / `__pypackages__` 与 CLI 的两份排除清单同源。
 *   2. **哈希**：`skillFolderHash` 一律按 npx skills 的算法对**上游仓库根目录**计算
 *      （`upstreamRootFiles`：只跳过 `.git` 与 `node_modules`，与 `hash.ts` 的
 *      `HASH_SKIP_DIRS` / `hashLocalDirectory` 同口径）—— D-B7 说的是「上游目录内容的哈希」，
 *      不是「本地写盘内容的哈希」。安装、检查更新、应用更新共用本文件的 `upstreamSkillHash`，
 *      三处口径必然一致（安装完立刻检查 = 「最新」；只改上游 `.github` 里的文件 = 「有更新」，
 *      与 npx 行为一致）。
 */

import { describeUnsafePath } from "./safepath.ts";
import { hashFiles, hashTarDirectory, type FolderHash, type HashFile } from "./hash.ts";
import { filesUnderDirectory, type TarEntry } from "./tar.ts";
import { parseMiniFrontmatter } from "./frontmatter.ts";
import { upstream } from "./errors.ts";

/**
 * 根级安装时**不写进技能目录**的目录名（任意层级；大小写不敏感）。
 * 前四个与 npx skills 的两份排除清单同源（copyDirectory 的 EXCLUDE_DIRS + 哈希算法的 SKIP_DIRS），
 * 其余是仓库 / 编辑器元数据（`.github` 由 FIX-7 要求 1 点名）。
 */
export const ROOT_SKILL_EXCLUDED_DIRS: readonly string[] = [
  ".git",
  ".github",
  ".vscode",
  ".idea",
  "node_modules",
  "__pycache__",
  "__pypackages__",
];

const EXCLUDED_DIRS = new Set(ROOT_SKILL_EXCLUDED_DIRS.map((name) => name.toLowerCase()));

/** 路径里是否有一段（不含最后一段文件名）落在排除清单里 */
function underExcludedDirectory(rel: string): boolean {
  const segments = rel.split("/");
  return segments.slice(0, -1).some((segment) => EXCLUDED_DIRS.has(segment.toLowerCase()));
}

/**
 * 仓库根级技能的内容文件（相对仓库根，/ 分隔）。
 *
 * 这是「根级技能内容」的唯一出口：安装、检查更新、应用更新都走它 —— 三处必须是同一批文件，
 * 否则安装完立刻检查更新就会误报「有更新」。
 *
 * FIX-5 的路径安全判据同样生效，但只校验**真正会写盘**的路径：被排除的元数据目录既不写盘、
 * 也不参与哈希，因此那里的怪名字不会让整个仓库装不上（整体拒绝原则见 safepath.ts）。
 * 符号链接条目（type='symlink'）从一开始就不在返回集里，永远不会被写盘。
 */
export function rootSkillFiles(entries: TarEntry[]): HashFile[] {
  const files: HashFile[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || entry.path === "") continue;
    if (underExcludedDirectory(entry.path)) continue;
    const reason = describeUnsafePath(entry.path);
    if (reason !== undefined) {
      throw upstream(`上游归档里的文件路径 "${entry.path}" 不安全（${reason}），已拒绝本次安装/更新。`);
    }
    files.push({ rel: entry.path, data: entry.data });
  }
  return files;
}

/**
 * npx skills 的**哈希口径**跳过清单（= hash.ts 的 `HASH_SKIP_DIRS`；CLI 的 collectFiles 1150–1165
 * 只跳过这两个目录，其余（含 `.github`）全部参与哈希）。
 */
export const NPX_HASH_SKIP_DIRS: readonly string[] = [".git", "node_modules"];

const HASH_SKIP_DIRS = new Set(NPX_HASH_SKIP_DIRS.map((name) => name.toLowerCase()));

/**
 * 上游**仓库根**参与哈希的文件（npx skills 的口径）。
 *
 * 与 `rootSkillFiles`（真正写盘的那批）刻意不同：这里包含 `.github` / `.vscode` 等元数据目录，
 * 只跳过 `.git` 与 `node_modules` —— 这样记录值/比较值与 npx skills 对同一个仓库算出的值一致
 * （D-B7：skillFolderHash 是**上游目录内容**的哈希）。
 * 这批文件**从不写盘**，因此这里不做 FIX-5 的路径安全校验（不写盘就没有落盘位置可言；
 * 写盘那一侧仍由 `rootSkillFiles` + `fsx.writeDirectoryFiles` 双重把关）。
 */
export function upstreamRootFiles(entries: TarEntry[]): HashFile[] {
  const files: HashFile[] = [];
  for (const entry of entries) {
    if (entry.type !== "file" || entry.path === "") continue;
    const segments = entry.path.split("/");
    if (segments.slice(0, -1).some((segment) => HASH_SKIP_DIRS.has(segment.toLowerCase()))) continue;
    files.push({ rel: entry.path, data: entry.data });
  }
  return files;
}

/** 上游技能的内容**文件**（写盘用）：根级（dirPath === ''）→ rootSkillFiles；普通技能 → 目录下全部文件 */
export function upstreamSkillFiles(entries: TarEntry[], dirPath: string): HashFile[] {
  return dirPath === "" ? rootSkillFiles(entries) : filesUnderDirectory(entries, dirPath);
}

/**
 * 上游技能的内容**哈希**（记进 lock / sources.json、以及与它比较时用同一个值）：
 * 根级 → 仓库根（npx 口径，见 upstreamRootFiles）；普通技能 → 该目录（`hashTarDirectory`）。
 */
export function upstreamSkillHash(entries: TarEntry[], dirPath: string): FolderHash {
  return dirPath === "" ? hashFiles(upstreamRootFiles(entries)) : hashTarDirectory(entries, dirPath);
}

/**
 * npx skills 的 sanitizeName（dist/cli.mjs:2183–2185 **逐字复刻**）：
 * 小写 → 非 `[a-z0-9._]` 一律换成 `-` → 去掉首尾的 `.`/`-` → 截断到 255 → 空串退化为 `unnamed-skill`。
 */
export function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .substring(0, 255);
  return sanitized === "" ? "unnamed-skill" : sanitized;
}

export interface RootSkillName {
  /** frontmatter 里的技能名（原样；没有 name 时 undefined） */
  raw?: string;
  /** lock 的键（npx 语义）= 原始技能名；取不到 frontmatter name 时用仓库名（同样原样） */
  key: string;
  /** 安装目录名 = sanitizeName(key)（CLI 的 getInstallPath 就是这么算的） */
  dirName: string;
}

/**
 * 根级技能的**键**与**目录名**（npx skills 的两条规则）：
 *   - lock 键 = `skill.name` 原样（取不到 name 时 = 仓库名原样）；
 *   - 安装目录名 = `sanitizeName(skill.name || basename(skill.path))`（2285、2183–2185）。
 * 名字本来就干净时两者相同（本机 31/31 的技能都是这种）。
 */
export function rootSkillNameOf(skillMdText: string | undefined, repoBase: string): RootSkillName {
  const parsed = skillMdText === undefined ? undefined : parseMiniFrontmatter(skillMdText).name?.trim();
  const usable = parsed !== undefined && parsed !== "" ? parsed : undefined;
  const key = usable ?? repoBase;
  const out: RootSkillName = { key, dirName: sanitizeName(key) };
  if (usable !== undefined) out.raw = usable;
  return out;
}

/** 从内容文件里取 SKILL.md 的文本（根级技能必有 SKILL.md，取不到返回 undefined） */
export function skillMdTextOf(files: HashFile[]): string | undefined {
  const skillMd = files.find((file) => file.rel.toLowerCase() === "skill.md");
  return skillMd?.data.toString("utf8");
}
