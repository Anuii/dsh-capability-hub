/**
 * MCP 配置模块内部的类型：注入点。磁盘格式与 HTTP 契约在 ../contract/config.ts（ADR-0002）。
 */

import type { McpConfigSource } from "../contract/config.ts";
import type { HubModule } from "../../platform/contract/host.ts";

/** 命令检查的可注入环境（check-command.ts 的选项）。 */
export interface CommandCheckOptions {
  cwd?: string;
  pathEnv?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
}

/** 工厂返回值。 */
export interface McpConfigModule extends HubModule {
  source: McpConfigSource;
}
