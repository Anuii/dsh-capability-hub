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
 *
 * 用法：
 *   node build.mjs                              # 构建到 lib/
 *   node build.mjs --also-out <目录>            # 同时把 index.js / client.js 写进另一个 lib 目录（可重复）
 *   node build.mjs --watch [--also-out <目录>]  # 监听源码，变化后增量重建并写出
 *
 * --also-out 给开发期的 link 暂存目录用（见 docs/DEV.md 第 4 节、scripts/dev-link.ps1）。
 * 产物内容没变时不重写文件：宿主 HMR 按文件元数据判断变化，避免无意义的重载。
 */
import { build, context } from "esbuild";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

// ---- 参数 -------------------------------------------------------------------
const argv = process.argv.slice(2);
const watch = argv.includes("--watch");
const libDir = join(root, "lib");
const alsoOut = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== "--also-out") continue;
  const dir = argv[i + 1];
  if (dir === undefined || dir.startsWith("--")) throw new Error("--also-out 后面要跟一个目录");
  alsoOut.push(resolve(dir));
  i++;
}
const outDirs = [libDir, ...alsoOut.filter((dir) => dir !== libDir)];

// ---- 写出 -------------------------------------------------------------------
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** 内容不变就跳过；Windows 上目标偶尔被读者占用（EBUSY/EPERM），短暂重试。 */
async function writeIfChanged(file, contents) {
  try {
    const current = await readFile(file, "utf8");
    if (current === contents) return false;
  } catch {}
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(file, contents, "utf8");
      return true;
    } catch (error) {
      if (attempt >= 5 || !["EBUSY", "EPERM", "EACCES"].includes(error?.code)) throw error;
      await sleep(100 * (attempt + 1));
    }
  }
}

async function emit(name, contents) {
  const written = [];
  for (const dir of outDirs) {
    await mkdir(dir, { recursive: true });
    if (await writeIfChanged(join(dir, name), contents)) written.push(dir);
  }
  return written;
}

function stamp() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function report(name, written) {
  if (written.length === 0) console.log(`[build ${stamp()}] ${name} 未变化`);
  else console.log(`[build ${stamp()}] ${name} → ${written.map((dir) => (dir === libDir ? "lib" : dir)).join("、")}`);
}

// ---- 构建选项 ---------------------------------------------------------------
const hostOptions = {
  entryPoints: [join(root, "src/host/index.ts")],
  outfile: join(libDir, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  external: HOST_EXTERNALS,
  define: { __HUB_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: `// ${pkg.name} ${pkg.version} — 宿主半（ESM）\n` },
  logLevel: "info",
  write: false,
};

const clientOptions = {
  entryPoints: [join(root, "src/client/index.tsx")],
  outfile: join(libDir, ".client.raw.js"),
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
  define: { __HUB_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "info",
  write: false,
};

async function emitHost(result) {
  report("index.js", await emit("index.js", result.outputFiles[0].text));
}

async function emitClient(result) {
  const wrapped = wrapClientBundle(result.outputFiles[0].text, { id: PACKAGE_ID });
  report("client.js", await emit("client.js", wrapped));
}

/** esbuild 插件：每次（重新）构建成功后写出产物。 */
function emitter(onSuccess) {
  return {
    name: "emit",
    setup(b) {
      b.onEnd(async (result) => {
        if (result.errors.length > 0) {
          console.log(`[build ${stamp()}] 构建失败，保留上一份产物`);
          return;
        }
        await onSuccess(result);
      });
    },
  };
}

if (watch) {
  const host = await context({ ...hostOptions, plugins: [emitter(emitHost)] });
  const client = await context({ ...clientOptions, plugins: [emitter(emitClient)] });
  await Promise.all([host.watch(), client.watch()]);
  console.log(`[build] 监听中（Ctrl+C 结束）：${outDirs.join("、")}`);
  console.log("[build] 客户端改动：刷新页面即可；宿主改动：需要重启 profile。");
} else {
  // 全量构建：先清空仓库内的 lib/，保证打包时没有残留中间产物；--also-out 的目录只覆盖不清空。
  await rm(libDir, { recursive: true, force: true });
  await emitHost(await build(hostOptions));
  await emitClient(await build(clientOptions));
  console.log(`[build] ${PACKAGE_ID}：lib/index.js 与 lib/client.js 已生成`);
}
