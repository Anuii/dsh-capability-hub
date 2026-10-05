/** 技能的模型调用开关（列表行与详情抽屉头部共用；状态来自 row.ts 的 skillToggle）。 */

import * as React from "react";
import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import type { SkillToggle } from "./row.ts";

export function SkillSwitch(props: { toggle: SkillToggle; onChange(next: boolean): void }): React.ReactElement {
  const { toggle } = props;
  return (
    <Switch
      checked={toggle.checked}
      disabled={toggle.disabled}
      label={toggle.label}
      {...(toggle.title === undefined ? {} : { title: toggle.title })}
      onChange={props.onChange}
    />
  );
}
