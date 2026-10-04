/**
 * intake.ts：parse-json 各格式、presets、Claude Code / Codex 只读导入、遮罩。
 * 全部使用临时 homeDir 自建夹具（PLAN §4）。
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { HIDDEN } from '../../src/host/mcp-config/mask.ts';
import { listImportSources, listPresets, parseMcpJson } from '../../src/host/mcp-config/intake.ts';
import { makeTempDir } from './helpers.ts';

let tomlAvailable = false;
try {
  const mod: unknown = await import('smol-toml');
  tomlAvailable = typeof (mod as { parse?: unknown }).parse === 'function';
} catch {
  tomlAvailable = false;
}

describe('intake: parse-json', () => {
  it('识别 { "mcpServers": { ... } }', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { demo: { command: 'uvx', args: ['mcp-server-fetch'] } } }));
    assert.deepEqual(result.warnings, []);
    assert.equal(result.servers.length, 1);
    assert.deepEqual(result.servers[0], {
      serverName: 'demo',
      transport: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch'],
    });
  });

  it('识别 { "servers": { ... } } 与名称→对象映射', () => {
    const viaServers = parseMcpJson(JSON.stringify({ servers: { a: { command: 'node' } } }));
    assert.deepEqual(viaServers.servers.map((s) => s.serverName), ['a']);
    const viaMap = parseMcpJson(JSON.stringify({ a: { command: 'node' }, b: { command: 'node' } }));
    assert.deepEqual(viaMap.servers.map((s) => s.serverName), ['a', 'b']);
  });

  it('识别单个服务器对象', () => {
    const result = parseMcpJson(JSON.stringify({ serverName: 'solo', transport: 'stdio', command: 'node', args: ['x'] }));
    assert.equal(result.servers.length, 1);
    assert.deepEqual(result.servers[0], { serverName: 'solo', transport: 'stdio', command: 'node', args: ['x'] });
  });

  it('type: http 映射为 streamable-http，type: sse 给警告', () => {
    const http = parseMcpJson(JSON.stringify({ mcpServers: { r: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'x' } } } }));
    assert.equal(http.servers[0].transport, 'streamable-http');
    assert.deepEqual(http.servers[0].headers, { Authorization: 'x' });

    const sse = parseMcpJson(JSON.stringify({ mcpServers: { r: { type: 'sse', url: 'https://example.com/sse' } } }));
    assert.equal(sse.servers[0].transport, 'streamable-http');
    assert.equal(sse.warnings.some((w) => w.includes('不支持 SSE，可尝试 streamable-http')), true);
  });

  it('未知字段给警告但不报错（导入路径宽容）', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { a: { command: 'node', reconnect: true } } }));
    assert.equal(result.servers.length, 1);
    assert.equal(result.warnings.some((w) => w.includes('reconnect')), true);
  });

  it('非法 JSON 与空输入返回 warnings', () => {
    assert.match(parseMcpJson('{ 坏').warnings[0], /JSON 解析失败/);
    assert.equal(parseMcpJson('').warnings.length, 1);
    assert.equal(parseMcpJson('123').warnings.length >= 1, true);
  });

  it('不合法名称给出可操作警告', () => {
    const result = parseMcpJson(JSON.stringify({ mcpServers: { '中文名': { command: 'node' } } }));
    assert.equal(result.warnings.some((w) => w.includes('不合法')), true);
  });
});

describe('intake: presets', () => {
  it('5 个预设模板，字段完整且能被校验接受', () => {
    const presets = listPresets();
    assert.deepEqual(presets.map((p) => p.id), ['fetch', 'time', 'memory', 'sequential-thinking', 'context7']);
    for (const preset of presets) {
      assert.equal(typeof preset.title, 'string');
      assert.ok(preset.title.length > 0);
      assert.equal(typeof preset.description, 'string');
      assert.equal(preset.server.transport, 'stdio');
      assert.equal(typeof preset.server.command, 'string');
      assert.equal(preset.server.lifecycle, 'lazy');
    }
    assert.deepEqual(presets[0].server.args, ['mcp-server-fetch']);
    assert.deepEqual(presets[2].server.args, ['-y', '@modelcontextprotocol/server-memory']);
    assert.deepEqual(presets[4].server.args, ['-y', '@upstash/context7-mcp']);
  });
});

describe('intake: Claude Code 导入', () => {
  it('顶层 mcpServers 与 projects 都能识别，并标注来源项目', async () => {
    const dir = await makeTempDir();
    try {
      const home = dir.path;
      await fs.writeFile(
        join(home, '.claude.json'),
        JSON.stringify({
          mcpServers: { global1: { command: 'node', args: ['a'], env: { TOKEN: 'sk-secret' } } },
          projects: {
            'C:/work/proj': { mcpServers: { proj1: { type: 'stdio', command: 'uvx', args: ['mcp-server-time'] } } },
          },
        }),
        'utf8',
      );
      const sources = await listImportSources({ homeDir: home });
      const claude = sources.find((s) => s.id === 'claude-code');
      assert.ok(claude);
      assert.equal(claude.found, true);
      assert.equal(claude.path, join(home, '.claude.json'));
      assert.deepEqual(claude.servers.map((s) => s.serverName), ['global1', 'proj1']);
      assert.equal(claude.origins.proj1, 'C:/work/proj');
      assert.equal(claude.origins.global1, '全局');
      // 遮罩：结果里没有明文
      assert.deepEqual(claude.servers[0].env, { TOKEN: HIDDEN });
      assert.equal(JSON.stringify(claude).includes('sk-secret'), false);
      const codex = sources.find((s) => s.id === 'codex');
      assert.equal(codex?.found, false);
    } finally {
      await dir.cleanup();
    }
  });

  it('文件不存在时 found=false', async () => {
    const dir = await makeTempDir();
    try {
      const sources = await listImportSources({ homeDir: dir.path });
      for (const source of sources) {
        assert.equal(source.found, false);
        assert.deepEqual(source.servers, []);
      }
    } finally {
      await dir.cleanup();
    }
  });

  it('llm 格式的 sse 类型给出警告', async () => {
    const dir = await makeTempDir();
    try {
      await fs.writeFile(
        join(dir.path, '.claude.json'),
        JSON.stringify({ mcpServers: { remote: { type: 'sse', url: 'https://example.com/sse' } } }),
        'utf8',
      );
      const sources = await listImportSources({ homeDir: dir.path });
      const claude = sources.find((s) => s.id === 'claude-code');
      assert.equal(claude?.servers[0].transport, 'streamable-http');
      assert.equal(claude?.warnings.some((w) => w.includes('不支持 SSE')), true);
    } finally {
      await dir.cleanup();
    }
  });
});

describe('intake: Codex 导入', () => {
  it('解析 [mcp_servers.*]（含 env 子表、http_headers、超时与 enabled）', async (t) => {
    if (!tomlAvailable) {
      t.skip('smol-toml 未安装，跳过 Codex TOML 解析用例');
      return;
    }
    const dir = await makeTempDir();
    try {
      const codexDir = join(dir.path, '.codex');
      await fs.mkdir(codexDir, { recursive: true });
      await fs.writeFile(
        join(codexDir, 'config.toml'),
        [
          '[mcp_servers.local]',
          'command = "npx"',
          'args = ["-y", "@modelcontextprotocol/server-memory"]',
          'cwd = "C:/work"',
          'startup_timeout_sec = 20',
          'tool_timeout_sec = 12.5',
          '',
          '[mcp_servers.local.env]',
          'TOKEN = "sk-toml-secret"',
          '',
          '[mcp_servers.remote]',
          'url = "https://example.com/mcp"',
          'enabled = false',
          'bearer_token_env_var = "MCP_TOKEN"',
          '',
          '[mcp_servers.remote.http_headers]',
          'Authorization = "Bearer abc"',
          '',
          '[mcp_servers.bad]',
          'args = ["x"]',
          '',
        ].join('\n'),
        'utf8',
      );
      const sources = await listImportSources({ homeDir: dir.path });
      const codex = sources.find((s) => s.id === 'codex');
      assert.ok(codex);
      assert.equal(codex.found, true);
      assert.equal(codex.path, join(codexDir, 'config.toml'));
      const local = codex.servers.find((s) => s.serverName === 'local');
      assert.equal(local?.command, 'npx');
      assert.deepEqual(local?.args, ['-y', '@modelcontextprotocol/server-memory']);
      assert.equal(local?.cwd, 'C:/work');
      assert.equal(local?.toolCallTimeoutMs, 12500);
      assert.deepEqual(local?.env, { TOKEN: HIDDEN });
      assert.equal(codex.warnings.some((w) => w.includes('startup_timeout_sec')), true);
      const remote = codex.servers.find((s) => s.serverName === 'remote');
      assert.equal(remote?.transport, 'streamable-http');
      assert.equal(remote?.disabled, true);
      assert.deepEqual(remote?.headers, { Authorization: HIDDEN });
      assert.equal(codex.warnings.some((w) => w.includes('bearer_token_env_var')), true);
      assert.equal(codex.warnings.some((w) => w.includes('缺少 command')), true);
      // 明文不进结果
      assert.equal(JSON.stringify(codex).includes('sk-toml-secret'), false);
      assert.equal(JSON.stringify(codex).includes('Bearer abc'), false);
    } finally {
      await dir.cleanup();
    }
  });

  it('未知字段忽略并给警告', async (t) => {
    if (!tomlAvailable) {
      t.skip('smol-toml 未安装，跳过 Codex TOML 解析用例');
      return;
    }
    const dir = await makeTempDir();
    try {
      const codexDir = join(dir.path, '.codex');
      await fs.mkdir(codexDir, { recursive: true });
      await fs.writeFile(
        join(codexDir, 'config.toml'),
        '[mcp_servers.local]\ncommand = "node"\nsomething_new = 1\n',
        'utf8',
      );
      const sources = await listImportSources({ homeDir: dir.path });
      const codex = sources.find((s) => s.id === 'codex');
      assert.equal(codex?.warnings.some((w) => w.includes('something_new')), true);
    } finally {
      await dir.cleanup();
    }
  });
});
