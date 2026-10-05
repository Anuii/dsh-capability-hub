/**
 * DSH 自带的 yaml 库（ADR-0006）：外壳从 DSH 安装目录动态加载后注入技能模块，
 * 技能模块用它解析 SKILL.md 的 frontmatter——与 DSH 自己判断「能否加载」用的是同一个库、同一个版本。
 *
 * 只有类型（import type 在构建时擦除）；开发与单测用 devDependency 里同版本的 yaml。
 */

import type * as Yaml from "yaml";

/** 技能模块用到的 yaml 接口。 */
export type YamlLib = Pick<typeof Yaml, "parseDocument" | "visit" | "isMap" | "isSeq" | "isScalar" | "isPair">;
