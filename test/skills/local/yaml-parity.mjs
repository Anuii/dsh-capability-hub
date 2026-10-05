#!/usr/bin/env node
/**
 * 与官方对拍：本插件的 frontmatter 判断 vs DSH 自带 yaml 直接解析的结果。
 *
 * 0.4.0 起本插件运行时用的就是 DSH 自带的 yaml（ADR-0006），这里守住两件事：
 *   - 开发与单测用的 devDependency yaml 与 DSH 安装目录里的版本相同；
 *   - 本插件切出的 frontmatter 区段、取出的键值与 DSH 的做法一致（围栏、行尾、注释……）。
 *
 * 官方侧：用「Electron-as-node」把 DSH 安装目录里的 Electron 可执行文件当 node 用（不启动官方 App），
 * 再用 createRequire 指向 asar 内 @deepseek-ai/dsh-skill-filesystem/package.json 拿到官方用的 yaml。
 * 本插件侧：import src/skills/local/frontmatter/index.ts，注入 devDependency 里的 yaml。
 *
 * 运行（本机 Node 24，自带类型擦除）：
 *   node test/skills/local/yaml-parity.mjs
 *
 * 退出码：0 = 全部一致；1 = 有样本不一致；2 = 跳过（找不到官方 Electron 可执行文件）。
 * 环境变量：DSH_ELECTRON_EXE 覆盖官方可执行文件路径；DSH_INSTALL_DIR 覆盖 DSH 安装目录
 * （默认 %LOCALAPPDATA%\Programs\DeepSeek Harness）。
 *
 * 对拍范围：PLAN 约定的 L0+L1 子集（裸 --- 围栏、顶层映射、纯标量、引号标量、块标量、
 * 行尾注释、整行注释、空行、一级嵌套映射、块序列）。子集外的结构（锚点/别名、流式集合、
 * 多文档、制表符缩进）只要求「不崩 + safeToToggle=false」，见文件末尾的 L2 段。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const parserPath = path.join(here, "..", "..", "..", "src", "skills", "local", "frontmatter", "index.ts");
const { createFrontmatter } = await import(pathToFileURL(parserPath).href);
const YAML = await import("yaml");
const localYamlVersion = JSON.parse(
  fs.readFileSync(path.join(here, "..", "..", "..", "node_modules", "yaml", "package.json"), "utf8"),
).version;
const { evaluate: evaluateFrontmatter } = createFrontmatter(YAML);

const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const DSH_INSTALL_DIR = process.env.DSH_INSTALL_DIR || path.join(LOCAL_APPDATA, "Programs", "DeepSeek Harness");
const ELECTRON_EXE = process.env.DSH_ELECTRON_EXE || path.join(DSH_INSTALL_DIR, "DeepSeek Harness.exe");
// asar 内的锚点：Electron-as-node 用 createRequire 从这个文件解析官方 yaml（统一成正斜杠）。
const ASAR_ANCHOR = path
  .join(
    DSH_INSTALL_DIR,
    "resources",
    "app.asar",
    "dsh",
    "node_modules",
    "@deepseek-ai",
    "dsh-skill-filesystem",
    "package.json",
  )
  .replace(/\\/g, "/");

/* ---------------- 样本 ---------------- */

function skill(lines, eol) {
  return lines.join(eol || "\n") + (eol || "\n");
}

