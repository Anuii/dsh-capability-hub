#!/usr/bin/env node
/**
 * 假 MCP 服务器：**真进程、真 stdio JSON-RPC**（换行分隔的 JSON-RPC 2.0）。
 *
 * 它存在的唯一目的是让集成测试走一条与生产完全相同的路径：
 *   我们的运行时 → @modelcontextprotocol/client 的 StdioClientTransport → 这个进程。
 * 单测里的内存假 SDK 覆盖不到的东西（真 spawn、真握手、真 pid、真进程树）都在这里验。
 *
 * 环境变量：
 *   FAKE_MCP_MODE             normal（默认）| crash-on-call（调用 boom 时直接退出）
 *   FAKE_MCP_PID_FILE         把 {serverPid, grandchildPid} 写到 <值>.<pid>.json
 *   FAKE_MCP_NO_GRANDCHILD    '1' ⇒ 不派生孙进程
 *
 * 工具：
 *   echo   { text }            回显（验证 callTool 的正常往返）
 *   slow   { ms }              延迟 ms 后返回（验证慢调用期间的 inFlight 保护）
 *   huge   { kilobytes }       返回指定大小的文本（默认 300KiB，验证输出护栏 + spill）
 *   boom                       正常模式返回 isError；crash-on-call 模式直接杀死自己（验证退避）
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const MODE = process.env.FAKE_MCP_MODE ?? 'normal';
const PID_FILE = process.env.FAKE_MCP_PID_FILE;
const WANT_GRANDCHILD = process.env.FAKE_MCP_NO_GRANDCHILD !== '1';

/** 孙进程：模拟 `npx <pkg>` 那一层（SDK 的 close() 杀不到它，只有进程树终止能收）。 */
let grandchildPid;
if (WANT_GRANDCHILD) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  grandchildPid = child.pid;
  child.unref();
}

if (PID_FILE) {
  try {
    writeFileSync(PID_FILE + '.' + process.pid + '.json', JSON.stringify({ serverPid: process.pid, grandchildPid, mode: MODE }));
  } catch {
    /* pid 文件只是给测试看的，写不了也不影响协议 */
  }
}

const TOOLS = [
  { name: 'echo', description: '回显给定的文本。', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'slow', description: '等待 ms 毫秒后返回。', inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] } },
  { name: 'huge', description: '返回一大段文本。', inputSchema: { type: 'object', properties: { kilobytes: { type: 'number' } } } },
  { name: 'boom', description: '总是出错（或让进程崩掉）。', inputSchema: { type: 'object', properties: {} } },
];

const send = (message) => {
  process.stdout.write(JSON.stringify(message) + '\n');
};
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const text = (value) => ({ content: [{ type: 'text', text: value }] });

async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments ?? {};
  if (name === 'echo') return ok(id, text('echo:' + String(args.text ?? '')));
  if (name === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, Number(args.ms ?? 100)));
    return ok(id, text('slow:done'));
  }
  if (name === 'huge') {
    const kilobytes = Number(args.kilobytes ?? 300);
    return ok(id, text('HUGE-BEGIN\n' + 'x'.repeat(Math.max(1, Math.round(kilobytes * 1024))) + '\nHUGE-END'));
  }
  if (name === 'boom') {
    if (MODE === 'crash-on-call') {
      // 先让请求真的在飞行中，再「崩溃」——这正是退避要覆盖的场景。
      setTimeout(() => process.exit(3), 5);
      return;
    }
    return ok(id, { content: [{ type: 'text', text: '服务器内部错误' }], isError: true });
  }
  return fail(id, -32602, '未知工具：' + String(name));
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === undefined) return; // 响应，不是请求
  if (id === undefined) return; // 通知：initialized / cancelled 等，一律不回应
  switch (method) {
    case 'initialize':
      // 协议版本按客户端的提议回，模拟真实的版本协商。
      ok(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fake-mcp-server', version: '1.0.0' },
        instructions: '这是假服务器的用法说明：先 echo，再 huge。',
      });
      return;
    case 'ping':
      ok(id, {});
      return;
    case 'tools/list':
      ok(id, { tools: TOOLS });
      return;
    case 'tools/call':
      void handleToolCall(id, params);
      return;
    case 'resources/list':
      ok(id, { resources: [] });
      return;
    case 'prompts/list':
      ok(id, { prompts: [] });
      return;
    default:
      fail(id, -32601, '未实现的方法：' + method);
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
