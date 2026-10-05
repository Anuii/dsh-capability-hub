/**
 * HTTP 传输层：把 PLAN §3.1 的路由键表适配到 DSH 的「已鉴权 exact Fetch 路由」。
 *
 * 为什么不是 ctx.webServer.register（重要，且是实测纠正）：
 *   webserver 只按 kind 分表，匹配顺序是「exact 全表 → 最长 prefix → fallback」，
 *   而 DSH 自己的信任闸 + browser-auth 是 dsh-client-connection 注册的 **prefix "/api"**
 *   处理器里做的（connection/lib/index.js:830-843：admit(req) → 401/403 → 才转发）。
 *   任何插件再注册一个更长的 prefix（如 "/api/dsh-capability-hub"）都会因「最长 prefix
 *   优先」把 "/api" 整条盖掉，于是请求根本不过鉴权闸。
 *   **实测**：V3 第一轮用 webServer prefix 注册，带 cookie 200、不带 cookie 同样 200。
 *
 * 正确做法：把每条接口注册成 connection 服务的 exact Fetch 路由
 *   ctx.connection.fetch.register({ path, methods, fetch })
 * （connection/lib/index.js:625-638 / 608-624）。这些路由由 "/api" 处理器在 admit() 之后
 * 派发，因此天然继承：Host/Origin 信任闸（403）+ browser-auth 签名 cookie（401）。
 *
 * 约束（connection 的 assertFetchRoute，:758-762）：
 *   - path 必须在 "/api/" 之下，且每一段都匹配 [A-Za-z0-9_$.-]+（不能有尾斜杠/空段）；
 *   - methods 非空且不重复；
 *   - fetch(request) 返回 Response（Web Fetch，而不是 node:http 的 req/res）。
 * 匹配是**精确 pathname**（fetchRoutes 是 Map，按 pathname 直接 get），所以一条接口 = 一条路由。
 */

import type { RouteTable } from "../contract/host.ts";
import type { RouteHandler, RouteRequest } from "../contract/host.ts";
import { asHubError } from "./errors.ts";

/** 路由前缀：不带尾斜杠（每段都要是合法 segment）。 */
export const ROUTE_PREFIX = "/api/dsh-capability-hub";

/** 请求体上限 1 MiB。 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** 允许的请求方法。 */
const METHODS = new Set(["GET", "POST"]);

/** 极简日志面（避免依赖具体 ctx.logger 类型）。 */
export interface RouterLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 一条 exact Fetch 路由（connection.fetch.register 的形状）。 */
export interface FetchRoute {
  path: string;
  methods: string[];
  /**
   * 请求体读取模式。**必须给 "buffered"**：bridge（connection/lib/index.js:34-81）只在
   * buffered 分支自己把 body 缓冲好再 new Request；否则走 streaming 分支给 Request 挂
   * ReadableStream body —— 对 GET 来说 new Request 会直接抛
   * 「Request with GET/HEAD method cannot have body」，最外层表现为 HTTP 400 空响应
   * （实测踩过：V3 第二轮带 cookie 得到 400）。
   */
  requestBody?: "buffered" | "streaming";
  fetch(request: Request): Promise<Response>;
}

/** ctx.connection 的最小面。 */
export interface ConnectionFace {
  fetch?: { register(route: FetchRoute): () => void };
}

/** 从 URLSearchParams 取第一个值的普通对象。 */
function queryObject(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of params) if (!(key in out)) out[key] = value;
  return out;
}

/** 写一个 JSON Response。 */
function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** 造一个带 status/code 的错误（由调用方映射成 JSON 信封）。 */
function badRequest(message: string): Error & { status?: number; code?: string } {
  const error = new Error(message) as Error & { status?: number; code?: string };
  error.status = 400;
  error.code = "BAD_REQUEST";
  return error;
}

/** 读请求体；超过上限 / 非 JSON 都抛 badRequest。 */
async function readBody(request: Request): Promise<unknown> {
  const text = (await request.text()).trim();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw badRequest("请求体超过 1 MiB 上限");
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}

