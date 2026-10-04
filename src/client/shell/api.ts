/**
 * 浏览器侧 API 客户端（PLAN §3.8）。
 *
 * 两个必须守住的细节：
 *   1. 路径是「文档相对」的（不带前导 /）。DSH 给 GUI 的 index.html 加了 <base href="./">，
 *      在子路径部署（例如 /dsh/dsh/）下根绝对的 /api/... 会逃出前缀、请求根本到不了插件
 *      路由（社区插件 skill-explorer 在注释里记录了同一个坑）。
 *   2. 鉴权由 DSH 自己负责：前缀挂在 /api 下，继承 browser-auth 的签名 cookie
 *      （SameSite=Strict + HttpOnly），浏览器同源 fetch 自动带上。
 */

/** 路由前缀（文档相对）。 */
export const API_PREFIX = "api/dsh-capability-hub/";

/** 一次 API 失败的完整信息。 */
export class ApiError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

/** 统一信封 { ok, data } / { ok, error }。 */
interface Envelope {
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
}

/** 把查询对象拼到路径上（跳过 undefined/null/空串）。 */
function withQuery(path: string, query?: Record<string, unknown>): string {
  if (query === undefined) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix === "" ? path : `${path}?${suffix}`;
}

/** 解析响应体；非 JSON 时给出可读错误。 */
async function parse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (!response.ok) throw new ApiError("BAD_RESPONSE", `服务端返回了非 JSON 响应（HTTP ${response.status}）`);
    throw new ApiError("BAD_RESPONSE", "服务端返回了非 JSON 响应");
  }
}

/** 发出一次请求并解信封。 */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      credentials: "same-origin",
      headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
      ...init,
    });
  } catch (error) {
    throw new ApiError("NETWORK", `请求失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const payload = (await parse(response)) as Envelope | undefined;
  if (response.status === 401) throw new ApiError("UNAUTHORIZED", "未通过 DSH 的浏览器鉴权（请从 DSH 打开的页面访问）");
  if (payload !== undefined && payload.ok === false) {
    const error = payload.error ?? {};
    throw new ApiError(error.code ?? "INTERNAL", error.message ?? `请求失败（HTTP ${response.status}）`, error.details);
  }
  if (!response.ok) throw new ApiError("HTTP_" + String(response.status), `请求失败（HTTP ${response.status}）`);
  return payload === undefined ? undefined : payload.data;
}

/** 能力中心 API 客户端。 */
export const api = {
  /** GET，返回 data。 */
  async get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<T> {
    return (await request(withQuery(path, query), { method: "GET" })) as T;
  },
  /** POST JSON，返回 data。 */
  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return (await request(path, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    })) as T;
  },
};

/** health 的返回形状（demo 模块）。 */
export interface HealthPayload {
  ok: boolean;
  plugin: string;
  profileName: string;
  homeDir: string;
  dshHome: string;
  hubHome: string;
  profileDir: string;
  customSkillDirs: string[];
  bundledSkillDir: string | null;
  sdk: { status: string; version?: string; mainResolved?: string; message?: string };
  modules: Array<{ name: string; status: string; routes: string[]; message?: string; loadMs?: number }>;
  tool: { registered: boolean; name: string; description: string };
  host: { dshVersion?: string; pid: number; nodeVersion: string; startedAt: string };
  sessionEvents: Array<{ kind: string; sessionId: string; parentSessionId?: string; at: string }>;
  /** 阶段 B 接线摘要。 */
  wiring?: {
    runtimeSource: "real" | "stub";
    runtimeReason?: string;
    lockStashBound: boolean;
    runtimeStarted: boolean;
    runtimeStartError?: string;
    notes: string[];
  };
  serverTime: string;
}

/** 读一次 health。 */
export async function fetchHealth(): Promise<HealthPayload> {
  return api.get<HealthPayload>("health");
}
