/**
 * mcp-runtime 集成测试：**真实 SDK + 真实 stdio MCP 服务器进程**。
 *
 * 与单测的分工：
 *   单测用内存假 SDK 验策略（时钟可推快、失败可注入）；
 *   这里用 @modelcontextprotocol/client v2 的真身 + 真子进程验「接得上、杀得掉、崩了会退避、超长会落盘」。
 *
 * 运行（必须用 Electron-as-node，因为 SDK 只存在于 app.asar 内，本机 Node 解析不到）：
 *   $env:ELECTRON_RUN_AS_NODE='1'
 *   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" test/mcp/runtime/integration/run-integration.mjs
 *
 * 环境变量（一般不用改）：
 *   T3B_NODE               子进程用的 node（默认先试 DSH_NODE，再试真正的 node，最后走 PATH）
 *   T3B_DSH_NODE_MODULES   app.asar 内的 node_modules 路径（默认由 %LOCALAPPDATA% 推导）
 *   DSH_INSTALL_DIR        DSH 安装目录（默认 %LOCALAPPDATA%\Programs\DeepSeek Harness）
 *
 * 退出码：0 = 全部通过；1 = 有失败；2 = 跳过（找不到 DSH 安装目录里的 SDK）。
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const FIXTURE = path.join(PKG_ROOT, 'test', 'mcp', 'runtime', 'fixtures', 'fake-mcp-server.mjs');
// 拉起的 MCP 服务器子进程需要一个**真正的 node**。本脚本自己跑在 Electron-as-node 下，
// 那里 process.execPath 是 Electron 可执行文件 —— 拿它去起子进程会被当成启动 GUI，必然连不上。
// 所以按「T3B_NODE → DSH_NODE → 真正的 execPath → PATH 上的 node」依次试，第一个能跑 --version 的胜出。
function resolveChildNode() {
  const candidates = [process.env.T3B_NODE, process.env.DSH_NODE].filter((item) => typeof item === 'string' && item !== '');
  if (path.basename(process.execPath).toLowerCase().replace(/\.exe$/, '') === 'node') candidates.push(process.execPath);
  candidates.push('node');
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
      return candidate;
    } catch {
      /* 试下一个 */
    }
  }
  return undefined;
}
const NODE = resolveChildNode();
if (NODE === undefined) {
  console.log('SKIP：找不到可用的 node（子进程要用它跑夹具 MCP 服务器）。');
  console.log('      用 T3B_NODE 指定 node.exe 的绝对路径，或把 node 加进 PATH 后重跑。');
  console.log('INTEGRATION-RESULT skip=1 pass=0 fail=0 leftover-processes=0');
  process.exit(2);
}
// DSH 安装目录：优先 T3B_DSH_NODE_MODULES，其次 DSH_INSTALL_DIR，最后按 %LOCALAPPDATA% 推导。
const LOCAL_APPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const DSH_INSTALL_DIR = process.env.DSH_INSTALL_DIR || path.join(LOCAL_APPDATA, 'Programs', 'DeepSeek Harness');
const DSH_NM = process.env.T3B_DSH_NODE_MODULES
  || path.join(DSH_INSTALL_DIR, 'resources', 'app.asar', 'dsh', 'node_modules');

// 找不到 DSH 就明确「跳过」，不当作失败：这是环境缺失，不是本模块的缺陷。
if (!fs.existsSync(path.join(DSH_NM, '@modelcontextprotocol', 'client', 'package.json'))) {
  console.log('SKIP：找不到 DSH 安装目录里的 MCP SDK。');
  console.log('      找过的路径：' + DSH_NM);
  console.log('      用 T3B_DSH_NODE_MODULES 指向 app.asar 内的 node_modules，或用 DSH_INSTALL_DIR 指向 DSH 安装目录后重跑。');
  console.log('INTEGRATION-RESULT skip=1 pass=0 fail=0 leftover-processes=0');
  process.exit(2);
}

// ---------------------------------------------------------------- 断言与汇总

