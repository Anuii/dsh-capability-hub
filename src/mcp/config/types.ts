/**
 * MCP 配置模块内部的类型：落盘文件形状与注入点。HTTP 与进程内契约在 ../contract/config.ts（ADR-0002）。
 */

import type { RawMcpServer, McpConfigSource } from '../contract/config.ts';
import type { HubModule } from '../../platform/contract/host.ts';

/** 输出护栏的输入形态：true/false 或部分对象（缺的子字段取默认）。 */
export type OutputGuardInput = boolean | { enabled?: boolean; maxBytes?: number; maxLines?: number };

/** 落盘的全局设置：只含非默认项。 */
export interface RawMcpSettings {
  idleTimeout?: number;
  outputGuard?: OutputGuardInput;
  failureBackoffMs?: number;
}

/** hubHome/mcp/config.json 的内容。 */
export interface RawMcpConfigFile {
  version: 1;
  settings: RawMcpSettings;
  servers: RawMcpServer[];
}

/** 命令检查的可注入环境（check-command.ts 的选项）。 */
export interface CommandCheckOptions {
  cwd?: string;
  pathEnv?: string;
  pathExt?: string;
  platform?: NodeJS.Platform;
}

/** 工厂返回值（PLAN §3.5）。 */
export interface McpConfigModule extends HubModule {
  source: McpConfigSource;
}
