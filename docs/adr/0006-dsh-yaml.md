# ADR-0006：frontmatter 用 DSH 自带的 yaml 库解析

日期：2026-10-05 · 状态：已采纳（使用者确认「重写 frontmatter 解析器的 YAML 部分」）

## 背景
DSH 判断一个技能能否加载（`@deepseek-ai/dsh-skill-filesystem` 的 parseFrontmatter / parseSkillFile）时，直接用 npm 的 `yaml` 库（2.9.1）解析 SKILL.md 的 frontmatter。本插件 0.1–0.3 自己手写了一个约 450 行的简化 YAML 解析器去模仿它，靠 25 个对拍样本证明一致；样本之外的少见写法（锚点、跨行引号、复杂缩进……）有可能判断得和 DSH 不一样。浏览远程仓库时又另有一份 70 行的「最小 frontmatter 读取」。

## 决定
- 运行时用 **DSH 判断技能时用的那份 yaml**：外壳启动时先定位 DSH 的 `@deepseek-ai/dsh-skill-filesystem`，再从它旁边 `require("yaml")`——profile 里别的插件顺带装的 yaml 不会顶替它；找不到时才退回普通的动态 `import("yaml")`（走 DSH 的模块解析，与 MCP SDK 同一做法，D-A4）。构建时外置不打包，也不声明 peer（避免包管理器另装一份）；加载结果进 health（`yaml: { status, source, version }`）。加载失败时技能的两个模块降级，DSH 照常运行。
- 契约 `src/skills/contract/yaml.ts` 声明用到的那几个函数（`YamlLib`）；外壳注入本地技能与远程技能两个模块。
- 本地技能的 frontmatter 拆成 `src/skills/local/frontmatter/`：
  - `document.ts`：字节与行（编码、BOM、行尾、围栏），不解析 YAML；
  - `yaml-block.ts`：用 yaml 解析区段，给出取值、每个顶层值的源码位置、改写闸门（锚点 / 别名 / 显式标签 / 流式集合 / %YAML / 制表符缩进一律不改写）；
  - `rules.ts`：DSH 的校验链与中文诊断；`toggle.ts`：「只改一行」的启停改写，位置来自 yaml 给出的范围；
  - 对外只有 `createFrontmatter(yaml) → { evaluate, rewriteDisableModelInvocation }`，单测都通过这两个入口。
- 远程技能读上游 SKILL.md 的 name / description 也改用同一个库（`skills/remote/skill-meta.ts`），删掉手写的最小读取。
- 开发与单测用 devDependency 里**同版本**的 yaml；`test/skills/local/yaml-parity.mjs` 除了逐样本对拍，还检查这个版本与 DSH 安装目录里的一致。

## 后果
- 「能否加载」的判断与 DSH 用的是同一个库、同一个版本，不再只在样本上一致。
- 手写 YAML 解析删掉约 450 行；改写闸门更严格的部分（高级特性一律不改写）保持不变。
- 在 63 个真实 SKILL.md（测试夹具、真实数据只读副本、本机技能目录）上，新旧实现的判断结果、诊断与改写产物逐字节相同。
