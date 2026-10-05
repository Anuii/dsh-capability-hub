/**
 * 外壳自己的类型。功能模块看到的 HubContext 在 ../contract/host.ts；外壳额外知道 profile 目录与安装目录。
 */

import type { HubContext } from '../contract/host.ts';

/** 外壳解析出的完整上下文：功能模块看到的 HubContext + 只有外壳用得到的两项。 */
export interface PlatformContext extends HubContext {
  /** profile 目录绝对路径（拿不到时空串）。 */
  profileDir: string;
  /** 本插件宿主半的安装目录（用于定位随包资源）。 */
  packageRoot: string;
}

/** 路由处理器抛出的任意错误：可能带 status / code / details（功能模块的 HubError），也可能不带。 */
export interface ThrownError extends Error {
  status?: number;
  code?: string;
  details?: unknown;
}
