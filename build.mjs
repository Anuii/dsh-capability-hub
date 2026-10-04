/**
 * dsh-capability-hub 构建脚本。
 *
 * 产出两份产物：
 *   1. lib/index.js   —— 宿主半（Node/ESM，DSH 在 profile 进程内 import）
 *   2. lib/client.js  —— 浏览器半（DSH 的 __ModuleLoader__ CJS 工厂格式）
 *
 * 宿主半 external：
 *   - @deepseek-ai/*            由 DSH 的模块解析拦截层从安装目录提供（不得打包）
 *   - @modelcontextprotocol/*   同上：必须是 peerDependency，打包会造成双实例（F1 风险 1）
 * 其余（含 smol-toml）全部打包进产物，安装后零运行时依赖。
 *
 * 客户端半 external：平台种子表的 9 个键必须外置（否则会出现两份 React）；
 * 另外把用到但不在种子表里的宿主客户端包也外置，它们按 package.json 的
 * dsh.client.inject 在 boot 图里先加载。
 */
import { build } from "esbuild";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapClientBundle } from "./scripts/client-wrapper.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const PACKAGE_ID = pkg.name;

/** 宿主半外置（全部由 DSH 宿主提供）。 */
const HOST_EXTERNALS = ["@deepseek-ai/*", "@modelcontextprotocol/*", "node:*"];

/** 平台种子表（实表 9 项，F2-Q1）——必须 require，不能打包。 */
const SEED_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit",
];

/** 不在种子表、但按 dsh.client.inject 会由 boot 图先加载的宿主客户端包。 */
const INJECTED_CLIENT_MODULES = [
  "@deepseek-ai/dsh-client-locale",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-sidebar",
];

const CLIENT_EXTERNALS = [...SEED_MODULES, ...INJECTED_CLIENT_MODULES];
const watch = process.argv.includes("--watch");

await rm(join(root, "lib"), { recursive: true, force: true });
await mkdir(join(root, "lib"), { recursive: true });

// ---- 宿主半 ----
await build({
  entryPoints: [join(root, "src/host/index.ts")],
  outfile: join(root, "lib/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  external: HOST_EXTERNALS,
  banner: { js: `// ${pkg.name} ${pkg.version} — 宿主半（ESM）\n` },
  logLevel: "info",
});

// ---- 浏览器半 ----
await build({
  entryPoints: [join(root, "src/client/index.tsx")],
  outfile: join(root, "lib/.client.raw.js"),
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  sourcemap: false,
  legalComments: "none",
  external: CLIENT_EXTERNALS,
  logLevel: "info",
});

const raw = await readFile(join(root, "lib/.client.raw.js"), "utf8");
await writeFile(join(root, "lib/client.js"), wrapClientBundle(raw, { id: PACKAGE_ID }), "utf8");
await rm(join(root, "lib/.client.raw.js"), { force: true });

console.log(`[build] ${PACKAGE_ID}：lib/index.js 与 lib/client.js 已生成${watch ? "" : ""}`);
