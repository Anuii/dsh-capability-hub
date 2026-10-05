# 架构决策记录（ADR）

记录「代码怎么组织」的决定；「产品做什么」的决定在 [../DECISIONS.md](../DECISIONS.md)。做架构评审或大改之前先读这里，不要重新提已否决的方案。

| 编号 | 决定 |
|---|---|
| [0001](0001-feature-slices.md) | 源码按功能切片组织，import 规则由测试守住 |
| [0002](0002-shared-contracts.md) | 宿主与客户端共用按功能划分的契约类型 |
| [0003](0003-jsx.md) | 界面代码用 JSX |
| [0004](0004-styles-next-to-components.md) | 样式写在组件旁边，用同一个 defineSheet 声明 |
| [0005](0005-client-stores.md) | 客户端状态用「状态仓库 + 数据 adapter」，逻辑在组件之外测 |
| [0006](0006-dsh-yaml.md) | frontmatter 用 DSH 自带的 yaml 库解析 |
| [0007](0007-runtime-layout.md) | MCP 懒加载运行时按职责分文件，对外入口不变 |
