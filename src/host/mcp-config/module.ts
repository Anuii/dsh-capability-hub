/**
 * mcp-config 模块工厂与 HTTP 路由（PLAN §3.5 / §3.7「MCP·配置」）。
 *
 * 路由键形如 "GET mcp/config"，相对路径不含 /api/dsh-capability-hub/ 前缀。
 * 失败一律抛带 status/code 的 Error（PLAN §3.1），由平台层路由器转成
 * { ok:false, error:{ code, message, details? } }；VALIDATION 的 details 是 FieldError[]。
 */

import { badRequest, conflict, notFound, validationFailed } from './errors.ts';
import { checkCommand, type CheckCommandOptions } from './check-command.ts';
import {
  listImportSources,
  listPresets,
  mapServerFields,
  parseMcpJson,
  readImportSource,
  type ImportContext,
} from './intake.ts';
import { HIDDEN_PLACEHOLDER_MESSAGE, findHiddenPlaceholders, maskRawServer, mergeHiddenSecrets } from './mask.ts';
import { parseServerInput, parseSettingsInput, serverView } from './schema.ts';
import { createMcpStore, type McpStore, type McpStoreOptions } from './store.ts';
import type {
  EffectiveServer,
  HubContext,
  HubModule,
  McpConfigModule,
  RouteHandler,
  ServerView,
} from './types.ts';

export interface McpConfigModuleOptions {
  /** 存储层选项（轮询间隔、时间源），测试用。 */
  store?: McpStoreOptions;
  /** 命令检查的默认环境（PATH/PATHEXT/cwd/platform），测试用。 */
  commandCheck?: CheckCommandOptions;
}

// —— 请求体小工具 ——

function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('请求体必须是一个 JSON 对象。');
  }
  return body as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw badRequest('参数 ' + name + ' 必须是字符串。');
  return value;
}

function requireString(value: unknown, name: string): string {
  const out = optionalString(value, name);
  if (out === undefined) throw badRequest('缺少必填参数 ' + name + '。');
  return out;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw badRequest('参数 ' + name + ' 必须是布尔值（true/false）。');
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw badRequest('参数 ' + name + ' 必须是字符串数组。');
  }
  return value as string[];
}

/** 返回值是契约的超集：额外暴露 store 与 ready()，方便宿主/测试等待首次加载。 */
export interface McpConfigModuleExports extends McpConfigModule {
  store: McpStore;
  ready(): Promise<void>;
  /** 契约里 dispose 可选，本模块总是提供（返回更严格的类型不影响赋给 HubModule）。 */
  dispose(): void;
}

