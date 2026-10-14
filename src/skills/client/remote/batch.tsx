/**
 * 工具栏「⋯」里的远程动作（UI-DESIGN §4）：检查全部更新 / 全部更新（n）/ GitHub 镜像…。
 *
 * 为什么做成 hook：菜单项是**数据**（Toolbar 的 more 收 MenuItem[]）；
 * hook 在标签页里被无条件调用一次，天然满足 hooks 规则。
 *
 * 「检查全部更新」的结果不再常驻成胶囊，而是走 Toast，并让有更新的行出现「可更新」标记。
 * GitHub 凭据与剩余配额那一项已删除（使用者决定）：被限流时由宿主的错误文案说明，客户端照常显示在 Toast 里。
 *
 * 「GitHub 镜像…」只换下载走的镜像（D-B18）：规则与状态在 mirror-model.ts，对话框在 mirror-dialog.tsx。
 */

import * as React from "react";
import { useStoreState } from "../../../kit/index.ts";
import type { MenuItem } from "../../../kit/index.ts";
import { ensureSources } from "./cache.ts";
import { applyUpdates, checkUpdates, mirrorApi } from "./data.ts";
import { createMirrorStore, mirrorMenuLabel, type MirrorStore } from "./mirror-model.ts";
import { MirrorDialog } from "./mirror-dialog.tsx";

import { remoteStore } from "./store.ts";
import { applySummaryText, checkSummaryText, summarizeApplies, summarizeChecks, updatableIds } from "./model.ts";

import { t } from "../strings.ts";
import type { SkillSummary } from "../../contract/local.ts";
import { errorText } from "../../../shared/error-text.ts";

export interface RemoteMenuProps {
  /** 列表里的全部技能（不受搜索/筛选影响） */
  skills: readonly SkillSummary[];
  workspace: string | undefined;
  /** 写操作完成后刷新列表 */
  onChanged?: () => void;
  /** 跳到回收站 */
  onOpenTrash(): void;
  /** 一句结果反馈（走标签页的 Toast） */
  notify(text: string, tone?: "success"): void;
}

export interface RemoteMenu {
  /** 三个动作项（检查全部更新 / 全部更新 / GitHub 镜像…）；调用方在后面接「回收站」等自己的项 */
  items: MenuItem[];
  dialogs: React.ReactNode;
  /** 当前标着「可更新」的技能 id（行标记与「需关注」筛选都用它） */
  updatable: ReadonlySet<string>;
}

/** 标签页共用的那一个镜像设置仓库（懒加载：第一次打开对话框时才读设置）。 */
const mirrorStore: MirrorStore = createMirrorStore(mirrorApi);

/** ⋯ 菜单里的远程动作。 */
export function useSkillsRemoteMenu(props: RemoteMenuProps): RemoteMenu {
  const { skills, workspace, onChanged, onOpenTrash, notify } = props;
  const state = useStoreState(remoteStore.state);
  const mirror = useStoreState(mirrorStore.state);
  const [checking, setChecking] = React.useState<boolean>(false);
  const [applying, setApplying] = React.useState<boolean>(false);

  React.useEffect(() => {
    void ensureSources(workspace);
  }, [workspace]);

  // 菜单标签要带上已设置的镜像主机名，所以进页面就读一次设置（只读本地文件；失败只降级成「没设置」）
  React.useEffect(() => {
    void mirrorStore.ensureLoaded();
  }, []);

  const ids = updatableIds(skills, state.checks);
  const updatable = React.useMemo(() => new Set(ids), [ids.join("|")]);
  const runCheckAll = (): void => {
    setChecking(true);
    void checkUpdates(undefined, workspace).then(
      (payload) => {
        remoteStore.setChecks(payload.results);
        notify(checkSummaryText(summarizeChecks(payload.results)));
        setChecking(false);
      },
      (failure: unknown) => {
        notify(t("skills.toast.failed", { message: errorText(failure) }));
        setChecking(false);
      },
    );
  };

  const runUpdateAll = (): void => {
    setApplying(true);
    void applyUpdates(ids, workspace).then(
      (payload) => {
        notify(applySummaryText(summarizeApplies(payload.results)), "success");
        for (const item of payload.results) {
          remoteStore.setCheck(
            item.ok
              ? { skillId: item.skillId, status: "up-to-date" }
              : {
                  skillId: item.skillId,
                  status: "error",
                  ...(item.message === undefined ? {} : { message: item.message }),
                },
          );
        }
        setApplying(false);
        onChanged?.();
      },
      (failure: unknown) => {
        notify(t("skills.toast.failed", { message: errorText(failure) }));
        setApplying(false);
      },
    );
  };

  const items: MenuItem[] = [
    {
      id: "check-all",
      label: checking ? t("skills.remote.menu.checking") : t("skills.remote.menu.checkAll"),
      onClick: runCheckAll,
      disabled: checking || applying,
      testId: "skills-remote-check-all",
    },
    {
      id: "update-all",
      label: applying ? t("skills.remote.menu.applying") : t("skills.remote.menu.updateAll", { count: ids.length }),
      onClick: runUpdateAll,
      disabled: applying || checking || ids.length === 0,
      testId: "skills-remote-update-all",
    },
    {
      id: "mirror",
      label: mirrorMenuLabel(mirror.current),
      onClick: () => mirrorStore.open(),
      testId: "skills-remote-mirror",
    },
  ];

  return {
    items,
    dialogs: <MirrorDialog store={mirrorStore} onSaved={(text: string) => notify(text, "success")} />,
    updatable,
  };
}
