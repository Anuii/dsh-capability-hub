/**
 * mcp-config 模块工厂与 HTTP 路由（PLAN §3.5 / §3.7「MCP·配置」）。
 *
 * 路由键形如 "GET mcp/config"，相对路径不含 /api/dsh-capability-hub/ 前缀。
 * 失败一律抛带 status/code 的 Error（PLAN §3.1），由平台层路由器转成
 * { ok:false, error:{ code, message, details? } }；VALIDATION 的 details 是 FieldError[]。
 */

import { badRequest, conflict, notFound, validation } from "../../shared/errors.ts";
import { asRecord, optionalString, requireString, requireBoolean, requireStringArray } from "../../shared/request.ts";
import { checkCommand, type CheckCommandOptions } from "./check-command.ts";
import { mapServerFields, parseMcpJson } from "./intake.ts";
import { HIDDEN_PLACEHOLDER_MESSAGE, findHiddenPlaceholders, maskRawServer, mergeHiddenSecrets } from "./mask.ts";
import { serverView } from "./schema.ts";
import { parseServerInput } from "../rules/server.ts";
import { createMcpStore, type McpStore, type McpStoreOptions } from "./store.ts";
import type { McpConfigModule } from "./types.ts";
import type { EffectiveServer, ServerView } from "../contract/config.ts";
import type { HubContext, HubModule, RouteHandler } from "../../platform/contract/host.ts";

export interface McpConfigModuleOptions {
  /** 存储层选项（轮询间隔、时间源），测试用。 */
  store?: McpStoreOptions;
  /** 命令检查的默认环境（PATH/PATHEXT/cwd/platform），测试用。 */
  commandCheck?: CheckCommandOptions;
}

// —— 请求体小工具 ——

/** 返回值是契约的超集：额外暴露 store 与 ready()，方便宿主/测试等待首次加载。 */
export interface McpConfigModuleExports extends McpConfigModule {
  store: McpStore;
  ready(): Promise<void>;
  /** 契约里 dispose 可选，本模块总是提供（返回更严格的类型不影响赋给 HubModule）。 */
  dispose(): void;
}

