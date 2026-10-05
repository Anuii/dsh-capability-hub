/**
 * FIX-4：Windows 下 stderr 中文乱码。
 *
 * 问题（T4b-2 实测）：Windows 中文系统上 cmd.exe 用 GBK（代码页 936）输出
 * 「'xxx' 不是内部或外部命令…」，而 mcp-runtime 之前按 UTF-8 逐块解码 stderr，
 * 运行态「最近失败」里显示成一串乱码（截图为 .dev/shots/T4b-2/19-runtime-countdown.png）。
 *
 * 本文件覆盖：GBK 解码、合法 UTF-8 不受影响、跨块多字节字符、尾部截断不产生半个字符、
 * 以及**真实 cmd.exe** 的端到端实测（K1/K2）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { MAX_STDERR_CAPTURE, STDERR_SUMMARY_LINES } from "../../../src/mcp/runtime/constants.ts";
import { StderrTail, decodeStderrBytes } from "../../../src/mcp/runtime/atoms/stderr-tail.ts";
import { resolveEnvFrom } from "../../../src/mcp/runtime/atoms/env-from.ts";

const WIN = process.platform === "win32";

const PHRASE = "不是内部或外部命令";

/**
 * 「'xyz' 不是内部或外部命令，也不是可运行的程序」的 **GBK 字节**。
 * 由 TextDecoder('gbk') 逐字回查得到，并用 TextDecoder('gbk') 反解核对过（见 FIX-4 报告）。
 */
const GBK_SAMPLE = Buffer.from([
  39, 120, 121, 122, 39, 32, 178, 187, 202, 199, 196, 218, 178, 191, 187, 242, 205, 226, 178, 191, 195, 252, 193, 238,
  163, 172, 210, 178, 178, 187, 202, 199, 191, 201, 212, 203, 208, 208, 181, 196, 179, 204, 208, 242,
]);
const GBK_SAMPLE_TEXT = "'xyz' 不是内部或外部命令，也不是可运行的程序";

