/**
 * 「一行技能长什么样」（UI-DESIGN §3，D-B3 / D-B17）：列表行与详情抽屉共用的规则。
 *
 *   skillRowView(skill, …) → 标题、目录标签、副标题、标记、调用权限文字、开关（只读技能没有开关）
 *   skillToggle(skill, busy) → 开关的状态（列表行与详情头部同一份）
 *
 * 纯函数，不碰 React：node:test 直接测；列表（list.tsx）与详情（detail.tsx）只负责渲染。
 */

import type { BadgeTone } from "../../kit/index.ts";
import type { SkillSummary } from "../contract/local.ts";
import { displayName, type MatchContext } from "./format.ts";
import { t } from "./strings.ts";

/* ---------------- 整行 ---------------- */

/** 开关的状态。 */
export interface SkillToggle {
  /** 模型调用是否开着 */
  checked: boolean;
  disabled: boolean;
  /** 无障碍名 / 悬停文案 */
  label: string;
  /** 不能启停的原因（禁用时的悬停提示） */
  title?: string;
}

/**
 * 开关：只读技能（DSH 内置、只读的自定义目录）没有开关——禁用的开关容易被看成「已关闭」；
 * 不能安全改写时禁用并给原因；启停在途时禁用。
 */
export function skillToggle(skill: SkillSummary, busy: boolean): SkillToggle | undefined {
  if (!skill.writable) return undefined;
  const blocked = toggleBlockReason(skill);
  return {
    checked: !skill.modelInvocationDisabled,
    disabled: busy || blocked !== undefined,
    label: toggleLabel(skill),
    ...(blocked === undefined ? {} : { title: blocked }),
  };
}

export interface SkillRowView {
  title: string;
  /** 淡色目录标签（.agents / .dsh）；层级里只有一个目录时不显示 */
  tag?: { text: string; title: string };
  /** 描述；没有就是空串（行高保持一致） */
  subtitle: string;
  badges: RowBadge[];
  /** 行尾的调用权限文字；muted = 默认的「模型、用户」调淡，例外才醒目 */
  access: { text: string; title: string; muted: boolean };
  /** undefined = 只读技能，不放开关（行尾留同宽空位） */
  toggle?: SkillToggle;
}

export interface SkillRowOptions {
  context?: MatchContext;
  busy?: boolean;
  /** 该技能所在目录的标签；只在层级里有不止一个目录时传 */
  dirTag?: { text: string; title: string };
}

export function skillRowView(skill: SkillSummary, options: SkillRowOptions = {}): SkillRowView {
  const access = invocationAccess(skill);
  const toggle = skillToggle(skill, options.busy === true);
  return {
    title: displayName(skill).text,
    ...(options.dirTag === undefined ? {} : { tag: options.dirTag }),
    subtitle: skill.description ?? "",
    badges: rowBadges(skill, options.context),
    access: { text: invocationLabel(access), title: invocationTitle(access), muted: access.model && access.user },
    ...(toggle === undefined ? {} : { toggle }),
  };
}

/** 详情「概览」里的两行调用权限（模型调用 / 用户调用）。 */
export function accessLines(skill: SkillSummary): { model: string; user: string } {
  const access = invocationAccess(skill);
  return { model: modelAccessText(access), user: userAccessText(access) };
}

/* ---------------- 标记与启停 ---------------- */

export interface RowBadge {
  key: string;
  label: string;
  tone: BadgeTone;
  title?: string;
}

/**
 * 一行的标记（UI-DESIGN §4）：不可加载（danger）、可更新（accent）、被遮蔽（neutral），
 * 外加「没有 name 时用目录名」的兜底标记。行内最多显示 2 个（多的由 kit 截掉），
 * 所以这里的顺序就是优先级。
 */
