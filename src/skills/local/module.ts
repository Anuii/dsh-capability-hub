/**
 * skills-local 模块工厂与 HTTP 路由（PLAN §3.3 / §3.7）。
 *
 * 路由键形如 "GET skills/list"，相对路径不含 /api/dsh-capability-hub/ 前缀。
 * 失败一律抛带 status/code 的 Error，由平台层路由器转成
 * { ok:false, error:{ code, message, details? } }。
 */

import { badRequest } from "../../shared/errors.ts";
import { createSkillsLocalImpl, type SkillsLocalDeps, type SkillsLocalImpl } from "./api.ts";
import type { HubContext, HubModule, RouteHandler } from "../../platform/contract/host.ts";
import type { LockStash, SkillsLocalApi } from "../contract/local.ts";

export interface SkillsLocalModule extends HubModule {
  api: SkillsLocalApi;
  bindLockStash(stash: LockStash): void;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("请求体必须是一个 JSON 对象。");
  }
  return body as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw badRequest("参数 " + name + " 必须是字符串。");
  return value;
}

function requireString(value: unknown, name: string): string {
  const out = optionalString(value, name);
  if (out === undefined) throw badRequest("缺少必填参数 " + name + "。");
  return out;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw badRequest("参数 " + name + " 必须是布尔值（true/false）。");
  return value;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw badRequest("参数 " + name + " 必须是布尔值（true/false）。");
  return value;
}

export function createSkillsLocalModule(ctx: HubContext, deps: SkillsLocalDeps): SkillsLocalModule {
  const impl: SkillsLocalImpl = createSkillsLocalImpl(ctx, deps);

  const routes: Record<string, RouteHandler> = {
    "GET skills/list": async (req) => {
      const workspace = optionalString(req.query.workspace, "workspace");
      return await impl.list(workspace === undefined ? {} : { workspace });
    },

    "GET skills/view": async (req) => {
      const id = requireString(req.query.id, "id");
      const workspace = optionalString(req.query.workspace, "workspace");
      return await impl.view(id, workspace === undefined ? {} : { workspace });
    },

    "POST skills/set-enabled": async (req) => {
      const body = asRecord(req.body);
      const id = requireString(body.id, "id");
      const enabled = requireBoolean(body.enabled, "enabled");
      const workspace = optionalString(body.workspace, "workspace");
      const skill = await impl.setEnabled(id, enabled, workspace === undefined ? {} : { workspace });
      return { skill };
    },

    "POST skills/delete": async (req) => {
      const body = asRecord(req.body);
      const id = requireString(body.id, "id");
      const workspace = optionalString(body.workspace, "workspace");
      const item = await impl.moveToTrash(
        id,
        workspace === undefined ? { reason: "delete" } : { reason: "delete", workspace },
      );
      return { item };
    },

    "GET skills/trash": async () => {
      return { items: await impl.trashList() };
    },

    "POST skills/trash/restore": async (req) => {
      const body = asRecord(req.body);
      const trashId = requireString(body.trashId, "trashId");
      const replace = optionalBoolean(body.replace, "replace");
      const workspace = optionalString(body.workspace, "workspace");
      const opts: { replace?: boolean; workspace?: string } = {};
      if (replace !== undefined) opts.replace = replace;
      if (workspace !== undefined) opts.workspace = workspace;
      const skill = await impl.restore(trashId, opts);
      return { skill };
    },

    "POST skills/trash/purge": async (req) => {
      const body = req.body === undefined || req.body === null ? {} : asRecord(req.body);
      const trashId = optionalString(body.trashId, "trashId");
      return { purged: await impl.purge(trashId) };
    },
  };

  const api: SkillsLocalApi = {
    list: (opts) => impl.list(opts),
    get: (id, opts) => impl.get(id, opts),
    setEnabled: (id, enabled, opts) => impl.setEnabled(id, enabled, opts),
    moveToTrash: (id, opts) => impl.moveToTrash(id, opts),
    rootPath: (rootId, opts) => impl.rootPath(rootId, opts),
    view: (id, opts) => impl.view(id, opts),
    trashList: () => impl.trashList(),
    restore: (trashId, opts) => impl.restore(trashId, opts),
    purge: (trashId) => impl.purge(trashId),
  };

  return {
    routes,
    api,
    bindLockStash(stash: LockStash) {
      impl.bindLockStash(stash);
    },
  };
}
