/**
 * kit 预览面板 —— **开发用**，只在 URL 带 ?hubKitPreview=1 时渲染（正式使用时看不到）。
 *
 * 目的：让「审美是否到位」这件事可以被截图审查，而不是靠读 CSS 想象。
 * 这里用假数据把 kit 的每一种形态都摆一遍：工具栏、两个分组（含只读标记）、
 * 各种标记与状态点、禁用的开关、悬停操作、打开的抽屉（Section / KeyValue /
 * 折叠区 / 底部危险按钮）、空状态、骨架屏、横幅。
 *
 * 它只 import kit 自己的组件与样式 —— 预览本身就是 kit 的第一个消费者。
 */
import * as React from "react";
import { Button, CodeBlock, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import { kit } from "./styles.ts";
import { Drawer } from "./Drawer.tsx";
import { Banner, EmptyState, SkeletonRows } from "./Feedback.tsx";
import { ListFoot, ListGroup, ListRow, ListSurface } from "./ListSurface.tsx";
import { KeyValue, Section } from "./Section.tsx";
import { Badge } from "./Badge.tsx";
import { Toolbar } from "./Toolbar.tsx";
import type { MenuItem } from "./menu.tsx";
import { searchFlag } from "./pure.ts";

/** 预览用的假数据（刻意覆盖每一种视觉形态）。 */
const MORE_ITEMS: MenuItem[] = [
  { id: "check-all", label: "检查全部更新" },
  { id: "infer", label: "为无来源技能推测来源" },
  { id: "trash", label: "回收站", hint: "2", separatorBefore: true },
  { id: "github", label: "GitHub：已连接 · 剩余配额 42", info: true, separatorBefore: true },
];

/** 一行假的诊断。 */
function DiagnosticList(): React.ReactElement {
  return (
    <ul className={kit.previewNote} style={{ margin: 0, paddingLeft: 18 }}>
      <li>SKILL.md 缺少 frontmatter 的 description 字段</li>
      <li>目录名与 name 不一致：deno-helper</li>
    </ul>
  );
}

/** 预览面板本体。 */
export function KitPreview(): React.ReactElement {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [drawerOpen, setDrawerOpen] = React.useState<boolean>(
    !searchFlag(typeof location === "undefined" ? "" : location.search, "hubKitDrawer"),
  );

  const filters = [
    { id: "all", label: "全部", count: 12 },
    { id: "enabled", label: "已启用", count: 9 },
    { id: "disabled", label: "已停用", count: 3 },
    { id: "attention", label: "需关注", count: 2 },
  ];

  const groupA = (
    <ListGroup title="用户级" meta="~/.agents/skills" count={8}>
      <ListRow
        testId="kit-row-1"
        title="find-skills"
        subtitle="Finds and installs skills from the community index, then wires them into the workspace."
        trailing={<Switch checked label="启用 find-skills" onChange={() => undefined} />}
        onOpen={() => setDrawerOpen(true)}
      />
      <ListRow
        testId="kit-row-2"
        title="archify"
        subtitle="Create polished, validated architecture and workflow diagrams as standalone HTML."
        badges={[
          <Badge tone="accent" key="u">
            可更新
          </Badge>,
        ]}
        trailing={<Switch checked label="启用 archify" onChange={() => undefined} />}
        hoverActions={[
          { label: "检查更新", onClick: () => undefined, testId: "kit-row-2-check" },
          { label: "更新", onClick: () => undefined, testId: "kit-row-2-update" },
        ]}
        onOpen={() => setDrawerOpen(true)}
      />
      <ListRow
        testId="kit-row-3"
        title="mcp-manager"
        subtitle="SKILL.md 解析失败：frontmatter 第 4 行缺少冒号"
        badges={[
          <Badge tone="danger" key="e">
            不可加载
          </Badge>,
        ]}
        trailing={
          <Switch
            checked={false}
            disabled
            label="启用 mcp-manager"
            title="该技能无法加载，开关已锁定"
            onChange={() => undefined}
          />
        }
        onOpen={() => setDrawerOpen(true)}
      />
      <ListRow
        testId="kit-row-4"
        title="deno-helper"
        badges={[
          <Badge tone="neutral" key="n" title="目录名 deno-helper 与 name 不一致">
            无名称
          </Badge>,
        ]}
        trailing={<Switch checked={false} label="启用 deno-helper" onChange={() => undefined} />}
        onOpen={() => setDrawerOpen(true)}
      />
      <ListRow
        testId="kit-row-5"
        title="grill-me"
        subtitle="Grill me relentlessly about a plan, decision, or idea."
        trailing={<Switch checked label="启用 grill-me" onChange={() => undefined} />}
        hoverActions={[
          { label: "查看", onClick: () => undefined, testId: "kit-row-5-view" },
          { label: "删除", danger: true, onClick: () => undefined, testId: "kit-row-5-delete" },
        ]}
        onOpen={() => setDrawerOpen(true)}
      />
    </ListGroup>
  );

  const groupB = (
    <ListGroup
      title="项目级"
      meta=".dsh/skills"
      count={4}
      badges={
        <Badge tone="neutral" title="该目录不在用户可写范围内">
          只读
        </Badge>
      }
    >
      <ListRow
        testId="kit-row-6"
        title="repo-guard"
        subtitle="阻止在受保护分支上直接提交。"
        leading="active"
        trailing={<Switch checked label="启用 repo-guard" onChange={() => undefined} />}
        onOpen={() => setDrawerOpen(true)}
      />
      <ListRow
        testId="kit-row-7"
        title="legacy-lint"
        subtitle="npm run lint --fix"
        subtitleMono
        leading="failed"
        badges={[
          <Badge tone="danger" key="f">
            加载失败
          </Badge>,
        ]}
        trailing={
          <Switch
            checked={false}
            disabled
            label="启用 legacy-lint"
            title="只读根下的技能不能改开关"
            onChange={() => undefined}
          />
        }
        onOpen={() => setDrawerOpen(true)}
      />
      <ListRow
        testId="kit-row-8"
        title="slow-index"
        subtitle="上一次失败：ETIMEDOUT · 冷却 47s"
        leading="cooling"
        badges={[
          <Badge tone="warn" key="w">
            冷却 47s
          </Badge>,
        ]}
        trailing={<Switch checked label="启用 slow-index" onChange={() => undefined} />}
        onOpen={() => setDrawerOpen(true)}
      />
      <ListRow
        testId="kit-row-9"
        title="idle-helper"
        leading="idle"
        trailing={<Switch checked label="启用 idle-helper" onChange={() => undefined} />}
        onOpen={() => setDrawerOpen(true)}
      />
      <ListRow
        testId="kit-row-10"
        title="drag-and-drop"
        subtitle="cmd /c npx -y some-mcp-server --stdio"
        subtitleMono
        dragHandle
        trailing={<Switch checked label="启用 drag-and-drop" onChange={() => undefined} />}
        onOpen={() => setDrawerOpen(true)}
      />
    </ListGroup>
  );

  const drawer = (
    <Drawer
      open={drawerOpen}
      title="find-skills"
      /* 副标题单行截断：完整路径在 title 提示里（UI-C） */ subtitle={"~\\.agents\\skills\\find-skills"}
      subtitleTitle={"C:\\Users\\you\\.agents\\skills\\find-skills"}
      testId="kit-drawer"
      onClose={() => setDrawerOpen(false)}
      headerEnd={<Switch checked label="启用 find-skills" onChange={() => undefined} />}
      /* 底部操作区**只在有操作时才给**，而且不放「关闭」——已经有头部 × 和 Esc 了。 */ footer={
        <Button variant="ghost" className={kit.dangerButton} data-testid="kit-drawer-delete" onClick={() => undefined}>
          删除
        </Button>
      }
    >
      <Section title="概览" testId="kit-section-overview">
        <KeyValue
          items={[
            { label: "skillId", value: "user-agents:find-skills", mono: true },
            { label: "位置", value: "C:\\Users\\you\\.agents\\skills\\find-skills", mono: true },
            { label: "根", value: "~/.agents/skills", mono: true },
            { label: "格式", value: "目录（SKILL.md）" },
            { label: "用户可调用", value: "是" },
            { label: "修改时间", value: "2026-10-04 22:18" },
          ]}
        />
      </Section>
      <Section title="体检" testId="kit-section-health">
        <DiagnosticList />
      </Section>
      <Section title="来源与更新" collapsible testId="kit-section-source">
        <KeyValue
          items={[
            { label: "来源", value: "github.com/anthropics/skills", mono: true },
            { label: "登记时间", value: "2026-09-28 09:12" },
          ]}
        />
      </Section>
      <Section title="SKILL.md" collapsible defaultCollapsed testId="kit-section-skillmd">
        <CodeBlock code={"---\nname: find-skills\n---\n# find-skills\n"} lang="markdown" showHeader={false} />
      </Section>
    </Drawer>
  );

  return (
    <div className={kit.preview} data-testid="hub-kit-preview">
      <p className={kit.previewNote}>
        {"开发预览：仅在 URL 带 "}
        <code>?hubKitPreview=1</code>
        {" 时出现。加 "}
        <code>hubKitDrawer=1</code>
        {" 可让抽屉默认关闭。"}
      </p>
      <div className={kit.previewBand}>
        <p className={kit.previewCaption}>Banner</p>
        <Banner
          tone="warn"
          testId="kit-banner"
          action={{ label: "查看详情", onClick: () => undefined, testId: "kit-banner-action" }}
        >
          部分功能不可用：mcp-runtime
        </Banner>
      </div>
      <div className={kit.previewBand}>
        <p className={kit.previewCaption}>Toolbar</p>
        <Toolbar
          testId="kit-toolbar"
          search={{ value: query, onChange: setQuery, placeholder: "搜索技能", testId: "kit-search" }}
          filters={{ items: filters, value: filter, onChange: setFilter, label: "筛选技能" }}
          primary={{ label: "添加技能", onClick: () => undefined, testId: "kit-primary" }}
          more={MORE_ITEMS}
        />
      </div>
      <div className={kit.previewBand}>
        <p className={kit.previewCaption}>ListSurface · 两个分组（第二个是只读根）</p>
        <ListSurface testId="kit-surface">
          {groupA}
          {groupB}
        </ListSurface>
      </div>
      <div className={kit.previewBand}>
        <p className={kit.previewCaption}>ListFoot（列表脚注）+ 无标题分组</p>
        <ListSurface>
          <ListGroup testId="kit-group-untitled">
            <ListRow
              testId="kit-row-11"
              title="只有一组时不给标题（MCP 页的用法）"
              trailing={<Switch checked label="启用无标题分组示例" onChange={() => undefined} />}
            />
          </ListGroup>
        </ListSurface>
        <ListFoot
          testId="kit-foot"
          text="另有 3 个空的技能目录"
          action={{ label: "显示", testId: "kit-foot-action", expanded: false, onClick: () => undefined }}
        />
      </div>
      <div className={kit.previewBand}>
        <p className={kit.previewCaption}>EmptyState</p>
        <EmptyState
          testId="kit-empty"
          title="没有可显示的技能"
          description="换一个筛选条件，或者从仓库安装一个新的技能。"
          action={{ label: "添加技能", onClick: () => undefined, testId: "kit-empty-action" }}
        />
      </div>
      <div className={kit.previewBand}>
        <p className={kit.previewCaption}>SkeletonRows（加载态）</p>
        <SkeletonRows testId="kit-skeleton" />
      </div>
      {drawer}
    </div>
  );
}
