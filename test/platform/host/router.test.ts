/**
 * 平台层路由适配的单测。
 *
 * 覆盖的都是实测踩过的坑：
 *   - prefix 不能带尾斜杠（V3 第一轮 404）；
 *   - Fetch 路由必须声明 requestBody: "buffered"（V3 第二轮 400）；
 *   - **同一路径只能注册一条 FetchRoute**（connection 的 fetchRoutes 是 Map，键就是 path）：
 *     路由表里同一路径的多个方法必须合成一条并按 request.method 分发，否则第二条注册抛
 *     「connection: exact Fetch route "<path>" is already registered」，registerRoutes 把已注册的
 *     全部回滚，整个插件的接口一起 404（v071 实测）；
 *   - 信封 { ok, data } / { ok, error } 与错误状态映射。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as YAML from "yaml";
import {
  createFetchRoutes,
  parseRouteKey,
  registerRoutes,
  relativePath,
  routePath,
} from "../../../src/platform/host/router.ts";
import type { ConnectionFace, FetchRoute, RouterLogger } from "../../../src/platform/host/router.ts";
import { ModuleRegistry, createFeatureModuleEntries, makeFeatureState } from "../../../src/platform/host/modules.ts";
import type { HubContext, HubLogger, RouteTable } from "../../../src/platform/contract/host.ts";

/** 全字段日志面：技能模块会 logger.info.bind(...)，少一个字段就降级（回归用例里要装载真实模块）。 */
const logger: HubLogger & RouterLogger = { debug() {}, info() {}, warn() {}, error() {} };

const URL_OF = "http://dsh.invalid/api/dsh-capability-hub/";

/** 记录 warn 的日志面（非法键的告警断言用）。 */
function recordingLogger(): RouterLogger & { warnings: string[] } {
  const warnings: string[] = [];
  return { warnings, debug() {}, warn: (...args: unknown[]) => warnings.push(args.join(" ")), error() {} };
}

/**
 * 与 DSH connection 服务的 fetchRoutes 同语义的假表（connection/lib/index.js:626-636 / 758-762）：
 * Map 按 path 存，重复 path 抛「already registered」，methods 为空或重复也抛。
 * 用真的会拒绝的假表，才能测出「一键一路由」导致的整表回滚。
 */
function makeFakeConnection(): { connection: ConnectionFace; registered: Map<string, FetchRoute> } {
  const registered = new Map<string, FetchRoute>();
  const connection: ConnectionFace = {
    fetch: {
      register(route: FetchRoute): () => void {
        if (!Array.isArray(route.methods) || route.methods.length === 0) {
          throw new Error(`connection: exact Fetch route "${route.path}" needs at least one method`);
        }
        if (new Set(route.methods).size !== route.methods.length) {
          throw new Error(`connection: exact Fetch route "${route.path}" has duplicate methods`);
        }
        if (registered.has(route.path)) {
          throw new Error(`connection: exact Fetch route "${route.path}" is already registered`);
        }
        registered.set(route.path, route);
        return () => {
          registered.delete(route.path);
        };
      },
    },
  };
  return { connection, registered };
}

test("路由键解析：合法与非法", () => {
  assert.deepEqual(parseRouteKey("GET health"), { method: "GET", relative: "health" });
  assert.deepEqual(parseRouteKey("POST skills/list"), { method: "POST", relative: "skills/list" });
  assert.equal(parseRouteKey("PUT health"), undefined);
  assert.equal(parseRouteKey("GET"), undefined);
  assert.equal(parseRouteKey("GET skills//list"), undefined);
  assert.equal(parseRouteKey("GET ../etc"), undefined);
});

test("路由路径不带尾斜杠，且在前缀之下", () => {
  assert.equal(routePath("GET health"), "/api/dsh-capability-hub/health");
  assert.equal(relativePath("/api/dsh-capability-hub/health"), "health");
  assert.equal(relativePath("/api/dsh-capability-hub"), "");
  assert.equal(relativePath("/api/dsh-capability-hubx/health"), "");
});

test("Fetch 路由：路径/方法/buffered 声明", () => {
  const table: RouteTable = { "GET health": async () => ({ ok: true }) };
  const routes = createFetchRoutes(table, logger);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/api/dsh-capability-hub/health");
  assert.deepEqual(routes[0].methods, ["GET"]);
  assert.equal(routes[0].requestBody, "buffered");
});