const COMMENT_CASES = [
  {
    id: "plain-comment-lf",
    why: "纯标量 + 行尾注释（LF）：name 是 demo，不是 demo # c",
    lines: [
      "---",
      "name: demo # c",
      "description: hello # note",
      "disable-model-invocation: true # 停用",
      "---",
      "",
      "# demo",
    ],
  },
  {
    id: "plain-comment-crlf",
    why: "同上但 CRLF",
    eol: "\r\n",
    lines: ["---", "name: demo # c", "description: hello # note", "user-invocable: false # 隐藏", "---", "", "# demo"],
  },
  {
    id: "bool-true-comment",
    why: "布尔值带注释：true # note -> true（不是字符串）",
    lines: ["---", "name: demo", "description: hello", "disable-model-invocation: true # note", "---", ""],
  },
  {
    id: "bool-false-comment",
    why: "布尔值带注释：false # note -> false",
    lines: [
      "---",
      "name: demo",
      "description: hello",
      "disable-model-invocation: false # note",
      "user-invocable: false # note",
      "---",
      "",
    ],
  },
  {
    id: "quoted-double-hash-inside",
    why: "双引号内的 # 是正文",
    lines: ["---", "name: demo", 'description: "a # b"', "---", ""],
  },
  {
    id: "quoted-single-hash-inside",
    why: "单引号内的 # 是正文",
    lines: ["---", "name: demo", "description: 'a # b'", "---", ""],
  },
  {
    id: "quoted-then-comment",
    why: "引号标量结束后「空白 + #」才是注释",
    lines: ["---", "name: demo", 'description: "hello # world" # 真注释', "---", ""],
  },
  {
    id: "quoted-escaped-quote-then-comment",
    why: "单引号内的 '' 是转义，其后的 # 才是注释",
    lines: ["---", "name: demo", "description: 'it''s # here' # 注释", "---", ""],
  },
  {
    id: "hash-without-space-is-text",
    why: "a#b 的 # 前面没有空白，属于正文",
    lines: ["---", "name: demo", "description: a#b#c", "disable-model-invocation: true#x", "---", ""],
  },
  {
    id: "whole-line-comments",
    why: "整行注释与空行被忽略，但 # 之后的正文不受影响",
    lines: ["---", "# 顶部注释", "name: demo", "", "# 中间注释", "description: hello", "# 尾部注释", "---", ""],
  },
  {
    id: "block-literal-hash",
    why: "字面块标量 | 内容里的 # 是正文",
    lines: ["---", "name: demo", "description: |", "  第一行 # 不是注释", "  第二行", "---", ""],
  },
  {
    id: "block-folded-hash",
    why: "折叠块标量 > 内容里的 # 是正文",
    lines: ["---", "name: demo", "description: >", "  第一行 # 不是注释", "  第二行", "---", ""],
  },
  {
    id: "block-header-comment",
    why: "块标量头 | 之后的行尾注释不影响块内容",
    lines: ["---", "name: demo", "description: | # 头注释", "  内容 # 正文", "---", ""],
  },
  {
    id: "bool-yes",
    why: "布尔宽容度：yes 在 yaml 1.2 core 里是字符串，官方靠字符串分支兜住",
    lines: ["---", "name: demo", "description: hello", "disable-model-invocation: yes", "---", ""],
  },
  {
    id: "bool-ON-comment",
    why: "布尔宽容度：ON 大写 + 注释",
    lines: ["---", "name: demo", "description: hello", "disable-model-invocation: ON # on", "---", ""],
  },
  {
    id: "bool-off-comment",
    why: "布尔宽容度：off（字符串）+ 注释",
    lines: ["---", "name: demo", "description: hello", "user-invocable: off # off", "---", ""],
  },
  {
    id: "bool-quoted-one",
    why: "布尔宽容度：''1'' 与 ''0''",
    lines: [
      "---",
      "name: demo",
      "description: hello",
      'disable-model-invocation: "1"',
      "user-invocable: '0'",
      "---",
      "",
    ],
  },
  {
    id: "bool-number",
    why: "布尔宽容度：0/1 数字形态",
    lines: [
      "---",
      "name: demo",
      "description: hello",
      "disable-model-invocation: 1",
      "user-invocable: 0 # 注释",
      "---",
      "",
    ],
  },
  {
    id: "bool-invalid-word-comment",
    why: "非法布尔（双方都必须看到同一个字符串，官方据此丢弃技能）",
    lines: ["---", "name: demo", "description: hello", "disable-model-invocation: maybe # 注释", "---", ""],
  },
  {
    id: "comment-only-value",
    why: "键后面只有注释：值是 null",
    lines: ["---", "name: demo", "description: hello", "user-invocable: # 只有注释", "---", ""],
  },
  {
    id: "metadata-nested-comment",
    why: "一级嵌套映射里的行尾注释",
    lines: ["---", "name: demo", "description: hello", "metadata:", "  owner: me # 归属", "  tags: [a, b]", "---", ""],
  },
  {
    id: "extra-key-comment",
    why: "未知键 + 行尾注释（未知键只进 extraKeys，绝不删）",
    lines: ["---", "name: demo", "description: hello", "license: MIT # 许可", "---", ""],
  },
  {
    id: "trailing-spaces-before-comment",
    why: "注释前有多个空格，取值不受影响",
    lines: ["---", "name: demo", 'description: "hello"    # 注释', "user-invocable: true    # 注释", "---", ""],
  },
  {
    id: "multiple-hashes",
    why: "第一处空白 + # 之后的全部内容都是注释",
    lines: ["---", "name: demo", "description: hello # a # b", "---", ""],
  },
  {
    id: "value-is-empty-vs-comment",
    why: "空值与「#」开头的值（# 在空白后即注释）",
    lines: ["---", "name: demo", "description: #x", "user-invocable: ", "---", ""],
  },
];

const L2_CASES = [
  {
    id: "l2-anchor",
    lines: ["---", "name: demo", "description: hello", "metadata: &m", "  a: 1", "other: *m", "---", ""],
  },
  {
    id: "l2-flow-collection",
    lines: ["---", "name: demo", "description: hello", "metadata: {a: 1, b: [2, 3]}", "---", ""],
  },
  { id: "l2-yaml-directive", lines: ["---", "%YAML 1.2", "name: demo", "description: hello", "---", ""] },
  { id: "l2-unterminated-quote", lines: ["---", "name: demo", 'description: "hello', "---", ""] },
  { id: "l2-tab-indent", lines: ["---", "name: demo", "description: hello", "metadata:", "\ta: 1", "---", ""] },
];

const KEYS = ["name", "description", "disable-model-invocation", "user-invocable"];

/* ---------------- 官方侧：Electron-as-node + asar 内 yaml ---------------- */