const results = [];
const homes = [];
const runtimes = [];

function check(scenario, name, ok, detail) {
  results.push({ scenario, name, ok: Boolean(ok), detail });
  console.log((ok ? '  [PASS] ' : '  [FAIL] ') + name + (detail ? '  — ' + detail : ''));
}
function assertTrue(scenario, name, value, detail) {
  check(scenario, name, value === true, detail);
}
function assertMatch(scenario, name, text, pattern) {
  const ok = pattern.test(String(text));
  check(scenario, name, ok, ok ? undefined : '实际文本：' + JSON.stringify(String(text).slice(0, 300)));
}
function assertEqual(scenario, name, actual, expected) {
  check(scenario, name, actual === expected, 'actual=' + JSON.stringify(actual) + ' expected=' + JSON.stringify(expected));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('超时(' + ms + 'ms)：' + label)), ms)),
  ]);
}

// ---------------------------------------------------------------- 进程存活查询（与 supervisor 同口径）

/** pid 是否存活：process.kill(pid,0) + tasklist CSV 第二列精确匹配（两路互相印证）。 */
function probeAlive(pid) {
  let viaKill = true;
  try {
    process.kill(pid, 0);
  } catch {
    viaKill = false;
  }
  let tasklistLine = '';
  let viaTasklist = false;
  try {
    // tasklist 的「没有匹配的进程」提示是 GBK，按 utf8 解会变乱码 ⇒ 抓原始字节再按 gbk 解码，证据才可读。
    const raw = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH', '/FO', 'CSV'], { encoding: 'buffer' });
    let out;
    try {
      out = new TextDecoder('gbk').decode(raw);
    } catch {
      out = raw.toString('utf8');
    }
    const line = out.split(/\r?\n/).find((item) => item.trim().split(',')[1]?.replace(/"/g, '') === String(pid));
    if (line) {
      viaTasklist = true;
      tasklistLine = line.trim();
    } else {
      tasklistLine = (out.trim().split(/\r?\n/).filter((item) => item.trim().length > 0).pop() ?? '').trim();
    }
  } catch (err) {
    tasklistLine = 'tasklist 调用失败：' + err.message;
  }
  return { alive: viaKill || viaTasklist, viaKill, viaTasklist, tasklistLine };
}

async function waitForGone(pid, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!probeAlive(pid).alive) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

// ---------------------------------------------------------------- 运行时脚手架

const NM_ANCHOR = path.join(DSH_NM, 'noop.cjs');
const req = createRequire(NM_ANCHOR);
const sdk = {
  Client: req('@modelcontextprotocol/client').Client,
  StdioClientTransport: req('@modelcontextprotocol/client/stdio').StdioClientTransport,
  StreamableHTTPClientTransport: req('@modelcontextprotocol/client').StreamableHTTPClientTransport,
  getDefaultEnvironment: req('@modelcontextprotocol/client/stdio').getDefaultEnvironment,
};
console.log('真实 SDK：@modelcontextprotocol/client v' + JSON.parse(fs.readFileSync(path.join(DSH_NM, '@modelcontextprotocol', 'client', 'package.json'), 'utf8')).version);
console.log('子进程 node：' + NODE);
console.log('夹具服务器：' + FIXTURE);
console.log('');

const { createMcpRuntime } = await import(pathToFileURL(path.join(PKG_ROOT, 'src', 'mcp', 'runtime', 'runtime.ts')).href);
const { realClock } = await import(pathToFileURL(path.join(PKG_ROOT, 'src', 'mcp', 'runtime', 'atoms', 'clock.ts')).href);

/** 可推快的时钟：now() 带一个可调偏移，定时器仍走真实时间（真进程必须真等）。 */
function makeSkewedClock(offsetMs) {
  let offset = offsetMs;
  return {
    now: () => Date.now() + offset,
    setTimer: (fn, ms) => realClock.setTimer(fn, ms),
    clearTimer: (handle) => realClock.clearTimer(handle),
    bump: (ms) => {
      offset += ms;
    },
  };
}

async function makeHarness(options = {}) {
  const mode = options.mode ?? 'normal';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-capability-hub-integration-'));
  homes.push(home);
  const hubHome = path.join(home, 'storages', 'dsh-capability-hub');
  const pidPrefix = path.join(home, 'pids');
  const env = { FAKE_MCP_MODE: mode, FAKE_MCP_PID_FILE: pidPrefix };
  if (options.noGrandchild) env.FAKE_MCP_NO_GRANDCHILD = '1';
  const server = {
    serverName: 'fake',
    transport: 'stdio',
    command: NODE,
    args: [FIXTURE],
    env,
    envFrom: {},
    allowEmpty: [],
    envFromTimeoutMs: 10_000,
    headers: {},
    toolCallTimeoutMs: options.toolCallTimeoutMs ?? 30_000,
    lifecycle: options.lifecycle ?? 'lazy',
    idleTimeoutMin: options.idleTimeoutMin ?? 10,
    searchKeywords: {},
    disabled: false,
    debug: false,
  };
  const config = {
    get: () => ({
      settings: {
        idleTimeoutMin: options.idleTimeoutMin ?? 10,
        outputGuard: options.outputGuard ?? { enabled: true, maxBytes: 51200, maxLines: 2000 },
        failureBackoffMs: options.failureBackoffMs ?? 60_000,
      },
      servers: [server],
    }),
    onChange: () => () => undefined,
  };
  const ctx = {
    homeDir: home,
    dshHome: path.join(home, '.dsh'),
    hubHome,
    profileName: 'integration-test',
    customSkillDirs: [],
    logger: {
      debug: (...args) => console.log('    [runtime:debug]', ...args),
      info: () => undefined,
      warn: (...args) => console.log('    [runtime:warn]', ...args),
      error: (...args) => console.log('    [runtime:error]', ...args),
    },
  };
  const clock = options.clock ?? realClock;
  const runtime = createMcpRuntime({ ctx, config, sdk, clock });
  runtimes.push(runtime);
  return {
    home,
    hubHome,
    pidPrefix,
    runtime,
    clock,
    server,
    call: (args, sessionId = 'main') =>
      runtime.execute(args, { sessionId, signal: new AbortController().signal }),
    records: () => listPidRecords(home),
    cacheFile: () => path.join(hubHome, 'mcp', 'cache.json'),
    spillDir: () => path.join(hubHome, 'mcp', 'spill'),
  };
}

function listPidRecords(home) {
  return fs
    .readdirSync(home)
    .filter((name) => name.startsWith('pids.'))
    .map((name) => {
      const record = JSON.parse(fs.readFileSync(path.join(home, name), 'utf8'));
      return { ...record, file: name };
    });
}

/** 当前活着的会话实例（status 给出 pid），找到对应的 pid 记录（含孙进程）。 */
async function liveInstance(harness) {
  const status = await harness.runtime.status();
  const instance = status.sessions.flatMap((session) => session.instances)[0];
  if (!instance || typeof instance.pid !== 'number') return { instance: undefined, record: undefined };
  const record = harness.records().find((item) => item.serverPid === instance.pid);
  return { instance, record };
}

// ---------------------------------------------------------------- 场景

async function scenario1_realStdio() {
  const name = 'S1 真实 stdio 连接 → listTools（缓存）→ callTool';
  console.log(name);
  const h = await makeHarness();
  try {
    await withTimeout(h.runtime.start(), 30_000, 'start');
    await withTimeout(h.runtime.waitForBackgroundWork(), 60_000, '启动探测');

    const connectText = await withTimeout(h.call({ connect: 'fake' }), 60_000, 'connect');
    assertMatch(name, 'connect 返回「已连接」与工具数', connectText, /已连接服务器 "fake" 并刷新了它的工具清单：4 个工具/);

    const cache = JSON.parse(fs.readFileSync(h.cacheFile(), 'utf8'));
    assertTrue(name, 'cache.json 里落下了 4 个工具（真实 listTools 的结果）',
      cache.servers?.fake?.tools?.length === 4, 'tools=' + JSON.stringify((cache.servers?.fake?.tools ?? []).map((tool) => tool.name)));
    assertMatch(name, 'cache.json 里落下了 instructions', JSON.stringify(cache.servers?.fake?.instructions ?? ''), /假服务器的用法说明/);

    const searchText = await withTimeout(h.call({ search: 'echo' }), 20_000, 'search');
    assertMatch(name, 'search 命中 fake__echo', searchText, /fake__echo/);

    const describeText = await withTimeout(h.call({ describe: 'fake__echo' }), 20_000, 'describe');
    assertMatch(name, 'describe 给出参数摘要', describeText, /parameters: text: string/);

    const callText = await withTimeout(h.call({ tool: 'echo', args: { text: 'hello' } }), 30_000, 'callTool');
    assertEqual(name, 'callTool 往返（echo:hello）', callText.trim(), 'echo:hello');

    const { instance, record } = await liveInstance(h);
    assertTrue(name, 'status 暴露真实 pid', typeof instance?.pid === 'number' && instance.pid > 0, 'pid=' + instance?.pid);
    assertTrue(name, 'status 状态为 ready', instance?.state === 'ready', 'state=' + instance?.state);
    assertTrue(name, 'pid 记录里有对应的孙进程', typeof record?.grandchildPid === 'number' && record.grandchildPid > 0,
      'serverPid=' + record?.serverPid + ' grandchildPid=' + record?.grandchildPid);
  } finally {
    await h.runtime.dispose();
  }
}

async function scenario2_readonlyNoSpawn() {
  const name = 'S2 search / describe / status / instructions 绝不产生新进程（真实进程计数）';
  console.log(name);
  const h = await makeHarness();
  try {
    await h.runtime.start();
    await h.runtime.waitForBackgroundWork();
    await h.call({ connect: 'fake' });
    const before = h.records().length;
    await h.call({ search: 'echo' });
    await h.call({ describe: 'fake__echo' });
    await h.call({ instructions: 'fake' });
    await h.call({});
    const after = h.records().length;
    assertEqual(name, '会话内 pid 记录数不变（没有新进程）', after, before);
    assertTrue(name, '确实已有进程被起过（否则这条断言没意义）', before >= 1, 'before=' + before);
  } finally {
    await h.runtime.dispose();
  }
}

async function scenario3_sessionEnded() {
  const name = 'S3 sessionEnded ⇒ 子进程与孙进程都不存在';
  console.log(name);
  const h = await makeHarness();
  let evidence = '';
  try {
    await h.runtime.start();
    await h.runtime.waitForBackgroundWork();
    await h.call({ connect: 'fake' });
    await h.call({ tool: 'echo', args: { text: 'bye' } });

    const { instance, record } = await liveInstance(h);
    assertTrue(name, '拿到活的服务器 pid', typeof instance?.pid === 'number', 'pid=' + instance?.pid);
    assertTrue(name, '拿到孙进程 pid', typeof record?.grandchildPid === 'number', 'grandchildPid=' + record?.grandchildPid);
    const serverPid = instance.pid;
    const grandchildPid = record.grandchildPid;
    const beforeServer = probeAlive(serverPid);
    const beforeGrand = probeAlive(grandchildPid);
    assertTrue(name, '回收前：服务器进程存活', beforeServer.alive, 'tasklist: ' + beforeServer.tasklistLine);
    assertTrue(name, '回收前：孙进程存活', beforeGrand.alive, 'tasklist: ' + beforeGrand.tasklistLine);

    await withTimeout(h.runtime.sessionEnded('main'), 30_000, 'sessionEnded');
    await waitForGone(serverPid);
    await waitForGone(grandchildPid);
    const afterServer = probeAlive(serverPid);
    const afterGrand = probeAlive(grandchildPid);
    assertTrue(name, '回收后：服务器进程已不存在', !afterServer.alive, 'pid=' + serverPid + ' tasklist: ' + afterServer.tasklistLine);
    assertTrue(name, '回收后：孙进程已不存在', !afterGrand.alive, 'pid=' + grandchildPid + ' tasklist: ' + afterGrand.tasklistLine);
    const status = await h.runtime.status();
    assertEqual(name, 'status 里该会话已无实例', status.sessions.length, 0);
    evidence = 'serverPid=' + serverPid + ' grandchildPid=' + grandchildPid
      + ' | 回收前 tasklist(服务器)=' + beforeServer.tasklistLine
      + ' | 回收前 tasklist(孙)=' + beforeGrand.tasklistLine
      + ' | 回收后 tasklist(服务器)=' + afterServer.tasklistLine
      + ' | 回收后 tasklist(孙)=' + afterGrand.tasklistLine;
    console.log('  pid 证据：' + evidence);
  } finally {
    await h.runtime.dispose();
  }
  return evidence;
}

async function scenario4_crashBackoff() {
  const name = 'S4 服务器崩溃 ⇒ 进入退避冷却';
  console.log(name);
  const h = await makeHarness({ mode: 'crash-on-call' });
  try {
    await h.runtime.start();
    await h.runtime.waitForBackgroundWork();
    await h.call({ connect: 'fake' });
    const { instance, record } = await liveInstance(h);
    const serverPid = instance.pid;
    const crashedGrandchild = record.grandchildPid;

    const crashText = await withTimeout(h.call({ tool: 'boom' }), 60_000, '崩溃调用');
    assertMatch(name, '崩溃的调用返回失败说明', crashText, /失败/);
    assertMatch(name, '失败说明里带冷却', crashText, /冷却/);
    assertTrue(name, '崩溃后服务器进程确实没了', await waitForGone(serverPid), 'pid=' + serverPid + ' tasklist: ' + probeAlive(serverPid).tasklistLine);
    assertTrue(name, '崩溃后崩溃进程的孙进程也没了', await waitForGone(crashedGrandchild), 'pid=' + crashedGrandchild);

    const second = await withTimeout(h.call({ tool: 'boom' }), 20_000, '冷却期内再调');
    assertMatch(name, '冷却期内的调用直接返回剩余时间', second, /冷却还剩 \d+ 秒/);

    const status = await h.runtime.status();
    assertTrue(name, 'status 暴露 lastFailure', Boolean(status.servers[0]?.lastFailure), JSON.stringify(status.servers[0]?.lastFailure ?? null));
  } finally {
    await h.runtime.dispose();
  }
}

async function scenario5_hugeSpill() {
  const name = 'S5 超大输出 ⇒ 截断 + spill 到文件';
  console.log(name);
  const h = await makeHarness();
  try {
    await h.runtime.start();
    await h.runtime.waitForBackgroundWork();
    await h.call({ connect: 'fake' });

    const text = await withTimeout(h.call({ tool: 'huge', args: { kilobytes: 300 } }), 60_000, 'huge 调用');
    assertMatch(name, '结果被截断并告知 spill 路径', text, /完整内容已保存到：/);
    const matched = /完整内容已保存到：(.+?)（/.exec(text);
    const spillPath = matched ? matched[1] : '';
    assertTrue(name, 'spill 路径落在 hubHome\\mcp\\spill 下', spillPath.startsWith(h.spillDir()), spillPath);
    assertTrue(name, 'spill 文件存在', fs.existsSync(spillPath), spillPath);
    if (fs.existsSync(spillPath)) {
      const content = fs.readFileSync(spillPath, 'utf8');
      assertTrue(name, 'spill 文件里是完整内容（含 HUGE-BEGIN/HUGE-END）', content.includes('HUGE-BEGIN') && content.includes('HUGE-END'),
        'size=' + content.length + ' 字符');
      assertTrue(name, 'spill 文件确实超过护栏上限（50KiB）', Buffer.byteLength(content, 'utf8') > 300 * 1024, Buffer.byteLength(content, 'utf8') + ' bytes');
    }
    assertTrue(name, '返回给模型的部分被压到护栏上限附近', Buffer.byteLength(text, 'utf8') < 60 * 1024, Buffer.byteLength(text, 'utf8') + ' bytes');
  } finally {
    await h.runtime.dispose();
  }
}

async function scenario6_inFlightProtection() {
  const name = 'S6 真实慢调用进行中 ⇒ 巡检绝不回收（inFlight>0）';
  console.log(name);
  const clock = makeSkewedClock(0);
  const h = await makeHarness({ clock });
  try {
    await h.runtime.start();
    await h.runtime.waitForBackgroundWork();
    await h.call({ connect: 'fake' });
    const { instance } = await liveInstance(h);
    const serverPid = instance.pid;

    const calling = h.call({ tool: 'slow', args: { ms: 1800 } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    clock.bump(11 * 60_000); // 空转窗口（10 分钟）已经过去 ⇒ 没有 inFlight 保护就会被回收
    const swept = await h.runtime.sweepOnce();
    assertEqual(name, '调用进行中巡检回收数 = 0', swept, 0);
    assertTrue(name, '调用进行中服务器进程仍存活', probeAlive(serverPid).alive, 'pid=' + serverPid);

    const slowText = await withTimeout(calling, 30_000, 'slow 调用');
    assertEqual(name, '慢调用最终正常返回', slowText.trim(), 'slow:done');

    clock.bump(11 * 60_000);
    const sweptAfter = await h.runtime.sweepOnce();
    assertEqual(name, '调用结束后同样的空转窗口内巡检回收数 = 1', sweptAfter, 1);
    assertTrue(name, '被回收后服务器进程消失', await waitForGone(serverPid), 'pid=' + serverPid);
  } finally {
    await h.runtime.dispose();
  }
}

// ---------------------------------------------------------------- 主流程

const scenarios = [
  scenario1_realStdio,
  scenario2_readonlyNoSpawn,
  scenario3_sessionEnded,
  scenario4_crashBackoff,
  scenario5_hugeSpill,
  scenario6_inFlightProtection,
];

const pidEvidence = [];
for (const scenario of scenarios) {
  try {
    const evidence = await scenario();
    if (evidence) pidEvidence.push(evidence);
  } catch (err) {
    check(scenario.name, '场景自身未抛异常', false, err && err.stack ? err.stack : String(err));
  }
  console.log('');
}

// 清理：关掉运行时、杀掉所有记录里的残留进程、删掉临时目录。
for (const runtime of runtimes) {
  await runtime.dispose().catch(() => undefined);
}
let leftover = 0;
for (const home of homes) {
  for (const record of listPidRecords(home)) {
    for (const pid of [record.grandchildPid, record.serverPid]) {
      if (typeof pid !== 'number' || !probeAlive(pid).alive) continue;
      try {
        // stderr 丢掉：进程可能刚好在自己退出，taskkill 会打「没有找到进程」，那是噪音不是失败。
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'ignore', 'ignore'] });
      } catch {
        /* 已经没了 */
      }
      // 只有「杀完还在」才算残留（进程处于退出过程中时会短暂可见）。
      if (!(await waitForGone(pid, 3000))) {
        leftover += 1;
        console.log('  [WARN] 清理后仍存活：pid=' + pid);
      }
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
}

const passed = results.filter((item) => item.ok).length;
const failed = results.filter((item) => !item.ok);
if (failed.length > 0) {
  console.log('失败明细：');
  for (const item of failed) console.log('  - [' + item.scenario + '] ' + item.name + (item.detail ? ' :: ' + item.detail : ''));
}
if (pidEvidence.length > 0) {
  console.log('孙进程回收证据：');
  for (const line of pidEvidence) console.log('  - ' + line);
}
console.log('INTEGRATION-RESULT pass=' + passed + ' fail=' + failed.length + ' leftover-processes=' + leftover);
process.exitCode = failed.length === 0 ? 0 : 1;
