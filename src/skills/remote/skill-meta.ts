/**
 * 读上游 SKILL.md 的 name / description（浏览、发现、根级技能安装时的目录名）。
 *
 * 用 DSH 自带的同一个 yaml 库（ADR-0006）：取值与 DSH 加载这个技能时看到的一致
 * （例如 `name: demo # 注释` 的 name 是 demo）。只读、宽容：BOM 照样读；解析失败返回空对象，不抛错。
 */

import type { YamlLib } from "../contract/yaml.ts";

export interface SkillMeta {
  name?: string;
  description?: string;
}

export type SkillMetaReader = (text: string) => SkillMeta;

/** frontmatter 区段：首行裸 --- 到下一行裸 ---（与 DSH 相同），没有则 undefined。 */
function blockOf(text: string): string | undefined {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const close = lines.indexOf("---", 1);
  return close === -1 ? undefined : lines.slice(1, close).join("\n");
}

export function createSkillMetaReader(yaml: YamlLib): SkillMetaReader {
  return (text) => {
    const block = blockOf(text);
    if (block === undefined) return {};
    const document = yaml.parseDocument(block);
    if (document.errors.length > 0) return {};
    const data = document.toJS() as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return {};
    const record = data as Record<string, unknown>;
    const meta: SkillMeta = {};
    if (typeof record.name === "string" && record.name.trim() !== "") meta.name = record.name.trim();
    if (typeof record.description === "string" && record.description.trim() !== "") {
      meta.description = record.description.trim();
    }
    return meta;
  };
}
