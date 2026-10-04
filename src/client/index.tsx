/**
 * dsh-capability-hub 客户端（浏览器半）入口。
 *
 * 导出面与社区客户端插件一致：{ apply, inject }。apply(ctx) 里：
 *   1. 注入样式；
 *   2. 注册字典并把 ctx.locale.bind(NS) 接给运行期翻译；
 *   3. 接上会话服务源（useCurrentWorkspace 用）；
 *   4. 注册侧栏行 + 中央面板 + 插件管理页的行配置按钮；
 *   5. 用 ctx.effect 保证 fiber 卸载时全部解绑。
 *
 * inject 只声明真正必需的客户端服务：slots（slot 注册面）与 locale（字典）。
 * layout 用 ctx.get 惰性获取（拿不到时按钮退化为「只切标签、不切面板」）。
 */
import { installApplier } from "./shell/applier.ts";

/** 必需服务：slots 与 locale。 */
export const inject = ["slots", "locale"];

/** 挂载能力中心客户端半。 */
export function apply(ctx: unknown): void {
  installApplier(ctx);
}
