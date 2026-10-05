/**
 * 架构规则（ADR-0001）：按 import 语句检查「谁能引用谁」。违反即失败，不靠自觉。
 *
 * 区域（zone）：
 *   宿主功能模块  src/skills/local · src/skills/remote · src/mcp/config · src/mcp/runtime
 *   宿主外壳      src/platform/host（组装四个宿主模块、接 DSH）
 *   客户端功能    src/skills/client · src/mcp/client
 *   客户端外壳    src/platform/client（页头、标签、HTTP 客户端 api.ts、标签契约 tab-props.ts）
 *   kit          src/kit（界面组件，不知道任何功能）
 *   契约          src/<功能>/contract（只放类型，宿主与客户端共用）
 *   共享          src/version.ts
 *
 * 规则：
 *   1. 四个宿主功能模块互不 import，只能引用自己、契约（仅类型）与共享。
 *   2. 宿主外壳不引用任何客户端代码。
 *   3. 客户端（功能、外壳、kit）不引用任何宿主代码；需要宿主的形状时 import type 契约。
 *   4. kit 只引用 kit。
 *   5. 客户端功能之间互不 import；只能用客户端外壳公开的 api.ts 与 tab-props.ts。
 *   6. 契约只引用契约，且别人只能 import type 它（构建时擦除，浏览器产物里没有宿主代码）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

type Zone =
  | "host:skills-local"
  | "host:skills-remote"
  | "host:mcp-config"
  | "host:mcp-runtime"
  | "host:platform"
  | "client:skills"
  | "client:mcp"
  | "client:platform"
  | "kit"
  | "contract"
  | "shared"
  | "unknown";

const ZONES: Array<[RegExp, Zone]> = [
  [/^skills\/local\//, "host:skills-local"],
  [/^skills\/remote\//, "host:skills-remote"],
  [/^mcp\/config\//, "host:mcp-config"],
  [/^mcp\/runtime\//, "host:mcp-runtime"],
  [/^platform\/host\//, "host:platform"],
  [/^skills\/client\//, "client:skills"],
  [/^mcp\/client\//, "client:mcp"],
  [/^platform\/client\//, "client:platform"],
  [/^kit\//, "kit"],
  [/^[a-z-]+\/contract\//, "contract"],
  [/^version\.ts$/, "shared"],
];

function zoneOf(rel: string): Zone {
  return ZONES.find(([pattern]) => pattern.test(rel))?.[1] ?? "unknown";
}

const isHostFeature = (zone: Zone): boolean =>
  zone === "host:skills-local" ||
  zone === "host:skills-remote" ||
  zone === "host:mcp-config" ||
  zone === "host:mcp-runtime";
const isHost = (zone: Zone): boolean => isHostFeature(zone) || zone === "host:platform";
const isClient = (zone: Zone): boolean =>
  zone === "client:skills" || zone === "client:mcp" || zone === "client:platform" || zone === "kit";
/** 客户端外壳对功能公开的文件。 */
const PLATFORM_CLIENT_PUBLIC = new Set(["platform/client/api.ts", "platform/client/tab-props.ts"]);

interface Edge {
  from: string;
  to: string;
  typeOnly: boolean;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const rel = (full: string): string => path.relative(SRC, full).split(path.sep).join("/");

function edges(): Edge[] {
  const out: Edge[] = [];
  const pattern =
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']|import\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const spec = match[2] ?? match[3]!;
      const target = path.resolve(path.dirname(file), spec);
      out.push({ from: rel(file), to: rel(target), typeOnly: match[1] !== undefined });
    }
  }
  return out;
}

function violation(edge: Edge): string | undefined {
  const a = zoneOf(edge.from);
  const b = zoneOf(edge.to);
  if (a === "unknown") return "文件不在任何区域里";
  if (b === "unknown") return "引用了不在任何区域里的文件";
  if (b === "contract" && !edge.typeOnly) return "契约只能 import type";
  if (a === b) return undefined;
  if (b === "shared") return undefined;
  if (a === "contract") return "契约只能引用契约";
  if (b === "contract") return undefined;
  if (isHostFeature(a)) return "宿主功能模块之间互不 import（规则 1）";
  if (a === "host:platform") return isHost(b) ? undefined : "宿主外壳不能引用客户端（规则 2）";
  if (isClient(a) && isHost(b)) return "客户端不能引用宿主代码（规则 3）";
  if (a === "kit") return "kit 只引用 kit（规则 4）";
  if (b === "kit") return undefined;
  if (a === "client:platform") return undefined;
  if (b === "client:platform")
    return PLATFORM_CLIENT_PUBLIC.has(edge.to) ? undefined : "功能只能用客户端外壳的 api.ts / tab-props.ts（规则 5）";
  return "客户端功能之间互不 import（规则 5）";
}

test("架构规则：没有越界的 import", () => {
  const all = edges();
  assert.ok(all.length > 300, "应当扫描到足够多的 import（实际 " + all.length + "）");
  const bad = all
    .map((edge) => ({ edge, why: violation(edge) }))
    .filter((item) => item.why !== undefined)
    .map((item) => item.edge.from + " → " + item.edge.to + "：" + item.why);
  assert.deepEqual(bad, []);
});

test("架构规则本身：每条规则都能拦住它要拦的东西", () => {
  const check = (from: string, to: string, typeOnly = false): string | undefined => violation({ from, to, typeOnly });
  assert.match(check("skills/remote/x.ts", "skills/local/y.ts")!, /规则 1/);
  assert.match(check("mcp/runtime/x.ts", "mcp/config/y.ts")!, /规则 1/);
  assert.match(check("platform/host/x.ts", "skills/client/y.ts")!, /规则 2/);
  assert.match(check("skills/client/x.ts", "skills/remote/y.ts")!, /规则 3/);
  assert.match(check("kit/x.tsx", "skills/client/y.ts")!, /规则 4/);
  assert.match(check("skills/client/x.ts", "mcp/client/y.ts")!, /规则 5/);
  assert.match(check("skills/client/x.ts", "platform/client/panel.tsx")!, /规则 5/);
  assert.equal(check("skills/client/x.ts", "platform/client/api.ts"), undefined);
  assert.equal(check("skills/client/x.ts", "skills/contract/types.ts", true), undefined);
  assert.match(check("skills/client/x.ts", "skills/contract/types.ts", false)!, /import type/);
  assert.equal(check("platform/host/modules.ts", "mcp/runtime/module.ts"), undefined);
});
