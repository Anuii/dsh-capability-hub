/**
 * 技能列表（UI-DESIGN §3，D-B14 / D-B15）：**只通过 kit 拼界面**。
 *
 * 一处一事：一行只回答「这是什么、开没开」——
 *   标题 = name（没有 name 时用目录名 + 「无名称」标记）+ 淡色目录标签（.agents / .dsh；层级里只有一个目录时不显示）
 *   副标题 = description（没有就是空行，保持行高一致）
 *   标记 = 不可加载 / 可更新 / 被遮蔽（最多 2 个，由 kit 截断）
 *   行尾 = 调用权限文字（模型、用户 / 仅模型 / 仅用户 / 不可调用，D-B17）+ 开关（模型调用；只读或不可安全改写时禁用，工具提示写原因）
 * 其余信息（来源、更新、诊断、文件、SKILL.md）全在详情抽屉里。
 *
 * 分组（tree.ts）：一级 = 层级（DSH 内置默认折叠 / 用户级 / 项目级），二级 = 来源仓库。
 * 折叠状态在本组件里（标签隐藏而不卸载，切标签不会丢）；搜索或任何筛选时有匹配的分组先展开，
 * 筛选中仍可折叠（只对这一次筛选有效），清空后回到原来的折叠。
 */
import * as React from "react";
import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, EmptyState, ListGroup, ListRow, ListSurface, SkeletonRows, kit } from "../../kit/index.ts";
import { useRemoteState } from "./remote/use-store.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import {
  displayName,
  invocationAccess,
  invocationLabel,
  invocationTitle,
  rowBadges,
  toggleBlockReason,
  toggleLabel,
  type FilterId,
  type MatchContext,
} from "./format.ts";
import {
  LEVELS,
  buildSkillTree,
  dirOptions,
  dirTagIndex,
  filterKeyOf,
  initialFoldState,
  isFoldExpanded,
  levelLabel,
  toggleFold,
  type FoldState,
  type LevelView,
} from "./tree.ts";
import type { ListResult, SkillSummary } from "./types.ts";

export interface SkillListProps {
  list: ListResult;
  workspace: string | undefined;
  /** 用户家目录（index.tsx 从 roots 反推）；拿不到时路径不做 ~ 缩写。 */
  homeDir?: string;
  query: string;
  filter: FilterId;
  /** 目录筛选（rootId）；"" = 全部目录 */
  dir: string;
  context: MatchContext;
  /** 启停在途的技能 id（开关置灰） */
  busyIds: ReadonlySet<string>;
  /** 列表加载失败时的红字（列表照常渲染，只有错误另起一行） */
  error?: string;
  /** 首次加载（还没有任何数据）时给骨架屏 */
  loading: boolean;
  onToggle(skill: SkillSummary, next: boolean): void;
  onOpen(skill: SkillSummary): void;
  onAdd(): void;
}

/** 一行技能。 */
function SkillRow(props: {
  skill: SkillSummary;
  tag: { text: string; title: string } | undefined;
  context: MatchContext;
  busy: boolean;
  onToggle(skill: SkillSummary, next: boolean): void;
  onOpen(skill: SkillSummary): void;
}): React.ReactElement {
  const { skill } = props;
  const name = displayName(skill);
  const blocked = toggleBlockReason(skill);
  const badges = rowBadges(skill, props.context);
  const access = invocationAccess(skill);
  return React.createElement(ListRow, {
    testId: "skills-row-" + skill.id,
    title: name.text,
    ...(props.tag === undefined ? {} : { tag: { ...props.tag, testId: "skills-dir-tag-" + skill.id } }),
    // 空描述也渲染副标题：行高保持 52px，列表看起来是一条直线（UI-DESIGN §1）
    subtitle: skill.description ?? "",
    badges: badges.map((badge) => React.createElement(Badge, {
      key: badge.key,
      tone: badge.tone,
      ...(badge.title === undefined ? {} : { title: badge.title }),
      testId: "skills-badge-" + badge.key + "-" + skill.id,
    }, badge.label)),
    // 调用权限（D-B17）：开关管模型调用，这段文字把两种调用一起说清楚，悬停看来源。
    // 默认的「模型、用户」调淡，例外（仅模型 / 仅用户 / 不可调用）才醒目。
    note: {
      text: invocationLabel(access),
      title: invocationTitle(access),
      muted: access.model && access.user,
      testId: "skills-access-" + skill.id,
    },
    // 只读技能（DSH 内置、自定义只读目录）不放开关——禁用的开关容易被看成「已关闭」；
    // 留一个同宽空位让行尾文字仍对齐。层级标题上已标「只读」。
    trailing: !skill.writable
      ? React.createElement("span", { className: kit.trailingSpacer, "aria-hidden": "true" })
      : React.createElement(Switch, {
        checked: !skill.modelInvocationDisabled,
        disabled: props.busy || blocked !== undefined,
        label: toggleLabel(skill),
        ...(blocked === undefined ? {} : { title: blocked }),
        onChange: (next: boolean) => props.onToggle(skill, next),
      }),
    onOpen: () => props.onOpen(skill),
  });
}