export function createMcpConfigModule(ctx: HubContext, opts: McpConfigModuleOptions = {}): McpConfigModuleExports {
  const store: McpStore = createMcpStore(ctx.hubHome, ctx.logger, opts.store);
  const importCtx: ImportContext = { homeDir: ctx.homeDir, logger: ctx.logger };

  /** 当前生效服务器的明文（内部使用，绝不直接返回给调用方）。 */
  function rawServerOf(name: string): EffectiveServer | undefined {
    return store.get().servers.find((server) => server.serverName === name);
  }

  function rawStoredOf(name: string): ReturnType<McpStore['getRaw']>['servers'][number] | undefined {
    return store.getRaw().servers.find((server) => server.serverName === name);
  }

  function toView(name: string): ServerView {
    const effective = rawServerOf(name);
    if (effective === undefined) throw notFound('找不到服务器「' + name + '」。');
    const stored = rawStoredOf(name);
    const maskedStored = maskRawServer(stored);
    const maskedEffective: EffectiveServer = {
      ...effective,
      env: Object.fromEntries(Object.keys(effective.env).map((key) => [key, '***hidden***'])),
      headers: Object.fromEntries(Object.keys(effective.headers).map((key) => [key, '***hidden***'])),
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
    'GET mcp/config': async () => {
      const config = store.get();
      const raw = store.getRaw();
      const byName = new Map(raw.servers.map((server) => [server.serverName as string, server]));
      return {
        settings: config.settings,
        settingsSet: Object.keys(raw.settings ?? {}),
        servers: config.servers.map((server) => serverView(maskEffective(server), maskRawServer(byName.get(server.serverName)))),
        warnings: [...store.warnings],
      };
    },

    'POST mcp/servers/upsert': async (req) => {
      const body = asRecord(req.body);
      const originalName = optionalString(body.originalName, 'originalName');
      if (body.server === undefined || body.server === null) throw badRequest('缺少必填参数 server。');
      let submitted = asRecord(body.server);
      // FIX-3：`***hidden***` 只是视图占位符。只有「原配置里真有这个键」时才允许提交占位符
      // （保留原值）；否则一律拒绝，绝不把它当真实值落盘。新建服务器（没有 originalName，
      // 或 originalName 指向的服务器不存在）因此全部落在拒绝这一侧。
      const existingForMerge = originalName === undefined ? undefined : rawStoredOf(originalName);
      const placeholders = findHiddenPlaceholders(submitted, existingForMerge);
      if (placeholders.length > 0) throw validationFailed(HIDDEN_PLACEHOLDER_MESSAGE, placeholders);
      if (originalName !== undefined) {
        const existing = existingForMerge;
        if (existing === undefined) throw notFound('找不到要修改的服务器「' + originalName + '」。');
        // 提交值仍为遮罩占位时保留原值
        const merged: Record<string, unknown> = { ...submitted };
        for (const field of ['env', 'headers'] as const) {
          const rawValue = submitted[field];
          if (rawValue === undefined || rawValue === null || typeof rawValue !== 'object' || Array.isArray(rawValue)) continue;
          merged[field] = mergeHiddenSecrets(rawValue as Record<string, string>, (existing as Record<string, unknown>)[field] as
            | Record<string, string>
            | undefined);
        }
        if (merged.serverName === undefined) merged.serverName = originalName;
        submitted = merged;
      }

      const currentNames = store.get().servers.map((server) => server.serverName);
      const parsed = parseServerInput(submitted, { existingNames: currentNames, originalName });
      if (parsed.errors.length > 0) throw validationFailed('MCP 服务器配置校验未通过。', parsed.errors);
      const serverName = parsed.server.serverName as string;

      // D-C4：保存时检查启动命令（只查 PATH，不执行）
      const warnings: string[] = [];
      if (parsed.server.transport === 'stdio' && typeof parsed.server.command === 'string') {
        const check = await checkCommand(parsed.server.command, opts.commandCheck ?? {});
        if (!check.found) {
          warnings.push('没有找到启动命令「' + parsed.server.command + '」，请确认它已安装并在 PATH 中。');
          ctx.logger.warn('mcp-config: 找不到启动命令 ' + parsed.server.command + '（服务器 ' + serverName + '）');
        }
      }

      await store.save((draft) => {
        const index = originalName === undefined ? -1 : draft.servers.findIndex((s) => s.serverName === originalName);
        if (originalName !== undefined && index < 0) throw notFound('找不到要修改的服务器「' + originalName + '」。');
        const clash = draft.servers.some((s, i) => s.serverName === serverName && i !== index);
        if (clash) throw conflict('服务器名称「' + serverName + '」已存在。');
        if (index >= 0) draft.servers[index] = parsed.server;
        else draft.servers.push(parsed.server);
      });

      return { server: toView(serverName), warnings };
    },

    'POST mcp/servers/delete': async (req) => {
      const body = asRecord(req.body);
      const name = requireString(body.name, 'name');
      await store.save((draft) => {
        const index = draft.servers.findIndex((s) => s.serverName === name);
        if (index < 0) throw notFound('找不到服务器「' + name + '」。');
        draft.servers.splice(index, 1);
      });
      return {};
    },

    'POST mcp/servers/toggle': async (req) => {
      const body = asRecord(req.body);
      const name = requireString(body.name, 'name');
      const disabled = requireBoolean(body.disabled, 'disabled');
      await store.save((draft) => {
        const server = draft.servers.find((s) => s.serverName === name);
        if (server === undefined) throw notFound('找不到服务器「' + name + '」。');
        if (disabled) server.disabled = true;
        else delete server.disabled;
      });
      return { server: toView(name) };
    },

    'POST mcp/servers/reorder': async (req) => {
      const body = asRecord(req.body);
      const names = requireStringArray(body.names, 'names');
      await store.save((draft) => {
        const current = draft.servers
          .map((s) => s.serverName)
          .filter((name): name is string => typeof name === 'string');
        const errors: { path: string; message: string }[] = [];
        if (names.length !== current.length) {
          errors.push({ path: 'names', message: '新顺序必须包含全部 ' + current.length + ' 个服务器（当前给了 ' + names.length + ' 个）。' });
        }
        for (const name of names) {
          if (!current.includes(name)) errors.push({ path: 'names', message: '未知的服务器「' + name + '」。' });
        }
        const seen = new Set<string>();
        for (const name of names) {
          if (seen.has(name)) errors.push({ path: 'names', message: '服务器「' + name + '」重复出现。' });
          seen.add(name);
        }
        for (const name of current) {
          if (!names.includes(name)) errors.push({ path: 'names', message: '缺少服务器「' + name + '」。' });
        }
        if (errors.length > 0) throw validationFailed('排序请求与现有服务器列表不一致。', errors);
        const byName = new Map(draft.servers.map((s) => [s.serverName, s]));
        draft.servers = names.map((name) => byName.get(name) as (typeof draft.servers)[number]);
      });
      const config = store.get();
      return { servers: config.servers.map((server) => serverView(maskEffective(server), maskRawServer(rawStoredOf(server.serverName)))) };
    },

    'POST mcp/servers/reveal': async (req) => {
      const body = asRecord(req.body);
      const name = requireString(body.name, 'name');
      const effective = rawServerOf(name);
      if (effective === undefined) throw notFound('找不到服务器「' + name + '」。');
      ctx.logger.debug('mcp-config: reveal 服务器「' + name + '」（明文仅返回给本次请求）');
      return { server: serverView(effective, rawStoredOf(name)) };
    },

    'POST mcp/settings/update': async (req) => {
      const body = asRecord(req.body);
      const parsed = parseSettingsInput(body.settings);
      if (parsed.errors.length > 0) throw validationFailed('全局设置校验未通过。', parsed.errors);
      const next = await store.save((draft) => {
        draft.settings = parsed.settings;
      });
      void next;
      const config = store.get();
      return { settings: config.settings, settingsSet: Object.keys(store.getRaw().settings ?? {}) };
    },

    'POST mcp/validate': async (req) => {
      const body = asRecord(req.body);
      if (body.server === undefined || body.server === null) throw badRequest('缺少必填参数 server。');
      const originalName = optionalString(body.originalName, 'originalName');
      const submitted = asRecord(body.server);
      const currentNames = store.get().servers.map((server) => server.serverName);
      const parsed = parseServerInput(submitted, { existingNames: currentNames, originalName });
      // FIX-3：与 upsert 同一条判据 —— 没有原值可回填的遮罩占位符在这里也逐键报出来，
      // 界面因此会在「保存前预览」阶段就拦住它（validate 从不落盘）。
      const placeholders = findHiddenPlaceholders(submitted, originalName === undefined ? undefined : rawStoredOf(originalName));
      // 回显的归一化结果同样遮罩：validate 不是 reveal，不得把提交的敏感值再吐回去。
      return { errors: [...placeholders, ...parsed.errors], server: maskRawServer(parsed.server) };
    },

    'POST mcp/parse-json': async (req) => {
      const body = asRecord(req.body);
      if (typeof body.text !== 'string') throw badRequest('参数 text 必须是字符串。');
      const result = parseMcpJson(body.text);
      // D-C4：顺手检查启动命令（只查不执行），没找到就作为一条 warning 回去
      const commandWarnings: string[] = [];
      await Promise.all(
        result.servers.map(async (server) => {
          if (server.transport !== 'stdio' || typeof server.command !== 'string') return;
          const check = await checkCommand(server.command, opts.commandCheck ?? {});
          if (!check.found) {
            commandWarnings.push('服务器「' + server.serverName + '」的启动命令「' + server.command + '」没有找到，请确认已安装并在 PATH 中。');
          }
        }),
      );
      return { servers: result.servers, warnings: [...result.warnings, ...commandWarnings] };
    },

    'GET mcp/presets': async () => {
      const presets = listPresets();
      const annotated = await Promise.all(
        presets.map(async (preset) => {
          if (preset.server.transport !== 'stdio' || typeof preset.server.command !== 'string') {
            return { ...preset, commandFound: true };
          }
          const check = await checkCommand(preset.server.command, opts.commandCheck ?? {});
          return { ...preset, commandFound: check.found, resolvedPath: check.resolvedPath };
        }),
      );
      return { presets: annotated };
    },

    'GET mcp/import/sources': async () => {
      const sources = await listImportSources(importCtx);
      return { sources };
    },

    'POST mcp/import/apply': async (req) => {
      const body = asRecord(req.body);
      const sourceId = requireString(body.sourceId, 'sourceId');
      if (sourceId !== 'claude-code' && sourceId !== 'codex') {
        throw badRequest('参数 sourceId 只能是 claude-code 或 codex。');
      }
      const names = requireStringArray(body.names, 'names');

      const { label, plain } = await readImportSource(importCtx, sourceId);
      if (!plain.found) throw notFound('没有找到 ' + label + ' 的配置文件：' + plain.path + '。');
      const source = {
        label,
        path: plain.path,
        warnings: plain.warnings,
        servers: plain.servers.map((server) => maskRawServer(server) as Record<string, unknown>),
        plainServers: plain.servers as unknown as Record<string, unknown>[],
      };

      const imported: string[] = [];
      const skipped: { name: string; reason: string }[] = [];
      const views: ServerView[] = [];

      for (const name of names) {
        const candidate = source.servers.find((server) => server.serverName === name);
        if (candidate === undefined) {
          skipped.push({ name, reason: '来源里没有这个服务器。' });
          continue;
        }
        // 同名跳过（D-C2：导入不覆盖已有配置）
        if (store.get().servers.some((server) => server.serverName === name)) {
          skipped.push({ name, reason: '同名服务器已存在，已跳过（导入不会覆盖现有配置）。' });
          continue;
        }
        // 遮罩值配上明文副本，避免把导入的密钥丢掉
        const plain = source.plainServers.find((item) => item.serverName === name) ?? (candidate as unknown as Record<string, unknown>);
        const merged: Record<string, unknown> = { ...plain };
        for (const field of ['env', 'headers'] as const) {
          const rawValue = (candidate as Record<string, unknown>)[field];
          if (rawValue === undefined || rawValue === null || typeof rawValue !== 'object') continue;
          merged[field] = mergeHiddenSecrets(rawValue as Record<string, string>, (plain as Record<string, unknown>)[field] as
            | Record<string, string>
            | undefined);
        }

        const parsed = parseServerInput(merged, { existingNames: store.get().servers.map((s) => s.serverName) });
        if (parsed.errors.length > 0) {
          skipped.push({
            name,
            reason:
              '校验未通过：' +
              parsed.errors
                .slice(0, 3)
                .map((e) => e.path + ' ' + e.message)
                .join('；'),
          });
          continue;
        }
        try {
          await store.save((draft) => {
            if (draft.servers.some((s) => s.serverName === parsed.server.serverName)) {
              throw conflict('服务器名称「' + parsed.server.serverName + '」已存在。');
            }
            draft.servers.push(parsed.server);
          });
        } catch (error) {
          const hub = error as { code?: string; message?: string };
          skipped.push({ name, reason: hub.code === 'CONFLICT' ? '同名服务器已存在，已跳过。' : hub.message ?? '导入失败。' });
          continue;
        }
        imported.push(name);
        views.push(toView(name));
      }

      return { imported, skipped, servers: views, warnings: source.warnings };
    },

    'POST mcp/check-command': async (req) => {
      const body = asRecord(req.body);
      const command = requireString(body.command, 'command');
      const cwd = optionalString(body.cwd, 'cwd');
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
    env: Object.fromEntries(Object.keys(server.env).map((key) => [key, '***hidden***'])),
    headers: Object.fromEntries(Object.keys(server.headers).map((key) => [key, '***hidden***'])),
  };
}

export { mapServerFields };