export function createMcpConfigModule(ctx: HubContext, opts: McpConfigModuleOptions = {}): McpConfigModuleExports {
  const store: McpStore = createMcpStore(ctx.hubHome, ctx.logger, opts.store);

  /** 当前生效服务器的明文（内部使用，绝不直接返回给调用方）。 */
  function rawServerOf(name: string): EffectiveServer | undefined {
    return store.get().servers.find((server) => server.serverName === name);
  }

  function rawStoredOf(name: string): ReturnType<McpStore["getRaw"]>["servers"][number] | undefined {
    return store.getRaw().servers.find((server) => server.serverName === name);
  }

  function toView(name: string): ServerView {
    const effective = rawServerOf(name);
    if (effective === undefined) throw notFound("找不到服务器「" + name + "」。");
    const stored = rawStoredOf(name);
    const maskedStored = maskRawServer(stored);
    const maskedEffective: EffectiveServer = {
      ...effective,
      env: Object.fromEntries(Object.keys(effective.env).map((key) => [key, "***hidden***"])),
      headers: Object.fromEntries(Object.keys(effective.headers).map((key) => [key, "***hidden***"])),
    };
    return serverView(maskedEffective, maskedStored);
  }

  function route(handler: RouteHandler): RouteHandler {
    return async (req) => {
      await store.ready();
      return await handler(req);
    };
  }

  const handlers: Record<string, RouteHandler> = {
    "GET mcp/config": async () => {
      const config = store.get();
      const raw = store.getRaw();
      const byName = new Map(raw.servers.map((server) => [server.serverName as string, server]));
      return {
        servers: config.servers.map((server) =>
          serverView(maskEffective(server), maskRawServer(byName.get(server.serverName))),
        ),
        warnings: [...store.warnings],
      };
    },

    "POST mcp/servers/upsert": async (req) => {
      const body = asRecord(req.body);
      const originalName = optionalString(body.originalName, "originalName");
      if (body.server === undefined || body.server === null) throw badRequest("缺少必填参数 server。");
      let submitted = asRecord(body.server);
      // FIX-3：`***hidden***` 只是视图占位符。只有「原配置里真有这个键」时才允许提交占位符
      // （保留原值）；否则一律拒绝，绝不把它当真实值落盘。新建服务器（没有 originalName，
      // 或 originalName 指向的服务器不存在）因此全部落在拒绝这一侧。
      const existingForMerge = originalName === undefined ? undefined : rawStoredOf(originalName);
      const placeholders = findHiddenPlaceholders(submitted, existingForMerge);
      if (placeholders.length > 0) throw validation(HIDDEN_PLACEHOLDER_MESSAGE, placeholders);
      if (originalName !== undefined) {
        const existing = existingForMerge;
        if (existing === undefined) throw notFound("找不到要修改的服务器「" + originalName + "」。");
        // 提交值仍为遮罩占位时保留原值
        const merged: Record<string, unknown> = { ...submitted };
        for (const field of ["env", "headers"] as const) {
          const rawValue = submitted[field];
          if (rawValue === undefined || rawValue === null || typeof rawValue !== "object" || Array.isArray(rawValue))
            continue;
          merged[field] = mergeHiddenSecrets(
            rawValue as Record<string, string>,
            (existing as Record<string, unknown>)[field] as Record<string, string> | undefined,
          );
        }
        if (merged.serverName === undefined) merged.serverName = originalName;
        submitted = merged;
      }

      const currentNames = store.get().servers.map((server) => server.serverName);
      const parsed = parseServerInput(submitted, { existingNames: currentNames, originalName });
      if (parsed.errors.length > 0) throw validation("MCP 服务器配置校验未通过。", parsed.errors);
      const serverName = parsed.server.serverName as string;

      // D-C4：保存时检查启动命令（只查 PATH，不执行）
      const warnings: string[] = [];
      if (parsed.server.transport === "stdio" && typeof parsed.server.command === "string") {
        const check = await checkCommand(parsed.server.command, opts.commandCheck ?? {});
        if (!check.found) {
          warnings.push("没有找到启动命令「" + parsed.server.command + "」，请确认它已安装并在 PATH 中。");
          ctx.logger.warn("mcp-config: 找不到启动命令 " + parsed.server.command + "（服务器 " + serverName + "）");
        }
      }

      await store.save((draft) => {
        const index = originalName === undefined ? -1 : draft.servers.findIndex((s) => s.serverName === originalName);
        if (originalName !== undefined && index < 0) throw notFound("找不到要修改的服务器「" + originalName + "」。");
        const clash = draft.servers.some((s, i) => s.serverName === serverName && i !== index);
        if (clash) throw conflict("服务器名称「" + serverName + "」已存在。");
        if (index >= 0) draft.servers[index] = parsed.server;
        else draft.servers.push(parsed.server);
      });

      return { server: toView(serverName), warnings };
    },

    "POST mcp/servers/delete": async (req) => {
      const body = asRecord(req.body);
      const name = requireString(body.name, "name");
      await store.save((draft) => {
        const index = draft.servers.findIndex((s) => s.serverName === name);
        if (index < 0) throw notFound("找不到服务器「" + name + "」。");
        draft.servers.splice(index, 1);
      });
      return {};
    },

    "POST mcp/servers/toggle": async (req) => {
      const body = asRecord(req.body);
      const name = requireString(body.name, "name");
      const disabled = requireBoolean(body.disabled, "disabled");
      await store.save((draft) => {
        const server = draft.servers.find((s) => s.serverName === name);
        if (server === undefined) throw notFound("找不到服务器「" + name + "」。");
        if (disabled) server.disabled = true;
        else delete server.disabled;
      });
      return { server: toView(name) };
    },

    "POST mcp/servers/reorder": async (req) => {
      const body = asRecord(req.body);
      const names = requireStringArray(body.names, "names");
      await store.save((draft) => {
        const current = draft.servers
          .map((s) => s.serverName)
          .filter((name): name is string => typeof name === "string");
        const errors: { path: string; message: string }[] = [];
        if (names.length !== current.length) {
          errors.push({
            path: "names",
            message: "新顺序必须包含全部 " + current.length + " 个服务器（当前给了 " + names.length + " 个）。",
          });
        }
        for (const name of names) {
          if (!current.includes(name)) errors.push({ path: "names", message: "未知的服务器「" + name + "」。" });
        }
        const seen = new Set<string>();
        for (const name of names) {
          if (seen.has(name)) errors.push({ path: "names", message: "服务器「" + name + "」重复出现。" });
          seen.add(name);
        }
        for (const name of current) {
          if (!names.includes(name)) errors.push({ path: "names", message: "缺少服务器「" + name + "」。" });
        }
        if (errors.length > 0) throw validation("排序请求与现有服务器列表不一致。", errors);
        const byName = new Map(draft.servers.map((s) => [s.serverName, s]));
        draft.servers = names.map((name) => byName.get(name) as (typeof draft.servers)[number]);
      });
      const config = store.get();
      return {
        servers: config.servers.map((server) =>
          serverView(maskEffective(server), maskRawServer(rawStoredOf(server.serverName))),
        ),
      };
    },

    "POST mcp/servers/reveal": async (req) => {
      const body = asRecord(req.body);
      const name = requireString(body.name, "name");
      const effective = rawServerOf(name);
      if (effective === undefined) throw notFound("找不到服务器「" + name + "」。");
      ctx.logger.debug("mcp-config: reveal 服务器「" + name + "」（明文仅返回给本次请求）");
      return { server: serverView(effective, rawStoredOf(name)) };
    },

    "POST mcp/parse-json": async (req) => {
      const body = asRecord(req.body);
      if (typeof body.text !== "string") throw badRequest("参数 text 必须是字符串。");
      const result = parseMcpJson(body.text);
      // D-C4：顺手检查启动命令（只查不执行），没找到就作为一条 warning 回去
      const commandWarnings: string[] = [];
      await Promise.all(
        result.servers.map(async (server) => {
          if (server.transport !== "stdio" || typeof server.command !== "string") return;
          const check = await checkCommand(server.command, opts.commandCheck ?? {});
          if (!check.found) {
            commandWarnings.push(
              "服务器「" +
                server.serverName +
                "」的启动命令「" +
                server.command +
                "」没有找到，请确认已安装并在 PATH 中。",
            );
          }
        }),
      );
      return { servers: result.servers, warnings: [...result.warnings, ...commandWarnings] };
    },

    "POST mcp/check-command": async (req) => {
      const body = asRecord(req.body);
      const command = requireString(body.command, "command");
      const cwd = optionalString(body.cwd, "cwd");
      const baseOpts = opts.commandCheck ?? {};
      const result = await checkCommand(command, cwd === undefined ? baseOpts : { ...baseOpts, cwd });
      return result;
    },
  };

  const routes: Record<string, RouteHandler> = {};
  for (const [key, handler] of Object.entries(handlers)) routes[key] = route(handler);

  return {
    routes,
    source: store,
    store,
    ready: () => store.ready(),
    dispose() {
      store.dispose();
    },
  };
}

/** 遮罩一个生效服务器（复制，不改原对象）。 */
function maskEffective(server: EffectiveServer): EffectiveServer {
  return {
    ...server,
    env: Object.fromEntries(Object.keys(server.env).map((key) => [key, "***hidden***"])),
    headers: Object.fromEntries(Object.keys(server.headers).map((key) => [key, "***hidden***"])),
  };
}

export { mapServerFields };
