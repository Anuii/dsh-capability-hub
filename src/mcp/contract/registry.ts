/**
 * Official MCP Registry 接入的契约（0.9.0）：只有类型。
 *
 * 数据源：https://registry.modelcontextprotocol.io 的只读接口（无需鉴权）。宿主端把 registry 的
 * 原始形状归一化成这里的形状，客户端只认这里的字段；写入配置仍走既有的 POST mcp/servers/upsert。
 *
 * 实测定下来的事实（写设计时必须知道）：
 *   - `search` 很慢：jira 约 14 秒、github 约 10 秒、filesystem 超过 60 秒；列表 2.5 秒、详情 1.9 秒。
 *     所以宿主请求超时要给足（45 秒），界面必须有「正在搜索」状态，不能当成秒回接口。
 *   - 一条 server 可能同时有 `remotes`（streamable-http / sse）与 `packages`（npm / pypi / oci / mcpb…）。
 *   - registry 名字形如 `io.github.user/my-server`，而 DSH 的服务器名只能是 [A-Za-z0-9_-]{1,32}，
 *     因此「建议名」是必做的一步（见 rules/registry-map.ts）。
 */

import type { RawMcpServer } from "./config.ts";
import type { DataProvenance } from "../../shared/network.ts";

/** 这条 server 支持的接入方式。远程优先，其次包管理器；不支持的形态不列。 */
export type RegistryKind = "remotes" | "npm" | "pypi" | "oci";

/** 搜索/详情里一条 server 的界面用形状。 */
export interface RegistryItem {
  /** registry 里的完整名，例如 `io.github.upstash/context7`（原样保留，界面上展示）。 */
  name: string;
  /** registry 给的展示名（可能没有）。 */
  title?: string;
  description?: string;
  /** registry 里的版本号（字符串，原样展示）。 */
  version: string;
  /** 支持的接入方式（可能多种）；决定界面上那几个类型标签。 */
  kinds: RegistryKind[];
  /** 声明为必填的环境变量名（界面上要提示「还要填这些」）。 */
  requiresEnv: string[];
}

/** GET mcp/registry/search 的 data。 */
export interface RegistrySearchResult {
  items: RegistryItem[];
  /** 下一页游标；没有更多时不出现。 */
  nextCursor?: string;
  /**
   * 0.10.0（D-B19）：这批结果是怎么来的——刚联网（直连 / 镜像），还是来自缓存。
   * 界面据此标「缓存于 X」或「经镜像」，不再把网络错误直接摆到界面上。
   */
  provenance?: DataProvenance;
}

/** 生成好的一份配置：直接可以进 upsert（serverName 一定有）。 */
export type RegistrySuggestedConfig = RawMcpServer & { serverName: string };

/** GET mcp/registry/detail 的 data。 */
export interface RegistryDetail {
  item: RegistryItem;
  /** 能一键生成时给出配置；`unsupported` 与它二选一。 */
  raw?: RegistrySuggestedConfig;
  /** 不能一键生成的原因（中文，例如「只提供 SSE 远程，本插件只支持 stdio / streamable-http」）。 */
  unsupported?: string;
  /** 需要人看一眼的说明（中文，例如「必填 GCS_BUCKET，请填上再保存」）。 */
  notes: string[];
}