test("Fetch 路由：同一路径的 GET 与 POST 合成一条，methods 去重且稳定排序", () => {
  // 表里的声明顺序故意把 POST 放在前面：methods 仍要是 ["GET", "POST"]。
  const routes = createFetchRoutes(
    {
      "POST skills/settings": async () => ({ saved: true }),
      "GET skills/settings": async () => ({ view: true }),
    },
    logger,
  );
  assert.equal(routes.length, 1, "同一路径只生成一条 FetchRoute");
  assert.equal(routes[0].path, "/api/dsh-capability-hub/skills/settings");
  assert.deepEqual(routes[0].methods, ["GET", "POST"]);
});

test("Fetch 路由：同一路径按 request.method 分发到各自处理器；未知方法 405 信封", async () => {
  const calls: string[] = [];
  const routes = createFetchRoutes(
    {
      "GET skills/settings": async (req) => {
        calls.push("GET");
        // GET 不读 body（POST 才读），所以这里只会看到 undefined。
        return { handler: "GET", query: req.query, bodyIsUndefined: req.body === undefined };
      },
      "POST skills/settings": async (req) => {
        calls.push("POST");
        return { handler: "POST", body: req.body };
      },
    },
    logger,
  );
  assert.equal(routes.length, 1);

  const get = await routes[0].fetch(new Request(URL_OF + "skills/settings?workspace=x", { method: "GET" }));
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), {
    ok: true,
    data: { handler: "GET", query: { workspace: "x" }, bodyIsUndefined: true },
  });

  const post = await routes[0].fetch(
    new Request(URL_OF + "skills/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubMirror: "https://ghfast.top/" }),
    }),
  );
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), {
    ok: true,
    data: { handler: "POST", body: { githubMirror: "https://ghfast.top/" } },
  });

  // 只有 GET 与 POST 的路径收到 PUT：405 + 中文信封，且不落到任何处理器上。
  const put = await routes[0].fetch(new Request(URL_OF + "skills/settings", { method: "PUT", body: "{}" }));
  assert.equal(put.status, 405);
  assert.deepEqual(await put.json(), {
    ok: false,
    error: { code: "METHOD_NOT_ALLOWED", message: "不支持的请求方法：PUT" },
  });

  assert.deepEqual(calls, ["GET", "POST"], "只有表里的方法进了处理器");
});

test("Fetch 路由：非法键只警告并跳过，不影响同表的其他路由", () => {
  const sink = recordingLogger();
  const routes = createFetchRoutes(
    {
      "PUT health": async () => ({}),
      "GET skills//list": async () => ({}),
      "GET health": async () => ({}),
    },
    sink,
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, "/api/dsh-capability-hub/health");
  assert.deepEqual(sink.warnings.length, 2);
  assert.match(sink.warnings[0], /忽略非法路由键："PUT health"/);
  assert.match(sink.warnings[1], /忽略非法路由键："GET skills\/\/list"/);
});

test("Fetch 路由：成功走 { ok: true, data } 信封", async () => {
  const routes = createFetchRoutes({ "GET health": async () => ({ answer: 42 }) }, logger);
  const response = await routes[0].fetch(
    new Request("http://dsh.invalid/api/dsh-capability-hub/health", { method: "GET" }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, data: { answer: 42 } });
});

test("Fetch 路由：错误映射成 { ok: false, error }，保留 status/code", async () => {
  const failure = new Error("找不到技能") as Error & { status: number; code: string };
  failure.status = 404;
  failure.code = "NOT_FOUND";
  const routes = createFetchRoutes(
    {
      "GET skills/get": async () => {
        throw failure;
      },
    },
    logger,
  );
  const response = await routes[0].fetch(new Request("http://dsh.invalid/api/dsh-capability-hub/skills/get"));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: { code: "NOT_FOUND", message: "找不到技能" } });
});

test("Fetch 路由：POST 请求体不是 JSON → 400", async () => {
  const routes = createFetchRoutes({ "POST echo": async (req) => req.body }, logger);
  const response = await routes[0].fetch(
    new Request("http://dsh.invalid/api/dsh-capability-hub/echo", {
      method: "POST",
      body: "not json",
    }),
  );
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { ok: boolean; error: { code: string } };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "BAD_REQUEST");
});

