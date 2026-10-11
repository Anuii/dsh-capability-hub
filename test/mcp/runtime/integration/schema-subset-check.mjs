/**
 * 用 DSH 自带的校验器（dsh-tools 的 assertSupportedJsonSchema / assertObjectJsonSchema）核对 schema 转换：
 * 样本库里每一份、以及本机 MCP 工具缓存里（如果有）每个工具的 inputSchema，转换后都必须被 DSH 接受。
 *
 * 运行（Electron-as-node，dsh-tools 只在 app.asar 里）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" test/mcp/runtime/integration/schema-subset-check.mjs
 *
 * 期望末行：SCHEMA-SUBSET-RESULT pass=N fail=0。本机缓存只读，不打印任何内容，只报工具数。
 * 退出码：0 = 全部通过；1 = 有不通过；2 = 跳过（找不到 DSH 安装目录）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..", "..", "..", "..");
const install =
  process.env.DSH_INSTALL_DIR || path.join(process.env.LOCALAPPDATA || "", "Programs", "DeepSeek Harness");
const toolsLib = path.join(
  install,
  "resources",
  "app.asar",
  "dsh",
  "node_modules",
  "@deepseek-ai",
  "dsh-tools",
  "lib",
  "index.js",
);
if (!fs.existsSync(toolsLib)) {
  console.log("SKIP：找不到 DSH 的 dsh-tools（" + toolsLib + "）");
  console.log("SCHEMA-SUBSET-RESULT skip=1 pass=0 fail=0");
  process.exit(2);
}
const dsh = await import(pathToFileURL(toolsLib).href);
const { toDshInputSchema } = await import(
  pathToFileURL(path.join(PKG_ROOT, "src", "mcp", "runtime", "atoms", "schema-subset.ts")).href
);
const { SCHEMA_CORPUS } = await import(pathToFileURL(path.join(HERE, "..", "fixtures", "schema-corpus.ts")).href);

let pass = 0;
let fail = 0;
const check = (label, schema) => {
  try {
    const out = toDshInputSchema(schema);
    dsh.assertSupportedJsonSchema(out);
    dsh.assertObjectJsonSchema(out);
    pass += 1;
  } catch (error) {
    fail += 1;
    console.log("  [FAIL] " + label + " — " + (error instanceof Error ? error.message : String(error)));
  }
};

for (const item of SCHEMA_CORPUS) check("样本 " + item.name, item.schema);

const cacheFile = path.join(os.homedir(), ".dsh", "storages", "dsh-capability-hub", "mcp", "cache.json");
if (fs.existsSync(cacheFile)) {
  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const servers = cache.servers ?? cache;
  let count = 0;
  let rejectedRaw = 0;
  for (const [server, entry] of Object.entries(servers)) {
    for (const tool of Array.isArray(entry?.tools) ? entry.tools : []) {
      count += 1;
      try {
        dsh.assertSupportedJsonSchema(tool.inputSchema);
      } catch {
        rejectedRaw += 1;
      }
      check("本机缓存 " + server + "/" + tool.name, tool.inputSchema);
    }
  }
  console.log("本机工具缓存：" + count + " 个工具（原样注册会被拒 " + rejectedRaw + " 个）");
}
console.log("SCHEMA-SUBSET-RESULT pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
