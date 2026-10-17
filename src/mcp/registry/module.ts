/**
 * mcp-registry 模块：Official MCP Registry 的宿主侧（0.9.0）。
 *
 * 两条只读路由（数据源 https://registry.modelcontextprotocol.io，只读、无需鉴权）：
 *   - GET mcp/registry/search?q=&cursor=  → RegistrySearchResult
 *   - GET mcp/registry/detail?name=       → RegistryDetail（内部调 rules/registry-map.ts 生成配置）
 *
 * 实测定下来的事实（写实现时必须知道）：search 很慢（jira 约 14 秒、github 约 10 秒、filesystem 超过 60 秒），
 * 列表约 2.5 秒、详情约 1.9 秒。所以单次请求超时给到 45 秒，超时给中文错误；界面那边必须有「正在搜索」。
 *
 * 依赖全部注入（fetchImpl / baseUrl / existingNames / fixture）：单测注入假 fetch，绝不联网。
 * fixture 只由插件配置 devOverrides.registryFixture 打开（且要求 devOverrides.enabled === true），
 * 打开后返回固定夹具、完全不碰网络，用来看界面在没有外网时也能走查。
 *
 * 失败一律抛带 status / code 的中文错误（shared/errors.ts），由平台路由器转成 { ok:false, error }：
 * 400 参数缺失、404 详情里没有这条 server、429 限流、502 超时 / 网络 / 上游返回异常。
 */

import { badRequest, notFound, rateLimited, upstream } from "../../shared/errors.ts";
import { errorText } from "../../shared/error-text.ts";
import { mapRegistryServer, registryItemOf, type MapRegistryServerResult } from "../rules/registry-map.ts";
import type { RegistryDetail, RegistryItem, RegistrySearchResult } from "../contract/registry.ts";
import type { HubContext, HubModule, RouteHandler, RouteRequest } from "../../platform/contract/host.ts";

/** registry 的根地址；测试用 baseUrl 覆盖。 */
export const REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";

/** 单次请求超时（毫秒）：search 实测可到 60 秒以上，45 秒是「给足但不无限等」的折中。 */
export const REGISTRY_TIMEOUT_MS = 45_000;

/** 每页条数；registry 默认 100，界面上一次只显示一屏，取小一点让首屏快些。 */
export const REGISTRY_SEARCH_LIMIT = 20;

/** 夹具模式下的两条 server（只由 devOverrides.registryFixture 打开时返回）。 */
export const FIXTURE_SERVER_NAMES = ["io.example/remote-demo", "io.example/npm-demo"] as const;

/** 模块的注入点：生产用默认值，测试全部注入。 */
export interface McpRegistryModuleOptions {
  /** 注入的 fetch（测试用假 fetch；缺省用全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** registry 根地址（缺省 REGISTRY_BASE_URL）。 */
  baseUrl?: string;
  /** 已占用的 DSH 服务器名（活值：每次生成建议名时现读，避免用启动那一刻的快照）。 */
  existingNames: () => readonly string[];
  /** true = 返回固定夹具、完全不联网（只由 devOverrides.registryFixture 打开）。 */
  fixture?: boolean;
}

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 夹具数据。两条覆盖「一键生成」的两条主路：
 *   - io.example/remote-demo：只有一条 streamable-http 远程；
 *   - io.example/npm-demo：一个 npm 包，带一条必填环境变量 DEMO_KEY（验证「必填 … 请填上再保存」）。
 * 夹具是 registry 的原始形状（不是映射后的结果），所以详情走的是与真实数据同一条映射代码。
 */
const FIXTURE_SERVERS: readonly unknown[] = [
  {
    name: "io.example/remote-demo",
    title: "远程示例（streamable-http）",
    description: "只有流式 HTTP 远程的示例 server：用来验证「远程优先」这张表，没有任何安装包，也不需要本地解释器。",
    version: "1.2.3",
    remotes: [{ type: "streamable-http", url: "https://remote-demo.example.com/mcp" }],
  },
  {
    name: "io.example/npm-demo",
    title: "npm 示例（必填环境变量）",
    description: "一个 npm 包的示例 server：生成的配置是 npx -y @example/npm-demo，并且声明了必填的 DEMO_KEY。",
    version: "0.4.0",
    packages: [
      {
        registryType: "npm",
        identifier: "@example/npm-demo",
        version: "0.4.0",
        transport: { type: "stdio" },
        environmentVariables: [
          { name: "DEMO_KEY", description: "演示用的令牌", isRequired: true, isSecret: true },
          { name: "DEMO_MODE", description: "运行模式", isRequired: false, default: "fast" },
        ],
      },
    ],
  },
];

