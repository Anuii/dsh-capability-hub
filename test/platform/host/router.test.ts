/**
 * 平台层路由适配的单测。
 *
 * 覆盖的都是实测踩过的坑：
 *   - prefix 不能带尾斜杠（V3 第一轮 404）；
 *   - Fetch 路由必须声明 requestBody: "buffered"（V3 第二轮 400）；
 *   - 信封 { ok, data } / { ok, error } 与错误状态映射。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFetchRoutes, parseRouteKey, registerRoutes, relativePath, routePath } from "../../../src/platform/host/router.ts";
import type { RouterLogger } from "../../../src/platform/host/router.ts";
import type { RouteTable } from "../../../src/platform/contract/host.ts";

const logger: RouterLogger = { debug() {}, warn() {}, error() {} };

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

test("Fetch 路由：成功走 { ok: true, data } 信封", async () => {
  const routes = createFetchRoutes({ "GET health": async () => ({ answer: 42 }) }, logger);
  const response = await routes[0].fetch(new Request("http://dsh.invalid/api/dsh-capability-hub/health", { method: "GET" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, data: { answer: 42 } });
});

test("Fetch 路由：错误映射成 { ok: false, error }，保留 status/code", async () => {
  const failure = new Error("找不到技能") as Error & { status: number; code: string };
  failure.status = 404;
  failure.code = "NOT_FOUND";
  const routes = createFetchRoutes({ "GET skills/get": async () => { throw failure; } }, logger);
  const response = await routes[0].fetch(new Request("http://dsh.invalid/api/dsh-capability-hub/skills/get"));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: { code: "NOT_FOUND", message: "找不到技能" } });
});

test("Fetch 路由：POST 请求体不是 JSON → 400", async () => {
  const routes = createFetchRoutes({ "POST echo": async (req) => req.body }, logger);
  const response = await routes[0].fetch(new Request("http://dsh.invalid/api/dsh-capability-hub/echo", {
    method: "POST",
    body: "not json",
  }));
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { ok: boolean; error: { code: string } };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "BAD_REQUEST");
});

test("registerRoutes：注册进 connection.fetch，dispose 会全部注销", () => {
  const registered: string[] = [];
  const connection = {
    fetch: {
      register(route: { path: string }): () => void {
        registered.push(route.path);
        return () => { registered.splice(registered.indexOf(route.path), 1); };
      },
    },
  };
  const table: RouteTable = {
    "GET health": async () => ({}),
    "GET skills/list": async () => ({}),
  };
  const registration = registerRoutes(connection, table, logger);
  assert.deepEqual(registration.paths, ["/api/dsh-capability-hub/health", "/api/dsh-capability-hub/skills/list"]);
  registration.dispose();
  assert.deepEqual(registered, []);
});

test("registerRoutes：connection 不可用时抛错（宁可降级也不退回无鉴权的 prefix）", () => {
  assert.throws(() => registerRoutes({}, { "GET health": async () => ({}) }, logger), /connection\.fetch\.register/);
});