function utf8StrictOk(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

test("FIX-4 GBK：cmd.exe 风格的 GBK 报错字节被正确解码", () => {
  assert.equal(utf8StrictOk(GBK_SAMPLE), false, "样本必须是非法 UTF-8（否则测不到回退分支）");
  assert.equal(decodeStderrBytes(GBK_SAMPLE), GBK_SAMPLE_TEXT);
  assert.ok(decodeStderrBytes(GBK_SAMPLE).includes(PHRASE));
  // 旧行为（直接按 UTF-8 解）会得到乱码 —— 这就是截图里的那串问号方块
  assert.equal(GBK_SAMPLE.toString("utf8").includes(PHRASE), false);
  assert.equal(decodeStderrBytes(undefined), "");
  assert.equal(decodeStderrBytes(Buffer.alloc(0)), "");
});

test("FIX-4 合法 UTF-8 文本不受影响（含中文与 emoji）", () => {
  const text = "启动失败：找不到 SKILL 目录 ✅ 请检查配置\n第二行";
  const bytes = Buffer.from(text, "utf8");
  assert.equal(decodeStderrBytes(bytes), text);
  const tail = new StderrTail();
  tail.push(bytes);
  assert.equal(tail.text(), text);
});

test("FIX-4 跨块：多字节字符被 chunk 切成两半也不乱码", () => {
  const utf8 = Buffer.from("错误：中文", "utf8");
  const tail = new StderrTail();
  // 逐字节喂进去：任何按 chunk 解码的实现都会在这里碎掉
  for (const byte of utf8) tail.push(Buffer.from([byte]));
  assert.equal(tail.text(), "错误：中文");
  assert.equal(tail.summary(), "错误：中文");

  // 跨块的 GBK 同样成立（每个汉字两字节）
  const gbkTail = new StderrTail();
  for (let i = 0; i < GBK_SAMPLE.length; i += 1) gbkTail.push(GBK_SAMPLE.subarray(i, i + 1));
  assert.equal(gbkTail.text(), GBK_SAMPLE_TEXT);
});

test("FIX-4 截尾按字节截，切在字符中间也不产生半个字符", () => {
  const CAP = MAX_STDERR_CAPTURE;
  // ① GBK：让保留窗口正好落在「是」的第二个字节上（真实 stderr 的这个位置后面跟着 \r\n）
  const gbkCn = Buffer.from([0xb2, 0xbb, 0xca, 0xc7]); // 「不是」，2 字节/字
  const tailBytes = CAP + 13 - (10 + gbkCn.length + 2);
  const gbkStream = Buffer.concat([
    Buffer.alloc(10, 0x41), // 10 字节 ASCII 前缀
    gbkCn, // [10,14)
    Buffer.from("\r\n"),
    Buffer.alloc(tailBytes, 0x43),
  ]);
  assert.equal(gbkStream.length - CAP, 13, "窗口必须从 0xC7 开始（切在「是」的中间）");
  assert.equal(gbkStream[13], 0xc7);
  const gbkTail = new StderrTail();
  gbkTail.push(gbkStream);
  assert.equal(gbkTail.text().includes("\uFFFD"), false, "不得出现替换字符（半个字符）");
  assert.equal(gbkTail.text(), "\r\n" + "C".repeat(tailBytes), "被切开的那个汉字整字丢弃");

  // ② UTF-8：切在一个三字节汉字的中间
  const rest = CAP + 11 - (10 + 6);
  const utf8Stream = Buffer.concat([Buffer.alloc(10, 0x41), Buffer.from("中文", "utf8"), Buffer.alloc(rest, 0x42)]);
  assert.equal(utf8Stream.length - CAP, 11, "窗口必须从「中」的第二个字节开始");
  const utf8Tail = new StderrTail();
  utf8Tail.push(utf8Stream);
  assert.equal(utf8Tail.text(), "文" + "B".repeat(rest));
  assert.equal(utf8Tail.text().includes("\uFFFD"), false);
});

test("FIX-4 捕获上限不变：超大输出只留尾部，且摘要仍是最后几行", () => {
  const tail = new StderrTail();
  tail.push("first\n".repeat(5000));
  tail.push("最后一行\n");
  const summary = tail.summary();
  assert.ok(summary.includes("最后一行"));
  assert.equal(tail.text().length <= MAX_STDERR_CAPTURE, true);
  assert.equal(summary.split(" — ").length <= STDERR_SUMMARY_LINES, true);
  // 兼容：旧的 String chunk 还能照常喂进来
  const legacy = new StderrTail();
  legacy.push("warning one\nwarning two\nwarning three");
  assert.equal(legacy.summary(), "warning one — warning two — warning three");
});

test("FIX-4 真实 cmd.exe：不存在的命令，stderr 尾部含中文报错（K2）", { skip: !WIN }, async () => {
  const child = spawn("cmd.exe", ["/c", "definitely-not-a-real-command-xyz"], { windowsHide: true });
  const tail = new StderrTail();
  const raw: Buffer[] = [];
  await new Promise<void>((resolve) => {
    child.stderr.on("data", (chunk: Buffer) => {
      raw.push(chunk);
      tail.push(chunk);
    });
    child.on("close", () => resolve());
  });
  assert.ok(tail.text().includes(PHRASE), "真实 stderr 尾部应含「" + PHRASE + "」，实际：" + tail.text());
  assert.match(tail.summary(), /definitely-not-a-real-command-xyz/);
  const merged = Buffer.concat(raw);
  if (!utf8StrictOk(merged)) {
    assert.equal(merged.toString("utf8").includes(PHRASE), false, "按 UTF-8 硬解会乱码（这正是修复前的现象）");
  }
});

test("FIX-4 envFrom 的诊断同样不乱码（真实 cmd.exe 走第二条 stderr 路径）", { skip: !WIN }, async () => {
  const result = await resolveEnvFrom({ envFrom: { BROKEN: "definitely-not-a-real-command-xyz" }, allowEmpty: [] });
  assert.equal(result.values.BROKEN, undefined);
  assert.equal(result.failures.length, 1);
  const message = result.failures[0].message;
  assert.ok(message.includes(PHRASE), "envFrom 诊断应含「" + PHRASE + "」，实际：" + message);
  assert.ok(!message.includes("\uFFFD"));
});