/** 夹具里「结果很多」的一条：走查与截图用它验证结果列表的滚动（真 registry 搜一次要 10–60 秒，不能靠它）。 */
export const FIXTURE_MANY_QUERY = "many";
export const FIXTURE_MANY_COUNT = 12;

/** 夹具里的「结果很多」：12 条同名风格的条目，只用于界面走查。 */
function fixtureManyResult(): RegistrySearchResult {
  const items: RegistryItem[] = [];
  for (let index = 1; index <= FIXTURE_MANY_COUNT; index += 1) {
    const suffix = String(index).padStart(2, "0");
    items.push({
      name: "io.example/many-" + suffix,
      title: "批量结果示例 " + suffix,
      description: "用来验证搜索结果很多时列表会在固定高度里滚动，不会把对话框撑破。",
      version: "1.0." + String(index),
      kinds: index % 3 === 0 ? ["pypi"] : ["npm"],
      requiresEnv: index % 4 === 0 ? ["DEMO_KEY"] : [],
    });
  }
  return { items };
}

/**
 * 夹具里的搜索：**不看 q**（夹具是给界面走查用的确定结果，不是搜索模拟器）。
 * 例外：`q` 命中 {@link FIXTURE_MANY_QUERY} 时给 {@link FIXTURE_MANY_COUNT} 条，专门用来验证「结果很多」的滚动。
 */
function fixtureSearchResult(q: string): RegistrySearchResult {
  if (q.trim().toLowerCase() === FIXTURE_MANY_QUERY) return fixtureManyResult();
  return { items: FIXTURE_SERVERS.map((server) => registryItemOf(server)) };
}

/**
 * 创建 mcp-registry 模块。
 *
 * @param ctx HubContext（只用来打日志：搜索耗时、夹具模式提示）
 * @param opts 注入点；existingNames 每次生成配置时现读
 */
