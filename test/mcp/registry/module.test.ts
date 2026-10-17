/**
 * registry/module.ts：两条路由的 URL 拼装、参数校验、错误码与夹具模式。
 *
 * **绝不联网**：每个用例都注入假 fetch；没注入时默认的假 fetch 直接抛错，
 * 所以任何一次真实请求都会让用例失败。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMcpRegistryModule,
  FIXTURE_SERVER_NAMES,
  REGISTRY_SEARCH_LIMIT,
  REGISTRY_TIMEOUT_MS,
} from "../../../src/mcp/registry/module.ts";
import type { RegistryDetail, RegistrySearchResult } from "../../../src/mcp/contract/registry.ts";
import type { HubContext, HubLogger, RouteRequest } from "../../../src/platform/contract/host.ts";

type Routes = Record<string, (req: RouteRequest) => Promise<unknown>>;

function recordingLogger(): HubLogger & { text(): string } {
  const lines: string[] = [];
  const push =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(level + " " + args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  return {
    text: () => lines.join("\n"),
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}

function makeContext(logger: HubLogger): HubContext {
  return {
    homeDir: "C:/tmp/home",
    dshHome: "C:/tmp/home/.dsh",
    hubHome: "C:/tmp/home/.dsh/hub",
    profileName: "test",
    logger,
    customSkillDirs: [],
  };
}

function makeRequest(query: Record<string, string>, signal?: AbortSignal): RouteRequest {
  return { query, body: undefined, signal: signal ?? new AbortController().signal };
}

/** 一次假 fetch 调用（URL 与 init 都留着给断言用）。 */
interface FetchCall {
  url: URL;
  init: RequestInit;
}

