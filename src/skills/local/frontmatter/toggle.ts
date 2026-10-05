/**
 * 「只改一行」的启停改写（D-B3）：把顶层 disable-model-invocation 改成 enabled ? false : true。
 *
 *   - 位置来自 yaml 给出的源码范围，只认 frontmatter 区段里的顶层键；正文里同名的行（例如文档里的示例）
 *     绝不被当成设置，也绝不被改写；
 *   - 只替换「值」这一段：冒号后的空白、行尾注释、行尾空白、BOM、原 EOL、末尾换行有无，其余字节逐字不变；
 *   - 启用且键不存在 → 不改文件；停用且键不存在 → 在闭合 --- 之前插入一行（用原文件的 EOL）；
 *   - 解析不了、用了高级 YAML 特性、行尾混用、当前值不是合法布尔 → 拒绝并给中文原因。
 */

import { Buffer } from "node:buffer";
import type { YamlLib } from "../../contract/yaml.ts";
import { blockSource, bodyOf, decodeDocument } from "./document.ts";
import { frontmatterBoolean } from "./rules.ts";
import { readBlock } from "./yaml-block.ts";

export interface ToggleResult {
  ok: boolean;
  /** 新文件内容（ok=true 时有效） */
  content: Buffer;
  changed: boolean;
  /** ok=false 的原因（中文） */
  reason?: string;
}

const TARGET = "disable-model-invocation";

export function rewriteDisableModelInvocation(yaml: YamlLib, buffer: Buffer, enabled: boolean): ToggleResult {
  const refuse = (reason: string): ToggleResult => ({ ok: false, content: buffer, changed: false, reason });
  const unchanged: ToggleResult = { ok: true, content: buffer, changed: false };
  const { doc, validUtf8 } = decodeDocument(buffer);
  if (!validUtf8) return refuse("文件不是合法 UTF-8，无法安全改写。");
  if (doc.bom) return refuse("文件以 BOM 开头，直接改写会破坏 frontmatter 语义。");
  if (!doc.present) {
    return refuse(
      doc.failure === "no-closing"
        ? "frontmatter 没有闭合的 ---，无法定位改写位置。"
        : "文件第一行不是裸 ---，没有可改写的 frontmatter。",
    );
  }
  const block = blockSource(doc);
  const parsed = readBlock(yaml, block.text);
  if (!parsed.ok) return refuse("frontmatter 当前不能被安全解析，已拒绝改写。");
  if (parsed.l2.length > 0) return refuse("frontmatter 使用了高级 YAML 特性，已拒绝改写。");
  if (doc.eol === "mixed") return refuse("文件混用了 LF 与 CRLF 行尾，已拒绝改写以免扩大破坏。");

  const body = bodyOf(doc);
  const entry = parsed.entries.get(TARGET);
  if (entry === undefined) {
    if (enabled) return unchanged;
    const closeLine = doc.lines[doc.closeIndex]!;
    const eol = closeLine.eol !== "" ? closeLine.eol : doc.eol === "crlf" ? "\r\n" : "\n";
    const out = body.slice(0, closeLine.start) + TARGET + ": true" + eol + body.slice(closeLine.start);
    return { ok: true, content: Buffer.from(out, "utf8"), changed: true };
  }

  const range = entry.valueRange;
  const shown = range === undefined ? "" : block.text.slice(range[0], range[1]);
  const current = frontmatterBoolean({ [TARGET]: entry.value }, TARGET);
  if (current.invalid || range === undefined) {
    return refuse(TARGET + " 当前取值「" + shown + "」非法，DSH 会丢弃该技能；请先手工修正。");
  }
  if ((current.value === true) === !enabled) return unchanged;
  const start = block.start + range[0];
  const end = block.start + range[1];
  const out = body.slice(0, start) + (enabled ? "false" : "true") + body.slice(end);
  if (out === body) return unchanged;
  return { ok: true, content: Buffer.from(out, "utf8"), changed: true };
}