/** 工具栏里的「目录」筛选：原生下拉，按层级分段，含空目录与技能数。 */
export function DirFilter(props: {
  list: ListResult;
  value: string;
  onChange(rootId: string): void;
}): React.ReactElement {
  const options = dirOptions(props.list);
  return React.createElement("select", {
    className: kit.select,
    value: props.value,
    "aria-label": t("skills.dirFilter.label"),
    title: options.find((option) => option.rootId === props.value)?.title ?? t("skills.dirFilter.label"),
    "data-testid": "skills-dir-filter",
    "data-active": props.value === "" ? undefined : "",
    onChange: (event: React.ChangeEvent<HTMLSelectElement>) => props.onChange(event.target.value),
  },
  React.createElement("option", { value: "" }, t("skills.dirFilter.all")),
  LEVELS.map((level) => {
    const items = options.filter((option) => option.level === level);
    if (items.length === 0) return null;
    return React.createElement("optgroup", { key: level, label: levelLabel(level) },
      items.map((option) => React.createElement("option", {
        key: option.rootId,
        value: option.rootId,
        title: option.title,
      }, t("skills.dirFilter.option", { tag: option.tag, count: option.count }))));
  }));
}

/** 技能列表（工具栏由 index.tsx 渲染）。 */
export function SkillList(props: SkillListProps): React.ReactElement {
  const [fold, setFold] = React.useState<FoldState>(initialFoldState);
  const remote = useRemoteState();
  const sourcesReady = remote.sourcesLoaded && remote.sourcesError === undefined;
  const hasWorkspace = typeof props.workspace === "string" && props.workspace.trim() !== "";
  const tree = buildSkillTree({
    list: props.list,
    query: props.query,
    filter: props.filter,
    context: props.context,
    dir: props.dir,
    hasWorkspace,
    ...(sourcesReady ? { sources: remote.sources } : {}),
  });
  const tags = React.useMemo(() => dirTagIndex(props.list.roots), [props.list.roots]);
  // 筛选时有匹配的分组先全部展开，但仍可手动折叠（只在这一次筛选里有效），清空后回到原来的折叠。
  const filterKey = filterKeyOf(props.query, props.filter, props.dir);
  const toggle = (key: string): void => setFold((current) => toggleFold(current, filterKey, key));
  const expanded = (key: string): boolean => isFoldExpanded(fold, filterKey, key);

  /** 一行；目录标签只在该层级里有不止一个技能目录时显示。 */
  const rowIn = (level: LevelView) => (skill: SkillSummary): React.ReactElement => React.createElement(SkillRow, {
    key: skill.id,
    skill,
    tag: level.multiDir ? tags.get(skill.rootId) : undefined,
    context: props.context,
    busy: props.busyIds.has(skill.id),
    onToggle: props.onToggle,
    onOpen: props.onOpen,
  });

  const note = (key: string, text: string): React.ReactElement =>
    React.createElement("li", { key, className: styles.treeNote, "data-testid": "skills-tree-note-" + key }, text);

  const levelBody = (level: LevelView): React.ReactNode => {
    if (level.noWorkspace === true) return note(level.level, t("skills.tree.noWorkspace"));
    if (level.flat) {
      if (level.skills.length > 0) return level.skills.map(rowIn(level));
      return note(level.level, level.level === "project" ? t("skills.tree.projectEmpty") : t("skills.tree.levelEmpty"));
    }
    return level.repos.map((repo) => React.createElement(ListGroup, {
      key: repo.key,
      depth: 1,
      title: repo.label,
      count: repo.skills.length,
      expanded: expanded(repo.key),
      onToggle: () => toggle(repo.key),
      testId: "skills-repo-" + level.level + "-" + (repo.repo ?? "none"),
    }, repo.skills.map(rowIn(level))));
  };

  const empty = props.list.skills.length === 0 && !tree.filtering;
  const surface = empty || (tree.filtering && tree.shown === 0)
    ? React.createElement(EmptyState, {
      testId: "skills-empty",
      title: tree.filtering ? t("skills.emptyFiltered.title") : t("skills.empty.title"),
      description: tree.filtering ? t("skills.emptyFiltered.description") : t("skills.empty.description"),
      ...(tree.filtering
        ? {}
        : { action: { label: t("skills.addSkill"), onClick: props.onAdd, testId: "skills-empty-add" } }),
    })
    : React.createElement(ListSurface, { testId: "skills-surface" },
      tree.levels.map((level) => React.createElement(ListGroup, {
        key: level.key,
        title: level.label,
        count: t("skills.root.count", { count: tree.filtering ? level.shown : level.total }),
        badges: level.level === "builtin"
          ? React.createElement(Badge, { tone: "neutral", testId: "skills-level-readonly" }, t("skills.root.readonly"))
          : undefined,
        expanded: expanded(level.key),
        onToggle: () => toggle(level.key),
        nested: !level.flat,
        testId: "skills-level-" + level.level,
      }, levelBody(level))));

  return React.createElement("div", {
    className: styles.root,
    "data-testid": "skills-list",
    "data-shown": String(tree.shown),
    "data-total": String(tree.total),
  },
  props.error === undefined
    ? null
    : React.createElement("p", { className: styles.errorBox, "data-testid": "skills-list-error" }, props.error),
  props.loading && props.list.skills.length === 0
    ? React.createElement(SkeletonRows, { testId: "skills-skeleton" })
    : surface);
}