export function rowBadges(skill: SkillSummary, context?: MatchContext): RowBadge[] {
  const badges: RowBadge[] = [];
  if (!skill.loadable) {
    badges.push({
      key: "notLoadable",
      label: t("skills.tag.notLoadable"),
      tone: "danger",
      title: t("skills.tag.notLoadableTitle"),
    });
  }
  if (context?.updatable?.has(skill.id) === true) {
    badges.push({
      key: "updatable",
      label: t("skills.tag.updatable"),
      tone: "accent",
      title: t("skills.tag.updatableTitle"),
    });
  }
  if (skill.shadowedBy !== undefined) {
    badges.push({
      key: "shadowed",
      label: t("skills.tag.shadowed"),
      tone: "neutral",
      title: t("skills.tag.shadowedTitle", { id: skill.shadowedBy }),
    });
  }
  if (displayName(skill).fromDir) {
    badges.push({ key: "noName", label: t("skills.tag.noName"), tone: "neutral", title: t("skills.name.hint") });
  }
  return badges;
}

/**
 * 不能启停时给出**人能看懂的原因**（D-B3 / 验收 U2）。
 * 返回 undefined = 可以启停。
 */
export function toggleBlockReason(skill: SkillSummary): string | undefined {
  if (!skill.writable) return t("skills.toggle.blockedReadonly");
  if (!skill.format.safeToToggle) {
    const detail = skill.diagnostics.find((item) => item.level === "error" || item.level === "warning");
    const base = t("skills.toggle.blockedUnsafe");
    return detail === undefined ? base : `${base}：${detail.message}`;
  }
  return undefined;
}

/** 启停开关的无障碍名 / 悬停文案。 */
export function toggleLabel(skill: SkillSummary): string {
  const name = displayName(skill).text;
  return skill.modelInvocationDisabled ? t("skills.toggle.enable", { name }) : t("skills.toggle.disable", { name });
}

/* ---------------- 调用权限（D-B17） ---------------- */

/**
 * 技能的调用权限，口径与 DSH 一致（dsh-skill-filesystem）：
 *   模型调用 = disable-model-invocation 不是 true（列表上的开关就是它，可改）；
 *   用户调用 = user-invocable 不是 false（只读展示，键缺省即允许）。
 */
export interface InvocationAccess {
  model: boolean;
  user: boolean;
  /** user-invocable 是否在 frontmatter 里显式写了 */
  userExplicit: boolean;
  /** 模型调用能不能在界面上改（技能所在目录可写） */
  editable: boolean;
}

export function invocationAccess(
  skill: Pick<SkillSummary, "modelInvocationDisabled" | "userInvocable"> & { writable?: boolean },
): InvocationAccess {
  return {
    model: !skill.modelInvocationDisabled,
    user: skill.userInvocable !== false,
    userExplicit: skill.userInvocable !== null,
    editable: skill.writable !== false,
  };
}

/** 行尾那一小段文字：模型、用户 / 仅模型 / 仅用户 / 不可调用。 */
export function invocationLabel(access: InvocationAccess): string {
  if (access.model && access.user) return t("skills.access.both");
  if (access.model) return t("skills.access.modelOnly");
  if (access.user) return t("skills.access.userOnly");
  return t("skills.access.none");
}

/** 模型调用的说明（详情与悬停提示共用）。 */
export function modelAccessText(access: InvocationAccess): string {
  if (!access.editable)
    return access.model ? t("skills.access.modelAllowedReadonly") : t("skills.access.modelDeniedReadonly");
  return access.model ? t("skills.access.modelAllowed") : t("skills.access.modelDenied");
}

/** 用户调用的说明：区分「默认允许」与「显式写了」。 */
export function userAccessText(access: InvocationAccess): string {
  if (!access.user) return t("skills.access.userDenied");
  return access.userExplicit ? t("skills.access.userAllowed") : t("skills.access.userDefault");
}

/** 行尾文字的悬停提示：两种调用各一行。 */
export function invocationTitle(access: InvocationAccess): string {
  return (
    t("skills.access.title") +
    "\n" +
    t("skills.access.model") +
    "：" +
    modelAccessText(access) +
    "\n" +
    t("skills.access.user") +
    "：" +
    userAccessText(access)
  );
}
