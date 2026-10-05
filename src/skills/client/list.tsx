/**
 * 技能列表（UI-DESIGN §3，D-B14 / D-B15）：**只通过 kit 拼界面**。
 *
 * 一处一事：一行只回答「这是什么、开没开」，长什么样由 row.ts 的 skillRowView 决定
 * （标题、目录标签、描述、标记、调用权限文字、开关）；其余信息全在详情抽屉里。
 *
 * 分组（tree.ts）：一级 = 层级（DSH 内置默认折叠 / 用户级 / 项目级），二级 = 来源仓库。
 * 折叠用 kit 的 useFold（规则见 kit/fold.ts），状态在本组件里（标签隐藏而不卸载，切标签不会丢）。
 */
import * as React from "react";
import { Badge, EmptyState, ListGroup, ListRow, ListSurface, SkeletonRows, kit, useFold } from "../../kit/index.ts";
import { useRemoteState } from "./remote/use-store.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { FilterId, MatchContext } from "./format.ts";
import { skillRowView } from "./row.ts";
import { SkillSwitch } from "./switch.tsx";
import {
  LEVELS,
  buildSkillTree,
  defaultExpanded,
  dirOptions,
  dirTagIndex,
  filterKeyOf,
  levelLabel,
  type LevelView,
} from "./tree.ts";
import type { ListResult, SkillSummary } from "../contract/local.ts";

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

/** 一行技能（长什么样由 row.ts 决定，这里只渲染）。 */
function SkillRow(props: {
  skill: SkillSummary;
  tag: { text: string; title: string } | undefined;
  context: MatchContext;
  busy: boolean;
  onToggle(skill: SkillSummary, next: boolean): void;
  onOpen(skill: SkillSummary): void;
}): React.ReactElement {
  const { skill } = props;
  const view = skillRowView(skill, {
    context: props.context,
    busy: props.busy,
    ...(props.tag === undefined ? {} : { dirTag: props.tag }),
  });
  return (
    <ListRow
      testId={"skills-row-" + skill.id}
      title={view.title}
      {...(view.tag === undefined ? {} : { tag: { ...view.tag, testId: "skills-dir-tag-" + skill.id } })}
      subtitle={view.subtitle}
      badges={view.badges.map((badge) => (
        <Badge
          key={badge.key}
          tone={badge.tone}
          {...(badge.title === undefined ? {} : { title: badge.title })}
          testId={"skills-badge-" + badge.key + "-" + skill.id}
        >
          {badge.label}
        </Badge>
      ))}
      note={{ ...view.access, testId: "skills-access-" + skill.id }}
      trailing={
        view.toggle === undefined ? (
          <span className={kit.trailingSpacer} aria-hidden="true" />
        ) : (
          <SkillSwitch toggle={view.toggle} onChange={(next) => props.onToggle(skill, next)} />
        )
      }
      onOpen={() => props.onOpen(skill)}
    />
  );
}

/** 工具栏里的「目录」筛选：原生下拉，按层级分段，含空目录与技能数。 */
export function DirFilter(props: {
  list: ListResult;
  value: string;
  onChange(rootId: string): void;
}): React.ReactElement {
  const options = dirOptions(props.list);
  return (
    <select
      className={kit.select}
      value={props.value}
      aria-label={t("skills.dirFilter.label")}
      title={options.find((option) => option.rootId === props.value)?.title ?? t("skills.dirFilter.label")}
      data-testid="skills-dir-filter"
      data-active={props.value === "" ? undefined : ""}
      onChange={(event: React.ChangeEvent<HTMLSelectElement>) => props.onChange(event.target.value)}
    >
      <option value="">{t("skills.dirFilter.all")}</option>
      {LEVELS.map((level) => {
        const items = options.filter((option) => option.level === level);
        if (items.length === 0) return null;
        return (
          <optgroup key={level} label={levelLabel(level)}>
            {items.map((option) => (
              <option key={option.rootId} value={option.rootId} title={option.title}>
                {t("skills.dirFilter.option", { tag: option.tag, count: option.count })}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}

/** 技能列表（工具栏由 index.tsx 渲染）。 */
export function SkillList(props: SkillListProps): React.ReactElement {
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
  const fold = useFold(filterKeyOf(props.query, props.filter, props.dir));
  const toggle = (key: string): void => fold.toggle(key, defaultExpanded(key));
  const expanded = (key: string): boolean => fold.expanded(key, defaultExpanded(key));

  /** 一行；目录标签只在该层级里有不止一个技能目录时显示。 */
  const rowIn =
    (level: LevelView) =>
    (skill: SkillSummary): React.ReactElement => (
      <SkillRow
        key={skill.id}
        skill={skill}
        tag={level.multiDir ? tags.get(skill.rootId) : undefined}
        context={props.context}
        busy={props.busyIds.has(skill.id)}
        onToggle={props.onToggle}
        onOpen={props.onOpen}
      />
    );

  const note = (key: string, text: string): React.ReactElement => (
    <li key={key} className={styles.treeNote} data-testid={"skills-tree-note-" + key}>
      {text}
    </li>
  );

  const levelBody = (level: LevelView): React.ReactNode => {
    if (level.noWorkspace === true) return note(level.level, t("skills.tree.noWorkspace"));
    if (level.flat) {
      if (level.skills.length > 0) return level.skills.map(rowIn(level));
      return note(level.level, level.level === "project" ? t("skills.tree.projectEmpty") : t("skills.tree.levelEmpty"));
    }
    return level.repos.map((repo) => (
      <ListGroup
        key={repo.key}
        depth={1}
        title={repo.label}
        count={repo.skills.length}
        expanded={expanded(repo.key)}
        onToggle={() => toggle(repo.key)}
        testId={"skills-repo-" + level.level + "-" + (repo.repo ?? "none")}
      >
        {repo.skills.map(rowIn(level))}
      </ListGroup>
    ));
  };

  const empty = props.list.skills.length === 0 && !tree.filtering;
  const surface =
    empty || (tree.filtering && tree.shown === 0) ? (
      <EmptyState
        testId="skills-empty"
        title={tree.filtering ? t("skills.emptyFiltered.title") : t("skills.empty.title")}
        description={tree.filtering ? t("skills.emptyFiltered.description") : t("skills.empty.description")}
        {...(tree.filtering
          ? {}
          : { action: { label: t("skills.addSkill"), onClick: props.onAdd, testId: "skills-empty-add" } })}
      />
    ) : (
      <ListSurface testId="skills-surface">
        {tree.levels.map((level) => (
          <ListGroup
            key={level.key}
            title={level.label}
            count={t("skills.root.count", { count: tree.filtering ? level.shown : level.total })}
            badges={
              level.level === "builtin" ? (
                <Badge tone="neutral" testId="skills-level-readonly">
                  {t("skills.root.readonly")}
                </Badge>
              ) : undefined
            }
            expanded={expanded(level.key)}
            onToggle={() => toggle(level.key)}
            nested={!level.flat}
            testId={"skills-level-" + level.level}
          >
            {levelBody(level)}
          </ListGroup>
        ))}
      </ListSurface>
    );

  return (
    <div
      className={styles.root}
      data-testid="skills-list"
      data-shown={String(tree.shown)}
      data-total={String(tree.total)}
    >
      {props.error === undefined ? null : (
        <p className={styles.errorBox} data-testid="skills-list-error">
          {props.error}
        </p>
      )}
      {props.loading && props.list.skills.length === 0 ? <SkeletonRows testId="skills-skeleton" /> : surface}
    </div>
  );
}