/** 相对路径（去掉前缀与分隔斜杠），如 "skills/list"；前缀本身/无关路径返回空串。 */
export function relativePath(pathname: string): string {
  if (pathname === ROUTE_PREFIX) return "";
  if (!pathname.startsWith(ROUTE_PREFIX + "/")) return "";
  return pathname.slice(ROUTE_PREFIX.length + 1);
}

/** 把路由键 "GET skills/list" 解析成 { method, relative }（非法返回 undefined）。 */
export function parseRouteKey(key: string): { method: string; relative: string } | undefined {
  const at = key.indexOf(" ");
  if (at <= 0) return undefined;
  const method = key.slice(0, at).toUpperCase();
  const relative = key
    .slice(at + 1)
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!METHODS.has(method)) return undefined;
  // 与 DSH 的 endpointFromPath（connection/lib/index.js:711-716）对齐：段不能为空、
  // 不能是 "." / ".."，且只允许 [A-Za-z0-9_$.-]+。
  if (relative === "") return undefined;
  if (relative.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || !/^[A-Za-z0-9_$.-]+$/.test(seg))) {
    return undefined;
  }
  return { method, relative };
}

/** 路由键对应的绝对路径。 */
export function routePath(key: string): string | undefined {
  const parsed = parseRouteKey(key);
  return parsed === undefined ? undefined : ROUTE_PREFIX + "/" + parsed.relative;
}

/**
 * 把路由表编译成一组 exact Fetch 路由。
 * @param table 路由键表
 * @param logger 日志面（非法键只警告并跳过，不影响其他接口）
 */
export function createFetchRoutes(table: RouteTable, logger: RouterLogger): FetchRoute[] {
  const routes: FetchRoute[] = [];
  for (const [key, handler] of Object.entries(table)) {
    const parsed = parseRouteKey(key);
    if (parsed === undefined) {
      logger.warn("[capability-hub] 忽略非法路由键：" + JSON.stringify(key));
      continue;
    }
    const method = parsed.method;
    const relative = parsed.relative;
    routes.push({
      path: ROUTE_PREFIX + "/" + relative,
      methods: [method],
      requestBody: "buffered",
      async fetch(request: Request): Promise<Response> {
        try {
          const body = method === "POST" ? await readBody(request) : undefined;
          const routeRequest: RouteRequest = {
            query: queryObject(new URL(request.url).searchParams),
            body,
            signal: request.signal,
          };
          const data = await handler(routeRequest);
          if (request.signal.aborted) return new Response(null, { status: 499 });
          return json(200, { ok: true, data: data ?? {} });
        } catch (error) {
          const hub = asHubError(error);
          const status = typeof hub.status === "number" ? hub.status : 500;
          const code = typeof hub.code === "string" ? hub.code : "INTERNAL";
          if (status >= 500) logger.error("[capability-hub] " + method + " " + relative + " 失败：", hub);
          if (request.signal.aborted) return new Response(null, { status: 499 });
          return json(status, {
            ok: false,
            error: {
              code,
              message: hub.message === "" ? "内部错误" : hub.message,
              ...(hub.details === undefined ? {} : { details: hub.details }),
            },
          });
        }
      },
    });
  }
  return routes;
}

/**
 * 把路由表注册进 connection 服务的 exact Fetch 路由表（完成鉴权继承）。
 * @param connection ctx.connection（或 ctx.get("connection")）
 * @param table 路由键表
 * @param logger 日志面
 * @returns 已注册路径与解绑函数
 */
export function registerRoutes(
  connection: ConnectionFace,
  table: RouteTable,
  logger: RouterLogger,
): { paths: string[]; dispose(): void } {
  const face = connection.fetch;
  if (face === undefined || typeof face.register !== "function") throw new Error("connection.fetch.register 不可用");
  const disposers: Array<() => void> = [];
  const paths: string[] = [];
  try {
    for (const route of createFetchRoutes(table, logger)) {
      disposers.push(face.register(route));
      paths.push(route.path);
    }
  } catch (error) {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 回滚失败忽略 */
      }
    }
    throw error;
  }
  return {
    paths,
    dispose(): void {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* 解绑失败不影响其他注册 */
        }
      }
    },
  };
}
