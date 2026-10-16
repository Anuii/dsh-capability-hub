/**
 * 提示词列表（UI-DESIGN §6）：一片 Surface + 两组（「全局」「当前工作区」）。
 *
 * 一处一事：一行只回答「这是什么、开没开」——标题是文件名，副标题是层 · 大小 · 各种状态，
 * 行尾是启停开关（停用 = 关）。完整路径与正文在详情抽屉里（detail.tsx）。
 * 分组与副标题怎么算全在 view-model.ts（纯函数，可单测）；本文件只渲染。
 */
import * as React from "react";
import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import { ListGroup, ListRow, ListSurface, SkeletonRows } from "../../kit/index.ts";
import { styles } from "./styles.ts";
import { t } from "./strings.ts";
import { groupPrompts, type PromptGroupView, type PromptRowView } from "./view-model.ts";
import type { PromptFile, PromptsListResult } from "../contract/prompts.ts";

export interface PromptListProps {
  list: PromptsListResult | undefined;
  /** 列表加载失败时的红字（列表照常渲染，只有错误另起一行） */
  error?: string;
  loading: boolean;
  /** 启停 / 新建在途的文件 id（开关置灰） */
  busyIds: ReadonlySet<string>;
  onToggle(file: PromptFile, next: boolean): void;
  onOpen(file: PromptFile): void;
}

/** 一行提示词；testId 用「组 + 组内序号」，稳定且与绝对路径无关。 */
function PromptRow(props: {
  row: PromptRowView;
  testId: string;
  busy: boolean;
  onToggle(file: PromptFile, next: boolean): void;
  onOpen(file: PromptFile): void;
}): React.ReactElement {
  const { row } = props;
  return (
    <ListRow
      testId={props.testId}
      title={row.title}
      subtitle={row.subtitle}
      subtitleMono
      subtitleTitle={row.subtitleTitle}
      trailing={
        <span data-testid={props.testId + "-toggle"}>
          <Switch
            checked={row.toggle.checked}
            disabled={row.toggle.disabled || props.busy}
            label={row.toggle.label}
            onChange={(next: boolean) => props.onToggle(row.file, next)}
          />
        </span>
      }
      onOpen={() => props.onOpen(row.file)}
    />
  );
}

/** 一组（全局 / 当前工作区）。 */
function Group(props: {
  group: PromptGroupView;
  busyIds: ReadonlySet<string>;
  onToggle(file: PromptFile, next: boolean): void;
  onOpen(file: PromptFile): void;
}): React.ReactElement {
  const { group } = props;
  const note = (key: string, text: string): React.ReactElement => (
    <li key={key} className={styles.treeNote} data-testid={"prompts-note-" + key}>
      {text}
    </li>
  );
  return (
    <ListGroup title={group.title} count={group.count} testId={"prompts-group-" + group.id}>
      {group.rows.map((row, index) => (
        <PromptRow
          key={row.file.id}
          row={row}
          testId={"prompts-row-" + group.id + "-" + String(index)}
          busy={props.busyIds.has(row.file.id)}
          onToggle={props.onToggle}
          onOpen={props.onOpen}
        />
      ))}
      {group.rows.length > 0 ? null : note(group.id, group.note ?? t("prompts.group.empty"))}
    </ListGroup>
  );
}

/** 提示词列表（工具栏与底部合计由 index.tsx 渲染）。 */
export function PromptList(props: PromptListProps): React.ReactElement {
  const groups = props.list === undefined ? [] : groupPrompts(props.list);
  return (
    <div className={styles.root} data-testid="prompts-list">
      {props.error === undefined ? null : (
        <p className={styles.errorBox} data-testid="prompts-list-error">
          {props.error}
        </p>
      )}
      {props.loading && props.list === undefined ? (
        <SkeletonRows testId="prompts-skeleton" />
      ) : (
        <ListSurface testId="prompts-surface">
          {groups.map((group) => (
            <Group
              key={group.id}
              group={group}
              busyIds={props.busyIds}
              onToggle={props.onToggle}
              onOpen={props.onOpen}
            />
          ))}
        </ListSurface>
      )}
    </div>
  );
}