function officialChildSource() {
  return [
    "const { createRequire } = require('module');",
    "const fs = require('fs');",
    "const payloadPath = process.argv[2];",
    "const outPath = process.argv[3];",
    "const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));",
    "const req = createRequire(payload.anchor);",
    "const YAML = req('yaml');",
    "function frontmatterBlock(text) {",
    "  const lines = text.split(/\\r?\\n/);",
    "  if (lines[0] !== '---') return null;",
    "  for (let i = 1; i < lines.length; i += 1) if (lines[i] === '---') return lines.slice(1, i).join('\\n');",
    "  return null;",
    "}",
    "const out = { yamlVersion: req('yaml/package.json').version, results: {} };",
    "for (const s of payload.samples) {",
    "  const block = frontmatterBlock(s.text);",
    "  if (block === null) { out.results[s.id] = { ok: false, error: 'no-frontmatter' }; continue; }",
    "  try { const v = YAML.parse(block); out.results[s.id] = { ok: true, isMap: v !== null && typeof v === 'object' && !Array.isArray(v), data: v }; }",
    "  catch (e) { out.results[s.id] = { ok: false, error: String((e && e.message) || e) }; }",
    "}",
    "fs.writeFileSync(outPath, JSON.stringify(out, null, 1));",
  ].join("\n");
}

function runOfficial(samples) {
  if (!fs.existsSync(ELECTRON_EXE)) return { skip: ELECTRON_EXE };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-parity-"));
  try {
    const childPath = path.join(dir, "official.cjs");
    const payloadPath = path.join(dir, "payload.json");
    const outPath = path.join(dir, "official.json");
    fs.writeFileSync(childPath, officialChildSource(), "utf8");
    fs.writeFileSync(payloadPath, JSON.stringify({ anchor: ASAR_ANCHOR, samples }), "utf8");
    const res = spawnSync(ELECTRON_EXE, [childPath, payloadPath, outPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 120000,
    });
    if (!fs.existsSync(outPath)) {
      return {
        error:
          "official-side-failed: status=" +
          res.status +
          " stdout=" +
          (res.stdout || "") +
          " stderr=" +
          (res.stderr || ""),
      };
    }
    return { data: JSON.parse(fs.readFileSync(outPath, "utf8")) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- 比对 ---------------- */

function show(v) {
  if (v === undefined) return "(缺失)";
  return JSON.stringify(v);
}

const samples = [];
for (const c of COMMENT_CASES) samples.push({ id: c.id, text: skill(c.lines, c.eol) });

const official = runOfficial(samples);
if (official.skip !== undefined) {
  console.log("SKIP：找不到官方 Electron 可执行文件：" + official.skip);
  console.log("      可用 DSH_ELECTRON_EXE 指定路径后重跑。");
  process.exit(2);
}
if (official.error !== undefined) {
  console.log("FAIL：官方侧执行失败：" + official.error);
  process.exit(1);
}

let pass = 0;
const failures = [];
console.log(
  "官方 yaml 版本：" +
    official.data.yamlVersion +
    "，本插件开发用：" +
    localYamlVersion +
    "，样本数：" +
    samples.length,
);
const versionMismatch = official.data.yamlVersion !== localYamlVersion;
if (versionMismatch)
  console.log(
    " FAIL devDependency 的 yaml 版本与 DSH 不同：请把 package.json 的 yaml 改成 " + official.data.yamlVersion,
  );
console.log("");
for (const s of samples) {
  const off = official.data.results[s.id];
  const mine = evaluateFrontmatter(Buffer.from(s.text, "utf8"));
  const diffs = [];
  for (const key of KEYS) {
    const a = off.ok && off.isMap ? off.data[key] : undefined;
    const b = mine.data[key];
    if (show(a) !== show(b)) diffs.push(key + ": 官方=" + show(a) + " 本插件=" + show(b));
  }
  const ok = diffs.length === 0;
  if (ok) pass += 1;
  else failures.push({ id: s.id, diffs });
  console.log((ok ? "  OK  " : " FAIL ") + s.id.padEnd(38) + " " + (ok ? "" : diffs.join(" | ")));
}

console.log("");
console.log(
  "对拍汇总（L0+L1 子集）：" +
    pass +
    "/" +
    samples.length +
    " 一致" +
    (failures.length === 0 ? "，无差异" : "，" + failures.length + " 个样本有差异"),
);

let l2pass = 0;
for (const c of L2_CASES) {
  const text = skill(c.lines, c.eol);
  let safe = false;
  let threw = false;
  try {
    safe = evaluateFrontmatter(Buffer.from(text, "utf8")).safeToToggle;
  } catch (e) {
    threw = true;
  }
  const ok = !threw && safe === false;
  if (ok) l2pass += 1;
  console.log("  " + (ok ? "OK  " : "FAIL") + " L2/" + c.id.padEnd(28) + " 不崩=" + !threw + " safeToToggle=" + safe);
}
console.log("L2（子集外）汇总：" + l2pass + "/" + L2_CASES.length + " 不崩且标为不可安全改写");

const failed = versionMismatch || failures.length > 0 || l2pass !== L2_CASES.length;
console.log(failed ? "结果：有不一致，见上方 FAIL 行。" : "结果：全部一致。");
process.exit(failed ? 1 : 0);