/** 假 fetch：记录每次调用，再交给 handler 决定返回什么。 */
function fakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): {
  impl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    return await handler(url, requestInit);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 默认的假 fetch：说明这个用例不该联网。 */
const noNetworkFetch = (async () => {
  throw new Error("这个用例不该联网：请注入假 fetch");
}) as unknown as typeof fetch;

const jsonResponse = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

interface Harness {
  module: { routes: Routes };
  logger: HubLogger & { text(): string };
  calls: FetchCall[];
  call(key: string, query: Record<string, string>): Promise<unknown>;
}

function harness(
  options: {
    handler?: (url: URL, init: RequestInit) => Response | Promise<Response>;
    baseUrl?: string;
    existingNames?: () => readonly string[];
    fixture?: boolean;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Harness {
  const logger = recordingLogger();
  const fake = options.handler === undefined ? undefined : fakeFetch(options.handler);
  const fetchImpl = options.fetchImpl ?? fake?.impl ?? noNetworkFetch;
  const module = createMcpRegistryModule(makeContext(logger), {
    fetchImpl,
    baseUrl: options.baseUrl ?? "https://registry.test",
    existingNames: options.existingNames ?? (() => []),
    ...(options.fixture === undefined ? {} : { fixture: options.fixture }),
  });
  return {
    module,
    logger,
    calls: fake?.calls ?? [],
    call: async (key, query) => {
      const handler = module.routes[key];
      assert.ok(handler !== undefined, "路由不存在：" + key);
      return await handler(makeRequest(query, options.signal));
    },
  };
}

interface AssertedError {
  status?: number;
  code?: string;
  message: string;
}

async function expectRejection(fn: () => Promise<unknown>): Promise<AssertedError> {
  try {
    await fn();
  } catch (error) {
    const e = error as { status?: number; code?: string; message?: string };
    return { status: e.status, code: e.code, message: e.message ?? "" };
  }
  throw new Error("预期抛出错误，但调用成功返回了。");
}

const context7Server = {
  name: "io.github.upstash/context7",
  title: "Context7",
  description: "Up-to-date code docs for any prompt",
  version: "4.4.2",
  remotes: [{ type: "streamable-http", url: "https://mcp.context7.com/mcp" }],
  packages: [
    {
      registryType: "npm",
      identifier: "@upstash/context7-mcp",
      version: "4.4.2",
      transport: { type: "stdio" },
      environmentVariables: [{ name: "CONTEXT7_API_KEY", isSecret: true }],
    },
  ],
};

describe("registry/module: 路由表与常量", () => {
  it("只有两条只读路由", () => {
    assert.deepEqual(Object.keys(harness().module.routes).sort(), [
      "GET mcp/registry/detail",
      "GET mcp/registry/search",
    ]);
  });

  it("超时 45 秒、每页 20 条（实测定下来的数）", () => {
    assert.equal(REGISTRY_TIMEOUT_MS, 45_000);
    assert.equal(REGISTRY_SEARCH_LIMIT, 20);
  });
});

describe("registry/module: search", () => {
  it("URL 拼装：/v0.1/servers?search=&version=latest&limit=，并把条目映射成 RegistryItem", async () => {
    const h = harness({
      handler: () =>
        jsonResponse({
          servers: [
            { server: context7Server, _meta: {} },
            { server: { name: "io.example/empty", version: "1.0.0" } },
            { server: {} },
          ],
          metadata: { nextCursor: "next-1" },
        }),
    });
    const data = (await h.call("GET mcp/registry/search", { q: "context7" })) as RegistrySearchResult;
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.url.href, "https://registry.test/v0.1/servers?search=context7&version=latest&limit=20");
    assert.equal(h.calls[0]?.init.method, "GET");
    assert.equal(h.calls[0]?.init.signal instanceof AbortSignal, true, "必须带 AbortSignal（45 秒超时）");
    assert.equal(h.calls[0]?.url.pathname, "/v0.1/servers");
    assert.deepEqual(data.nextCursor, "next-1");
    assert.equal(data.items.length, 2, "没有 name 的条目跳过");
    assert.deepEqual(data.items[0], {
      name: "io.github.upstash/context7",
      version: "4.4.2",
      kinds: ["remotes", "npm"],
      requiresEnv: [],
      title: "Context7",
      description: "Up-to-date code docs for any prompt",
    });
    assert.deepEqual(data.items[1]?.kinds, []);
  });

  it("q 先去空白再搜索；cursor 原样透传（URL 里编码）", async () => {
    const h = harness({ handler: () => jsonResponse({ servers: [], metadata: {} }) });
    await h.call("GET mcp/registry/search", { q: "  jira  ", cursor: "abc+/= x" });
    const url = h.calls[0]?.url;
    assert.ok(url !== undefined);
    assert.equal(url.searchParams.get("search"), "jira");
    assert.equal(url.searchParams.get("cursor"), "abc+/= x");
    assert.equal(url.searchParams.get("version"), "latest");
    assert.equal(url.searchParams.get("limit"), "20");
  });

  it("cursor 为空串当作没给（不拼 cursor 参数）", async () => {
    const h = harness({ handler: () => jsonResponse({ servers: [], metadata: {} }) });
    await h.call("GET mcp/registry/search", { q: "demo", cursor: "" });
    assert.equal(h.calls[0]?.url.searchParams.has("cursor"), false);
  });

  it("没给 nextCursor 时结果里不出现这个字段", async () => {
    const h = harness({ handler: () => jsonResponse({ servers: [], metadata: {} }) });
    const data = (await h.call("GET mcp/registry/search", { q: "demo" })) as RegistrySearchResult;
    assert.deepEqual(data, { items: [] });
    assert.equal("nextCursor" in data, false);
  });

  it("q 缺失 / 只有空白 → 400，中文错误，且不发请求", async () => {
    const h = harness({ handler: () => jsonResponse({ servers: [], metadata: {} }) });
    const queries: Record<string, string>[] = [{}, { q: "" }, { q: "   " }];
    for (const query of queries) {
      const error = await expectRejection(() => h.call("GET mcp/registry/search", query));
      assert.equal(error.status, 400);
      assert.equal(error.code, "BAD_REQUEST");
      assert.match(error.message, /缺少必填参数 q（搜索关键词不能为空）/);
    }
    assert.equal(h.calls.length, 0, "参数不合要求时不该发请求");
  });

  it("baseUrl 可以带路径（部署在反代后面时）", async () => {
    const h = harness({
      baseUrl: "https://registry.test/api",
      handler: () => jsonResponse({ servers: [], metadata: {} }),
    });
    await h.call("GET mcp/registry/search", { q: "demo" });
    assert.equal(h.calls[0]?.url.pathname, "/api/v0.1/servers");
  });
});

describe("registry/module: detail", () => {
  it("URL 用 URL 编码的 name 拼 /versions/latest，并生成 raw", async () => {
    const h = harness({
      handler: () => jsonResponse({ server: context7Server }),
      existingNames: () => ["other"],
    });
    const data = (await h.call("GET mcp/registry/detail", { name: "io.github.upstash/context7" })) as RegistryDetail;
    assert.equal(
      h.calls[0]?.url.pathname,
      "/v0.1/servers/io.github.upstash%2Fcontext7/versions/latest",
      "name 必须 URL 编码（斜杠变 %2F）",
    );
    assert.equal(data.item.name, "io.github.upstash/context7");
    assert.equal(data.raw?.serverName, "context7");
    assert.equal(data.raw?.transport, "streamable-http");
    assert.equal(data.raw?.url, "https://mcp.context7.com/mcp");
    assert.equal(data.unsupported, undefined);
    assert.ok(
      data.notes.some((note) => /同时提供了安装包，已优先用远程地址/.test(note)),
      "同时有包时要在 notes 里说明为什么选了远程",
    );
  });

  it("existingNames 注入生效：重名时建议名加 -2", async () => {
    const h = harness({
      handler: () => jsonResponse({ server: context7Server }),
      existingNames: () => ["context7"],
    });
    const data = (await h.call("GET mcp/registry/detail", { name: "io.github.upstash/context7" })) as RegistryDetail;
    assert.equal(data.raw?.serverName, "context7-2");
  });

  it("不能一键生成时给 unsupported（中文原因），不给 raw", async () => {
    const h = harness({
      handler: () =>
        jsonResponse({
          server: { name: "io.example/sse-only", version: "1.0.0", remotes: [{ type: "sse", url: "https://x/sse" }] },
        }),
    });
    const data = (await h.call("GET mcp/registry/detail", { name: "io.example/sse-only" })) as RegistryDetail;
    assert.equal(data.raw, undefined);
    assert.match(data.unsupported ?? "", /只提供 SSE 远程/);
    assert.deepEqual(data.notes, []);
  });

  it("name 缺失 → 400，中文错误", async () => {
    const h = harness({ handler: () => jsonResponse({ server: context7Server }) });
    const error = await expectRejection(() => h.call("GET mcp/registry/detail", {}));
    assert.equal(error.status, 400);
    assert.match(error.message, /缺少必填参数 name（registry 里的服务器名不能为空）/);
    assert.equal(h.calls.length, 0);
  });

  it("registry 说没有这条 server（404）→ 404，中文错误", async () => {
    const h = harness({ handler: () => jsonResponse({ error: "not found" }, 404) });
    const error = await expectRejection(() => h.call("GET mcp/registry/detail", { name: "io.example/nope" }));
    assert.equal(error.status, 404);
    assert.equal(error.code, "NOT_FOUND");
    assert.match(error.message, /没有这条 server：「io.example\/nope」/);
  });
});

describe("registry/module: 上游异常都翻成中文", () => {
  it("45 秒超时（AbortSignal.timeout 的 TimeoutError）→ 502，文案说清超时与秒数", async () => {
    const h = harness({
      fetchImpl: (async () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      }) as unknown as typeof fetch,
    });
    const error = await expectRejection(() => h.call("GET mcp/registry/search", { q: "filesystem" }));
    assert.equal(error.status, 502);
    assert.equal(error.code, "UPSTREAM");
    assert.match(error.message, /请求 MCP Registry 超时/);
    assert.match(error.message, /45 秒/);
  });

  it("断开信号导致的 AbortError 也按超时处理", async () => {
    const controller = new AbortController();
    const h = harness({
      signal: controller.signal,
      fetchImpl: (async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }) as unknown as typeof fetch,
    });
    const error = await expectRejection(() => h.call("GET mcp/registry/search", { q: "jira" }));
    assert.equal(error.status, 502);
    assert.match(error.message, /超时/);
  });

  it("429 → 429 RATE_LIMITED，中文说明稍后再试", async () => {
    const h = harness({ handler: () => jsonResponse({ error: "slow down" }, 429) });
    const error = await expectRejection(() => h.call("GET mcp/registry/search", { q: "github" }));
    assert.equal(error.status, 429);
    assert.equal(error.code, "RATE_LIMITED");
    assert.match(error.message, /限流/);
    assert.match(error.message, /429/);
  });

  it("其它非 2xx（500）→ 502，带状态码", async () => {
    const h = harness({ handler: () => jsonResponse({ error: "boom" }, 500) });
    const error = await expectRejection(() => h.call("GET mcp/registry/search", { q: "x" }));
    assert.equal(error.status, 502);
    assert.match(error.message, /HTTP 500/);
  });

  it("网络失败（fetch 抛 TypeError）→ 502，提示网络或代理", async () => {
    const h = harness({
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const error = await expectRejection(() => h.call("GET mcp/registry/search", { q: "x" }));
    assert.equal(error.status, 502);
    assert.match(error.message, /请求 MCP Registry 失败/);
    assert.match(error.message, /请检查网络或代理设置/);
  });

  it("返回不是 JSON → 502，中文说明", async () => {
    const h = harness({ handler: () => new Response("not json", { status: 200 }) });
    const error = await expectRejection(() => h.call("GET mcp/registry/search", { q: "x" }));
    assert.equal(error.status, 502);
    assert.match(error.message, /不是合法 JSON/);
  });
});

describe("registry/module: fixture 模式（不联网）", () => {
  it("search 返回两条固定夹具，一次也不调 fetch", async () => {
    const h = harness({ fixture: true });
    const data = (await h.call("GET mcp/registry/search", { q: "随便什么关键词" })) as RegistrySearchResult;
    assert.deepEqual(
      data.items.map((item) => item.name),
      [...FIXTURE_SERVER_NAMES],
    );
    assert.deepEqual(data.items[0]?.kinds, ["remotes"]);
    assert.deepEqual(data.items[1]?.kinds, ["npm"]);
    assert.deepEqual(data.items[1]?.requiresEnv, ["DEMO_KEY"]);
    assert.equal(h.calls.length, 0);
  });

  it("detail 的两条夹具：远程一条与 npm（必填 env）一条", async () => {
    const h = harness({ fixture: true });
    const remote = (await h.call("GET mcp/registry/detail", { name: "io.example/remote-demo" })) as RegistryDetail;
    assert.equal(remote.raw?.transport, "streamable-http");
    assert.equal(remote.raw?.url, "https://remote-demo.example.com/mcp");
    assert.deepEqual(remote.notes, []);

    const npm = (await h.call("GET mcp/registry/detail", { name: "io.example/npm-demo" })) as RegistryDetail;
    assert.equal(npm.raw?.command, "npx");
    assert.deepEqual(npm.raw?.args, ["-y", "@example/npm-demo"]);
    assert.deepEqual(npm.raw?.env, { DEMO_KEY: "", DEMO_MODE: "fast" });
    assert.equal(npm.notes.includes("必填 DEMO_KEY，请填上再保存"), true);
    assert.equal(h.calls.length, 0);
  });

  it("夹具模式下未知名字 → 404（说明夹具只有哪两条）", async () => {
    const h = harness({ fixture: true });
    const error = await expectRejection(() => h.call("GET mcp/registry/detail", { name: "io.example/nope" }));
    assert.equal(error.status, 404);
    assert.match(error.message, /夹具模式/);
    assert.match(error.message, /io\.example\/remote-demo/);
    assert.equal(h.calls.length, 0);
  });

  it("夹具模式仍然校验参数（q / name 缺失还是 400）", async () => {
    const h = harness({ fixture: true });
    const searchError = await expectRejection(() => h.call("GET mcp/registry/search", { q: "  " }));
    assert.equal(searchError.status, 400);
    const detailError = await expectRejection(() => h.call("GET mcp/registry/detail", {}));
    assert.equal(detailError.status, 400);
    assert.equal(h.calls.length, 0);
  });
});
