/**
 * 技能详情抽屉（UI-DESIGN §4）：概览 → 体检 → 来源与更新 → 文件 → SKILL.md（默认折叠），
 * 底部固定操作区只有一个弱化的红色「删除」。
 *
 * 概览与体检直接用列表行带过来的 skill（打开即见，不等请求）；
 * 只有「文件」与「SKILL.md」需要 GET skills/view，这两节自己取一次数据。
 * 来源与更新走远程部分的两段（inline，不是弹窗）。
 */

import * as React from "react";
import { Button, CodeBlock, Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import { Badge, Drawer, KeyValue, Section, SkeletonRows, kit } from "../../kit/index.ts";
import { viewSkill } from "./data.ts";
import { SkillSourceSection } from "./remote/source.tsx";
import {
  abbreviateHomePath,
  displayName,
  eolLabel,
  errorMessage,
  fileDepth,
  fileName,
  formatBytes,
  formatDateTime,
  invocationAccess,
  isFlatSkill,
  levelLabel,
  levelTone,
  modelAccessText,
  sortFiles,
  toggleBlockReason,
  toggleLabel,
  userAccessText,
} from "./format.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import type { RootInfo, SkillSummary, SkillView } from "../contract/local.ts";

export interface SkillDetailProps {
  /** 列表里那一行（抽屉头部的名称与开关立刻可用） */
  skill: SkillSummary;
  root: RootInfo | undefined;
  workspace: string | undefined;
  /** 用户家目录（index.tsx 从 roots 反推）；拿不到时路径不做 ~ 缩写。 */
  homeDir?: string;
  /** 启停在途 */
  busy: boolean;
  onToggle(next: boolean): void;
  /** 来源/更新这类写操作完成后刷新列表 */
  onChanged(): void;
  onOpenTrash(): void;
  onDelete(): void;
  onClose(): void;
}

/** 详情抽屉。 */
export function SkillDetailDrawer(props: SkillDetailProps): React.ReactElement {
  const { skill } = props;
  const [view, setView] = React.useState<SkillView | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);

  React.useEffect(() => {
    let alive = true;
    setView(undefined);
    setError(undefined);
    void viewSkill(skill.id, props.workspace).then(
      (payload) => {
        if (alive) setView(payload);
      },
      (failure: unknown) => {
        if (alive) setError(errorMessage(failure));
      },
    );
    return () => {
      alive = false;
    };
  }, [skill.id, props.workspace]);

  const name = displayName(skill).text;
  const blocked = toggleBlockReason(skill);
  const files = view === undefined ? [] : sortFiles(view.files);
  const root = props.root;

  // 家目录下的路径一律显示成 ~\…，完整路径放进 title 提示（UI-C）。
  const detailPath = abbreviateHomePath(skill.path, props.homeDir);
  const overviewItems = [
    { label: t("skills.detail.skillId"), value: skill.id, mono: true },
    {
      label: t("skills.detail.path"),
      value: React.createElement("span", { className: styles.pathWrap, "data-testid": "skills-detail-path" }, detailPath),
      ...(detailPath === skill.path ? {} : { title: skill.path }),
    },
    {
      label: t("skills.detail.root"),
      value: root === undefined
        ? skill.rootId
        : t("skills.detail.rootValue", {
          root: root.rootId,
          path: abbreviateHomePath(root.path, props.homeDir),
          mode: root.writable ? t("skills.root.writable") : t("skills.root.readonly"),
        }),
      ...(root === undefined ? {} : { title: root.path }),
    },
    {
      label: t("skills.detail.format"),
      value: t("skills.detail.formatValue", {
        eol: eolLabel(skill.format.eol),
        bom: skill.format.bom ? t("skills.detail.bomYes") : t("skills.detail.bomNo"),
        toggle: skill.format.safeToToggle ? t("skills.detail.safeYes") : t("skills.detail.safeNo"),
      }),
    },
    // 调用权限（D-B17）：模型调用由右上开关控制；用户调用只读展示（键缺省即允许）。
    { label: t("skills.access.model"), value: modelAccessText(invocationAccess(skill)), testId: "skills-detail-access-model" },
    { label: t("skills.access.user"), value: userAccessText(invocationAccess(skill)), testId: "skills-detail-access-user" },
    { label: t("skills.detail.visibility"), value: skill.modelVisible ? t("skills.detail.visibleYes") : t("skills.detail.visibleNo") },
    { label: t("skills.detail.mtime"), value: skill.mtimeMs > 0 ? formatDateTime(new Date(skill.mtimeMs).toISOString()) : t("skills.detail.none") },
    ...(skill.extraKeys.length === 0 ? [] : [{ label: t("skills.detail.extraKeys"), value: skill.extraKeys.join("、"), mono: true }]),
  ];

  const health = skill.diagnostics.length === 0
    ? React.createElement("p", { className: styles.note, "data-testid": "skills-detail-health-ok" }, t("skills.detail.healthOk"))
    : React.createElement("ul", { className: styles.diag, "data-testid": "skills-detail-diagnostics" },
      skill.diagnostics.map((diagnostic, index) => React.createElement("li", {
        key: diagnostic.code + "-" + String(index),
        className: styles.diagRow,
        "data-diag-level": diagnostic.level,
        "data-diag-code": diagnostic.code,
      },
      React.createElement(Badge, { tone: levelTone(diagnostic.level) }, levelLabel(diagnostic.level)),
      React.createElement("span", { className: styles.diagText }, diagnostic.message),
      React.createElement("code", { className: styles.code }, diagnostic.code))));

  const filesNode = error !== undefined
    ? React.createElement("p", { className: styles.errorBox, "data-testid": "skills-detail-error" }, t("skills.detail.failed", { message: error }))
    : view === undefined
      ? React.createElement(SkeletonRows, { rows: 3, testId: "skills-detail-loading" })
      : files.length === 0
        ? React.createElement("p", { className: styles.note }, t("skills.detail.none"))
        : React.createElement("div", { className: styles.files, "data-testid": "skills-detail-files" },
          files.map((file) => React.createElement("div", {
            key: file.path,
            className: styles.fileRow,
            style: { paddingLeft: String(fileDepth(file.path) * 12) + "px" },
          },
          React.createElement("span", { className: file.isDir ? styles.fileName + " " + styles.fileDir : styles.fileName }, file.isDir ? fileName(file.path) + "/" : fileName(file.path)),
          React.createElement("span", { className: styles.fileSize }, file.isDir ? "" : formatBytes(file.size)))));

  return React.createElement(Drawer, {
    open: true,
    title: name,
    subtitle: detailPath,
    subtitleTitle: skill.path,
    testId: "skills-detail",
    onClose: props.onClose,
    // 只读技能不放开关（与列表一致）：调用权限在「概览」里写明。
    ...(!skill.writable
      ? {}
      : {
          headerEnd: React.createElement(Switch, {
            checked: !skill.modelInvocationDisabled,
            disabled: props.busy || blocked !== undefined,
            label: toggleLabel(skill),
            ...(blocked === undefined ? {} : { title: blocked }),
            onChange: (next: boolean) => props.onToggle(next),
          }),
        }),
    footer: React.createElement(React.Fragment, null,
      React.createElement(Button, {
        variant: "ghost",
        size: "sm",
        className: kit.dangerButton,
        "data-testid": "skills-detail-delete",
        onClick: props.onDelete,
      }, isFlatSkill(skill) ? t("skills.delete.buttonFlat") : t("skills.delete.button"))),
  },
  React.createElement(Section, { title: t("skills.detail.overview"), testId: "skills-detail-overview" },
    React.createElement(KeyValue, { items: overviewItems, testId: "skills-detail-kv" })),
  React.createElement(Section, { title: t("skills.detail.health"), testId: "skills-detail-health" }, health),
  // 「来源与更新」是一整段：来源那部分渲染完之后，由它自己把「更新」接在下面（有来源时才出现）。
  React.createElement(Section, { title: t("skills.detail.source"), testId: "skills-detail-source" },
    React.createElement(SkillSourceSection, {
      skill,
      workspace: props.workspace,
      onChanged: props.onChanged,
      onOpenTrash: props.onOpenTrash,
    })),
  React.createElement(Section, {
    title: t("skills.detail.files"),
    end: view === undefined ? undefined : React.createElement("span", { className: styles.code }, t("skills.detail.filesCount", { count: files.length })),
    testId: "skills-detail-files-section",
  },
  filesNode,
  files.length >= 500 ? React.createElement("p", { className: styles.note }, t("skills.detail.filesTruncated")) : null),
  React.createElement(Section, {
    title: t("skills.detail.content"),
    collapsible: true,
    defaultCollapsed: true,
    testId: "skills-detail-content",
  },
  view === undefined
    ? null
    : React.createElement("div", { className: styles.codeWrap },
      React.createElement(CodeBlock, {
        code: view.content,
        lang: "markdown",
        lineNumbers: true,
        copyLabel: t("skills.detail.copy"),
        copiedLabel: t("skills.detail.copied"),
      }))));
}