export function createMcpRegistryModule(ctx: HubContext, opts: McpRegistryModuleOptions): HubModule {
  const fixture = opts.fixture === true;
  const baseUrl = opts.baseUrl ?? REGISTRY_BASE_URL;
  const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));

  /** 读已占用的服务器名：注入的回调抛错也不该让整条请求 500（建议名只是锦上添花）。 */
  function existingNames(): readonly string[] {
    try {
      const names = opts.existingNames();
      return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
    } catch (error) {
      ctx.logger.warn("mcp-registry: 读现有服务器名失败（建议名按空列表生成）：" + errorText(error));
      return [];
    }
  }

  /** 拼一个接口地址：baseUrl 可以带路径（测试用 http://127.0.0.1:PORT/prefix 这种）。 */
  function endpoint(path: string): URL {
    return new URL(path, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  }

  function timeoutMessage(label: string): Error {
    return upstream(
      "请求 MCP Registry 超时（" +
        REGISTRY_TIMEOUT_MS / 1000 +
        " 秒内没有响应）：" +
        label +
        "失败。registry 的搜索接口本身很慢，可以再试一次或换个更具体的关键词。",
    );
  }

  /** 一次 GET + JSON 解析；超时 / 限流 / 上游异常都翻成中文错误。 */
  async function requestJson(
    url: URL,
    options: { label: string; signal: AbortSignal; notFoundMessage?: string },
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(REGISTRY_TIMEOUT_MS);
    const signal = typeof AbortSignal.any === "function" ? AbortSignal.any([timeout, options.signal]) : timeout;
    let response: Response;
    try {
      response = await doFetch(url, { method: "GET", headers: { accept: "application/json" }, signal });
    } catch (error) {
      const name = isRecord(error) || typeof error === "object" ? (error as { name?: unknown }).name : undefined;
      if (name === "TimeoutError" || name === "AbortError" || signal.aborted) throw timeoutMessage(options.label);
      throw upstream(
        "请求 MCP Registry 失败（" + options.label + "）：" + errorText(error) + "。请检查网络或代理设置。",
      );
    }
    if (response.status === 429) {
      throw rateLimited("MCP Registry 限流了（HTTP 429）：" + options.label + "失败，请稍后再试。");
    }
    if (response.status === 404 && options.notFoundMessage !== undefined) throw notFound(options.notFoundMessage);
    if (!response.ok) {
      throw upstream("MCP Registry " + options.label + "失败：服务返回 HTTP " + response.status + "。");
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw upstream("MCP Registry " + options.label + "失败：返回的内容不是合法 JSON。");
    }
  }

  /** registry 的列表响应 → RegistrySearchResult（没名字的条目直接跳过：界面没法用）。 */
  function toSearchResult(body: unknown): RegistrySearchResult {
    const rec = isRecord(body) ? body : {};
    const entries = Array.isArray(rec.servers) ? rec.servers : [];
    const items: RegistryItem[] = [];
    for (const entry of entries) {
      const server = isRecord(entry) && entry.server !== undefined ? entry.server : entry;
      const item = registryItemOf(server);
      if (item.name === "") continue;
      items.push(item);
    }
    const result: RegistrySearchResult = { items };
    const metadata = isRecord(rec.metadata) ? rec.metadata : {};
    if (typeof metadata.nextCursor === "string" && metadata.nextCursor !== "") {
      result.nextCursor = metadata.nextCursor;
    }
    return result;
  }

  /** registry 的一条 server → RegistryDetail（能生成就给 raw + notes，不能就给 unsupported）。 */
  function toDetail(server: unknown): RegistryDetail {
    const item = registryItemOf(server);
    const mapped: MapRegistryServerResult = mapRegistryServer(server, existingNames());
    if ("unsupported" in mapped) return { item, unsupported: mapped.unsupported, notes: [] };
    return { item, raw: mapped.raw, notes: mapped.notes };
  }

  function fixtureDetail(name: string): RegistryDetail {
    const server = FIXTURE_SERVERS.find((item) => isRecord(item) && item.name === name);
    if (server === undefined) {
      throw notFound(
        "夹具模式里没有「" + name + "」这条 server（只有 " + FIXTURE_SERVER_NAMES.join(" 与 ") + "，fixture 不联网）。",
      );
    }
    return toDetail(server);
  }

  /** 查询串里的必填项：trim 后不能是空。 */
  function requiredQuery(req: RouteRequest, key: string, label: string): string {
    const raw = req.query[key];
    if (typeof raw !== "string" || raw.trim() === "") {
      throw badRequest("缺少必填参数 " + key + "（" + label + "不能为空）。");
    }
    return raw.trim();
  }

  /** 查询串里的可选项：空串当作没给。 */
  function optionalQuery(req: RouteRequest, key: string): string | undefined {
    const raw = req.query[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string") throw badRequest("参数 " + key + " 必须是字符串。");
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
  }

  const handlers: Record<string, RouteHandler> = {
    "GET mcp/registry/search": async (req) => {
      const q = requiredQuery(req, "q", "搜索关键词");
      const cursor = optionalQuery(req, "cursor");
      if (fixture) {
        ctx.logger.debug("mcp-registry: fixture 打开，搜索「" + q + "」返回固定夹具（不联网）");
        return fixtureSearchResult(q);
      }
      const url = endpoint("v0.1/servers");
      url.searchParams.set("search", q);
      url.searchParams.set("version", "latest");
      url.searchParams.set("limit", String(REGISTRY_SEARCH_LIMIT));
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      ctx.logger.debug("mcp-registry: 搜索「" + q + "」（超时 " + REGISTRY_TIMEOUT_MS + " ms）");
      const started = Date.now();
      const body = await requestJson(url, { label: "搜索", signal: req.signal });
      const result = toSearchResult(body);
      ctx.logger.debug(
        "mcp-registry: 搜索「" + q + "」返回 " + result.items.length + " 条（" + (Date.now() - started) + " ms）",
      );
      return result;
    },

    "GET mcp/registry/detail": async (req) => {
      const name = requiredQuery(req, "name", "registry 里的服务器名");
      if (fixture) {
        ctx.logger.debug("mcp-registry: fixture 打开，详情「" + name + "」来自固定夹具（不联网）");
        return fixtureDetail(name);
      }
      const url = endpoint("v0.1/servers/" + encodeURIComponent(name) + "/versions/latest");
      const body = await requestJson(url, {
        label: "读取详情",
        signal: req.signal,
        notFoundMessage: "MCP Registry 里没有这条 server：「" + name + "」。",
      });
      const server = isRecord(body) && body.server !== undefined ? body.server : body;
      return toDetail(server);
    },
  };

  return { routes: handlers };
}
