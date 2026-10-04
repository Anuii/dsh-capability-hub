/**
 * 技能列表（UI-DESIGN §4）：**只通过 kit 拼界面**。
 *
 * 一处一事：一行只回答「这是什么、开没开」——
 *   标题 = name（没有 name 时用目录名 + 「无名称」标记）
 *   副标题 = description（没有就是空行，保持行高一致）
 *   标记 = 不可加载 / 可更新 / 被遮蔽（最多 2 个，由 kit 截断）
 *   trailing = 开关（只读或不可安全改写时禁用，工具提示写原因）
 * 其余信息（来源、更新、诊断、文件、SKILL.md）全在详情抽屉里。
 *
 * 分组：空的与不存在的根**隐藏**，底部用一行次要色小字「另有 N 个空的技能目录 · 显示」切换。
 */
import * as React from "react";
import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, EmptyState, ListFoot, ListGroup, ListRow, ListSurface, SkeletonRows } from "../shell/kit/index.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import {
  displayName,
  listView,
  rootGroupTitle,
  rootMetaPath,
  rootPathTitle,
  rowBadges,
  toggleBlockReason,
  toggleLabel,
  type FilterId,
  type MatchContext,
} from "./format.ts";
import type { ListResult, RootInfo, SkillSummary } from "./types.ts";

export interface SkillListProps {
  list: ListResult;
  workspace: string | undefined;
  /** 用户家目录（index.tsx 从 roots 反推）；拿不到时路径不做 ~ 缩写。 */
  homeDir?: string;
  query: string;
  filter: FilterId;
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
  context: MatchContext;
  busy: boolean;
  onToggle(skill: SkillSummary, next: boolean): void;
  onOpen(skill: SkillSummary): void;
}): React.ReactElement {
  const { skill } = props;
  const name = displayName(skill);
  const blocked = toggleBlockReason(skill);
  const badges = rowBadges(skill, props.context);
  return React.createElement(ListRow, {
    testId: "skills-row-" + skill.id,
    title: name.text,
    // 空描述也渲染副标题：行高保持 52px，列表看起来是一条直线（UI-DESIGN §1）
    subtitle: skill.description ?? "",
    badges: badges.map((badge) => React.createElement(Badge, {
      key: badge.key,
      tone: badge.tone,
      ...(badge.title === undefined ? {} : { title: badge.title }),
      testId: "skills-badge-" + badge.key + "-" + skill.id,
    }, badge.label)),
    trailing: React.createElement(Switch, {
      checked: !skill.modelInvocationDisabled,
      disabled: props.busy || blocked !== undefined,
      label: toggleLabel(skill),
      ...(blocked === undefined ? {} : { title: blocked }),
      onChange: (next: boolean) => props.onToggle(skill, next),
    }),
    onOpen: () => props.onOpen(skill),
  });
}

/** 一个分组的标题行上的标记：只读 / 目录不存在（可写且存在时什么也不显示）。 */
function groupBadges(root: RootInfo): React.ReactNode[] {
  const badges: React.ReactNode[] = [];
  if (!root.writable) {
    badges.push(React.createElement(Badge, { key: "ro", tone: "neutral", testId: "skills-root-readonly-" + root.rootId }, t("skills.root.readonly")));
  }
  if (!root.exists) {
    badges.push(React.createElement(Badge, { key: "missing", tone: "neutral", testId: "skills-root-missing-" + root.rootId }, t("skills.root.missing")));
  }
  return badges;
}

/** 技能列表（工具栏由 index.tsx 渲染）。 */
export function SkillList(props: SkillListProps): React.ReactElement {
  const [showEmpty, setShowEmpty] = React.useState<boolean>(false);
  const view = listView(props.list, props.query, props.filter, props.context);
  const filtering = props.query.trim() !== "" || props.filter !== "all";
  const groups = showEmpty ? [...view.visible, ...view.hidden] : view.visible;

  const surface = groups.length === 0
    ? React.createElement(EmptyState, {
      testId: "skills-empty",
      title: filtering ? t("skills.emptyFiltered.title") : t("skills.empty.title"),
      description: filtering ? t("skills.emptyFiltered.description") : t("skills.empty.description"),
      ...(filtering
        ? {}
        : { action: { label: t("skills.addSkill"), onClick: props.onAdd, testId: "skills-empty-add" } }),
    })
    : React.createElement(ListSurface, { testId: "skills-surface" },
      groups.map((entry) => {
        const root = entry.group.root;
        const badges = groupBadges(root);
        const meta = rootMetaPath(root, props.workspace, props.homeDir);
        return React.createElement(ListGroup, {
          key: root.rootId,
          title: rootGroupTitle(root),
          // DSH 内置根的 meta 是 undefined：标题上不显示那串 asar 路径，完整路径只走 title 提示。
          ...(meta === undefined ? {} : { meta, metaTitle: rootPathTitle(root) }),
          headTitle: rootPathTitle(root),
          count: t("skills.root.count", { count: entry.total }),
          badges: badges.length === 0 ? undefined : badges,
          testId: "skills-root-" + root.rootId,
        }, entry.shown.map((skill) => React.createElement(SkillRow, {
          key: skill.id,
          skill,
          context: props.context,
          busy: props.busyIds.has(skill.id),
          onToggle: props.onToggle,
          onOpen: props.onOpen,
        })));
      }));

  return React.createElement("div", {
    className: styles.root,
    "data-testid": "skills-list",
    "data-shown": String(view.shown),
    "data-total": String(view.total),
  },
  props.error === undefined
    ? null
    : React.createElement("p", { className: styles.errorBox, "data-testid": "skills-list-error" }, props.error),
  props.loading && props.list.skills.length === 0
    ? React.createElement(SkeletonRows, { testId: "skills-skeleton" })
    : surface,
  view.hidden.length === 0
    ? null
    : React.createElement(ListFoot, {
      testId: "skills-empty-roots",
      textTestId: "skills-empty-roots-text",
      text: t("skills.list.emptyRoots", { count: view.hidden.length }),
      action: {
        label: showEmpty ? t("skills.list.hideEmpty") : t("skills.list.showEmpty"),
        testId: "skills-empty-roots-toggle",
        expanded: showEmpty,
        onClick: () => setShowEmpty((value) => !value),
      },
    }));
}
