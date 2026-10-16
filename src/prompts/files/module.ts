/**
 * prompts-files 模块工厂与 HTTP 路由。
 *
 * 路由键形如 "GET prompts/list"，相对路径不含 /api/dsh-capability-hub/ 前缀。
 * 失败一律抛带 status/code 的 Error，由平台层路由器转成 { ok:false, error:{ code, message, details? } }。
 *
 * 本模块**不依赖任何其他功能模块**（ADR-0001 规则 1）：外壳把「读 DSH 组合配置」的函数
 * （prompt-settings.ts）注入进来，别的一律自己算。
 */

import { badRequest, notFound } from "../../shared/errors.ts";
import { asRecord, optionalString, requireBoolean, requireString } from "../../shared/request.ts";
import { createPromptsFilesImpl, isCreateLocation, type PromptsFilesDeps, type PromptsFilesImpl } from "./api.ts";
import type { HubContext, HubModule, RouteHandler } from "../../platform/contract/host.ts";

export interface PromptsFilesModule extends HubModule {
  impl: PromptsFilesImpl;
}

export function createPromptsFilesModule(ctx: HubContext, deps: PromptsFilesDeps): PromptsFilesModule {
  const impl = createPromptsFilesImpl(ctx, deps);

  const routes: Record<string, RouteHandler> = {
    "GET prompts/list": async (req) => {
      const workspace = optionalString(req.query.workspace, "workspace");
      return await impl.list(workspace === undefined ? {} : { workspace });
    },

    "GET prompts/view": async (req) => {
      const id = requireString(req.query.id, "id");
      const workspace = optionalString(req.query.workspace, "workspace");
      return await impl.view(id, workspace === undefined ? {} : { workspace });
    },

    "POST prompts/save": async (req) => {
      const body = asRecord(req.body);
      const id = requireString(body.id, "id");
      if (typeof body.content !== "string") throw badRequest("参数 content 必须是字符串。");
      const baseVersion = requireString(body.baseVersion, "baseVersion");
      const workspace = optionalString(body.workspace, "workspace");
      return await impl.save({
        id,
        content: body.content,
        baseVersion,
        ...(workspace === undefined ? {} : { workspace }),
      });
    },

    "POST prompts/create": async (req) => {
      const body = asRecord(req.body);
      const location = body.location;
      if (!isCreateLocation(location)) {
        throw badRequest("参数 location 只能是 global / project-root / workspace 之一。");
      }
      const workspace = optionalString(body.workspace, "workspace");
      return await impl.create(location, workspace === undefined ? {} : { workspace });
    },

    "POST prompts/set-enabled": async (req) => {
      const body = asRecord(req.body);
      const id = requireString(body.id, "id");
      const enabled = requireBoolean(body.enabled, "enabled");
      const workspace = optionalString(body.workspace, "workspace");
      return await impl.setEnabled(id, enabled, workspace === undefined ? {} : { workspace });
    },

    "GET prompts/trash": async () => {
      return { items: await impl.trashList() };
    },

    "POST prompts/trash/restore": async (req) => {
      const body = asRecord(req.body);
      const trashId = requireString(body.trashId, "trashId");
      const workspace = optionalString(body.workspace, "workspace");
      return await impl.restore(trashId, workspace === undefined ? {} : { workspace });
    },

    "POST prompts/trash/purge": async (req) => {
      const body = req.body === undefined || req.body === null ? {} : asRecord(req.body);
      const trashId = optionalString(body.trashId, "trashId");
      return { purged: await impl.purge(trashId) };
    },
  };

  return {
    routes,
    impl,
  };
}

export { notFound };