test("registerRoutes：注册进 connection.fetch，dispose 会全部注销", () => {
  const { connection, registered } = makeFakeConnection();
  const table: RouteTable = {
    "GET health": async () => ({}),
    "GET skills/list": async () => ({}),
  };
  const registration = registerRoutes(connection, table, logger);
  assert.deepEqual(registration.paths, ["/api/dsh-capability-hub/health", "/api/dsh-capability-hub/skills/list"]);
  assert.deepEqual([...registered.keys()], ["/api/dsh-capability-hub/health", "/api/dsh-capability-hub/skills/list"]);
  registration.dispose();
  assert.deepEqual([...registered.keys()], []);
});

test("registerRoutes：connection 不可用时抛错（宁可降级也不退回无鉴权的 prefix）", () => {
  assert.throws(() => registerRoutes({}, { "GET health": async () => ({}) }, logger), /connection\.fetch\.register/);
});

test("registerRoutes：同路径多方法只注册一条，重复路径的假表不会抛（v071 的 404 回归）", () => {
  const { connection, registered } = makeFakeConnection();
  const table: RouteTable = {
    "GET skills/settings": async () => ({}),
    "POST skills/settings": async () => ({}),
  };
  // 假 connection 与 DSH 同语义：一键一路由时这里会抛「already registered」，
  // 也就是测试 profile 里整个插件 404 的那个原因。
  const registration = registerRoutes(connection, table, logger);
  assert.deepEqual(registration.paths, ["/api/dsh-capability-hub/skills/settings"]);
  assert.deepEqual([...registered.keys()], ["/api/dsh-capability-hub/skills/settings"]);
  assert.deepEqual(registered.get("/api/dsh-capability-hub/skills/settings")?.methods, ["GET", "POST"]);
  registration.dispose();
  assert.deepEqual([...registered.keys()], []);
});

test("回归：真实路由表的形状（同路径 GET + POST skills/settings）能整表注册，且每条路径只注册一次", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "router-real-routes-"));
  const ctx: HubContext = {
    homeDir: dir,
    dshHome: dir,
    hubHome: dir,
    profileName: "test",
    logger,
    customSkillDirs: [],
  };
  const registry = new ModuleRegistry(ctx, {});
  try {
    // 与外壳 createShell 的第 2 步同源：五个真实模块按依赖顺序装载，路由表就是它们填出来的。
    await registry.loadAll(
      createFeatureModuleEntries({
        ctx,
        mcpClient: { status: "loaded", plugin: { Config: (input: unknown) => input, apply: () => {} } as never },
        root: {} as never,
        listTools: () => [],
        yaml: { status: "loaded", yaml: YAML, source: "import" },
        state: makeFeatureState(),
        hostCtx: {},
      }),
    );
    assert.deepEqual(registry.degraded(), [], "五个模块都该正常装载，路由表才是完整的");

    const table = registry.routes();
    const keys = Object.keys(table);
    assert.ok(keys.includes("GET skills/settings"), "真实路由表里要有 GET skills/settings");
    assert.ok(keys.includes("POST skills/settings"), "真实路由表里要有 POST skills/settings");
    assert.ok(keys.includes("GET prompts/list"), "真实路由表里要有提示词的八条路由");
    assert.ok(keys.includes("POST prompts/save"), "真实路由表里要有提示词的八条路由");

    const routes = createFetchRoutes(table, logger);
    const paths = routes.map((route) => route.path);
    assert.equal(new Set(paths).size, paths.length, "每条路径只生成一条 FetchRoute");
    for (const route of routes) {
      assert.ok(route.methods.length > 0, route.path + " 的 methods 不能为空");
      assert.equal(new Set(route.methods).size, route.methods.length, route.path + " 的 methods 不能重复");
    }

    // 关键回归：用与 DSH 同语义的假 connection 整表注册一次，不抛。
    const { connection, registered } = makeFakeConnection();
    const registration = registerRoutes(connection, table, logger);
    assert.equal(registration.paths.length, paths.length);
    assert.equal(registered.size, paths.length, "注册数与路径数一致（每条路径只注册一次）");
    assert.ok(registered.has("/api/dsh-capability-hub/skills/settings"));
    assert.deepEqual(registered.get("/api/dsh-capability-hub/skills/settings")?.methods, ["GET", "POST"]);
    registration.dispose();
    assert.equal(registered.size, 0);
  } finally {
    await registry.disposeAll();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
