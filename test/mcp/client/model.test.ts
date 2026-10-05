/**
 * model.ts 的纯逻辑单测（不碰 DOM / React / 网络）。
 *
 * 覆盖：草稿与默认值（D-C1）、遮罩值往返（D-C5）、JSON 互转（D-C3）、
 * 校验镜像与错误路径映射、排序、全局设置。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compactSummaryText, isPathLike, shortPart } from "../../../src/mcp/client/model.ts";
import {
  HIDDEN_VALUE,
  SERVER_FIELD_ORDER,
  activeInstanceCount,
  cacheLineText,
  cachedToolNames,
  cooldownRemainingMs,
  cooldownText,
  formatClock,
  formatDuration,
  matchesFilter,
  matchesQuery,
  rowSubtitleText,
  runtimeIndex,
  draftFromValues,
  draftFromView,
  draftHas,
  draftToJsonText,
  draftToSubmit,
  emptyServerDraft,
  fieldOfPath,
  formatTimestamp,
  groupErrors,
  isHttpUrl,
  lifecycleLabel,
  parseJsonServer,
  reorderNames,
  serverFilterCounts,
  serverStatusTone,
  serverSummaryText,
  settingsDraftFrom,
  statusTitle,
  settingsHas,
  settingsToSubmit,
  validateDraft,
  validateSettingsDraft,
  viewSummaryText,
  visibleServers,
  withField,
  withMetaField,
  withoutField,
} from "../../../src/mcp/client/model.ts";
import { makeServerView } from "./fixtures.ts";

test("draftFromView 用 idleTimeoutMin 还原被设置的 idleTimeout", () => {
  const view = makeServerView({ setFields: ["serverName", "transport", "command", "idleTimeout"], idleTimeoutMin: 3 });
  assert.equal(draftFromView(view).values.idleTimeout, 3);
});

test("withField：空值 / false / 空数组 / 空对象都等于恢复默认（删键）", () => {
  const base = emptyServerDraft();
  assert.equal(Object.prototype.hasOwnProperty.call(withField(base, "args", []).values, "args"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(withField(base, "env", {}).values, "env"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(withField(base, "disabled", false).values, "disabled"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(withField(base, "debug", true).values, "debug"), true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(withoutField(withField(base, "debug", true), "debug").values, "debug"),
    false,
  );
  assert.equal(Object.prototype.hasOwnProperty.call(withField(base, "cwd", "  ").values, "cwd"), false);
});

test("draftToSubmit：数值字段转数字、serverName 去空白、只带显式字段", () => {
  let draft = emptyServerDraft();
  draft = withField(draft, "serverName", "  demo  ");
  draft = withField(draft, "command", "node");
  draft = withField(draft, "idleTimeout", "5");
  draft = withField(draft, "toolCallTimeoutMs", "0");
  const submit = draftToSubmit(draft);
  assert.deepEqual(submit, {
    serverName: "demo",
    transport: "stdio",
    command: "node",
    idleTimeout: 5,
    toolCallTimeoutMs: 0,
  });
  assert.equal(Object.keys(submit).includes("lifecycle"), false);
});

test("draftToSubmit 按传输方式裁剪，但草稿本身保留（切换传输不丢值）", () => {
  let draft = emptyServerDraft("stdio");
  draft = withField(draft, "serverName", "a");
  draft = withField(draft, "command", "node");
  draft = withField(draft, "url", "https://example.com/mcp");
  assert.deepEqual(draftToSubmit(draft), { serverName: "a", transport: "stdio", command: "node" });
  const http = withField(draft, "transport", "streamable-http");
  assert.deepEqual(draftToSubmit(http), {
    serverName: "a",
    transport: "streamable-http",
    url: "https://example.com/mcp",
  });
  assert.equal(draftHas(http, "command"), true, "草稿里仍然留着 command，切回 stdio 还在");
});

test("遮罩值原样往返（D-C5）", () => {
  const view = makeServerView({
    setFields: ["serverName", "transport", "command", "env"],
    env: { TOKEN: HIDDEN_VALUE },
  });
  const submit = draftToSubmit(draftFromView(view));
  assert.deepEqual(submit.env, { TOKEN: HIDDEN_VALUE });
});

test("withMetaField 写子字段，空值把 meta 整个删掉", () => {
  let draft = withMetaField(emptyServerDraft(), "description", "示例");
  draft = withMetaField(draft, "tags", ["a", "b"]);
  assert.deepEqual(draft.values.meta, { description: "示例", tags: ["a", "b"] });
  assert.equal(draftHas(withMetaField(draft, "description", ""), "meta"), true);
  const cleared = withoutField(draft, "meta");
  assert.equal(draftHas(cleared, "meta"), false);
});

/* ---------------- JSON 互转（D-C3） ---------------- */

test("draftToJsonText 按字段顺序输出，parseJsonServer 能解析回来", () => {
  const view = makeServerView({
    setFields: ["serverName", "transport", "command", "args", "env", "idleTimeout"],
    args: ["-y", "pkg"],
    env: { TOKEN: HIDDEN_VALUE },
    idleTimeoutMin: 4,
  });
  const text = draftToJsonText(draftFromView(view));
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["serverName", "transport", "command", "args", "env", "idleTimeout"]);
  assert.equal(parsed.idleTimeout, 4);
  const back = parseJsonServer(text);
  assert.notEqual(back.draft, undefined);
  assert.deepEqual(draftToSubmit(back.draft!), parsed);
});

test("parseJsonServer：非法 JSON 与非对象都给出中文错误", () => {
  assert.notEqual(parseJsonServer("{").error, undefined);
  assert.notEqual(parseJsonServer("[1,2]").error, undefined);
  const ok = parseJsonServer('{"serverName":"a","transport":"stdio","command":"node","unknownField":1}');
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.values, { transport: "stdio", serverName: "a", command: "node", unknownField: 1 });
  // 未知字段不会进草稿（白名单），但会留在 values 里交给服务端裁决
  assert.equal(draftHas(ok.draft!, "unknownField"), false);
});

/* ---------------- 校验 ---------------- */

test("validateDraft：serverName 非法 / 重名", () => {
  const bad = withField(emptyServerDraft(), "serverName", "has space");
  const errors = validateDraft(bad, { existingNames: [] });
  assert.deepEqual(
    errors.map((e) => e.path),
    ["server.serverName", "server.command"],
  );
  const dup = validateDraft(withField(withField(emptyServerDraft(), "serverName", "demo"), "command", "node"), {
    existingNames: ["demo"],
  });
  assert.equal(dup[0].path, "server.serverName");
  const renamed = validateDraft(withField(withField(emptyServerDraft(), "serverName", "demo"), "command", "node"), {
    existingNames: ["demo"],
    originalName: "demo",
  });
  assert.deepEqual(renamed, []);
});

test("validateDraft：http 传输的 url 必须是 http/https", () => {
  const http = withField(emptyServerDraft("streamable-http"), "serverName", "web");
  const missing = validateDraft(withField(http, "url", ""), {});
  assert.deepEqual(
    missing.map((e) => e.path),
    ["server.url"],
  );
  const bad = validateDraft(withField(http, "url", "ftp://x"), {});
  assert.equal(bad[0].path, "server.url");
  const bad2 = validateDraft(withField(http, "url", "例子.com"), {});
  assert.equal(bad2[0].path, "server.url");
  assert.deepEqual(validateDraft(withField(http, "url", "https://example.com/mcp"), {}), []);
  assert.equal(isHttpUrl("http://127.0.0.1:8080/mcp"), true);
});

test("validateDraft：数值字段必须是非负整数", () => {
  const base = withField(withField(emptyServerDraft(), "serverName", "a"), "command", "node");
  assert.equal(validateDraft(withField(base, "idleTimeout", "abc"), {})[0].path, "server.idleTimeout");
  assert.equal(validateDraft(withField(base, "idleTimeout", "-1"), {})[0].path, "server.idleTimeout");
  assert.equal(validateDraft(withField(base, "idleTimeout", "1.5"), {})[0].path, "server.idleTimeout");
  assert.deepEqual(validateDraft(withField(base, "idleTimeout", "0"), {}), []);
  assert.deepEqual(validateDraft(withField(base, "toolCallTimeoutMs", "-100"), {}), []);
  assert.equal(validateDraft(withField(base, "toolCallTimeoutMs", "x"), {})[0].path, "server.toolCallTimeoutMs");
});

test("validateDraft：envFrom / allowEmpty / env 冲突 / 非 stdio", () => {
  const base = withField(withField(emptyServerDraft(), "serverName", "a"), "command", "node");
  const overlap = withField(withField(base, "env", { TOKEN: "x" }), "envFrom", { TOKEN: "echo 1" });
  assert.equal(
    validateDraft(overlap, {}).some((e) => e.path === "server.envFrom.TOKEN"),
    true,
  );
  const badName = withField(base, "envFrom", { "1BAD": "echo 1" });
  assert.equal(
    validateDraft(badName, {}).some((e) => e.path.startsWith("server.envFrom")),
    true,
  );
  const allowEmpty = withField(base, "allowEmpty", ["NOPE"]);
  assert.equal(
    validateDraft(allowEmpty, {}).some((e) => e.path.startsWith("server.allowEmpty")),
    true,
  );
  const withEnvFrom = withField(allowEmpty, "envFrom", { NOPE: "echo 1" });
  assert.deepEqual(validateDraft(withEnvFrom, {}), []);
  const http = withField(withField(emptyServerDraft("streamable-http"), "serverName", "w"), "envFrom", { A: "echo" });
  assert.equal(
    validateDraft(withField(http, "url", "https://x"), {}).some((e) => e.path === "server.envFrom"),
    true,
  );
});

test("validateDraft：searchKeywords / meta.tags 形状", () => {
  const base = withField(withField(emptyServerDraft(), "serverName", "a"), "command", "node");
  assert.equal(validateDraft(withField(base, "searchKeywords", { echo: ["回显"] }), {}).length, 0);
  assert.equal(
    validateDraft(withField(base, "searchKeywords", { echo: "not-a-list" }), {}).some((e) =>
      e.path.startsWith("server.searchKeywords"),
    ),
    true,
  );
  assert.equal(
    validateDraft(withField(base, "meta", { tags: ["ok", ""] }), {}).some((e) => e.path === "server.meta.tags"),
    true,
  );
});

/* ---------------- 错误路径映射 ---------------- */

test("fieldOfPath 把服务端路径映射回表单字段", () => {
  assert.equal(fieldOfPath("server.serverName"), "serverName");
  assert.equal(fieldOfPath("server.args[0]"), "args");
  assert.equal(fieldOfPath("server.env.TOKEN"), "env");
  assert.equal(fieldOfPath("server.meta.tags"), "meta.tags");
  assert.equal(fieldOfPath("server.searchKeywords.echo"), "searchKeywords");
  assert.equal(fieldOfPath("server"), "__form");
  assert.equal(fieldOfPath("server.unknownField"), "unknownField");
  assert.equal(fieldOfPath("settings.outputGuard.maxBytes"), "settings.outputGuard.maxBytes");
});

test("groupErrors 归并同字段的多条消息", () => {
  const groups = groupErrors([
    { path: "server.args[0]", message: "第 1 项不能为空。" },
    { path: "server.args[1]", message: "第 2 项不能为空。" },
    { path: "server.env.A", message: "值必须是字符串。" },
  ]);
  assert.deepEqual(Object.keys(groups).sort(), ["args", "env"]);
  assert.equal(groups.args.length, 2);
});

/* ---------------- 排序 ---------------- */

test("reorderNames（拖动排序）", () => {
  const names = ["a", "b", "c"];
  assert.deepEqual(reorderNames(names, 0, 2), ["b", "c", "a"]);
  assert.deepEqual(reorderNames(names, 2, 0), ["c", "a", "b"]);
  assert.deepEqual(names, ["a", "b", "c"], "原数组不能被改动");
});

/* ---------------- 展示 ---------------- */

test("serverSummaryText 与 viewSummaryText", () => {
  assert.equal(serverSummaryText({ transport: "stdio", command: "node", args: ["-y", "pkg"] }), "node -y pkg");
  assert.equal(serverSummaryText({ transport: "stdio" }).length > 0, true);
  assert.equal(serverSummaryText({ transport: "streamable-http", url: "https://x/y" }), "https://x/y");
  assert.equal(viewSummaryText(makeServerView({ args: ["a"] })), "node a");
});

test("lifecycleLabel / formatTimestamp", () => {
  assert.equal(lifecycleLabel("eager").startsWith("eager"), true);
  assert.equal(lifecycleLabel("lazy-keep-alive").startsWith("lazy-keep-alive"), true);
  assert.equal(lifecycleLabel("nonsense").startsWith("lazy"), true);
  assert.equal(formatTimestamp(0).length, 16);
  assert.equal(formatTimestamp(undefined), "");
});

/* ---------------- 全局设置 ---------------- */

test("settingsDraftFrom / settingsToSubmit：只带设置过的项", () => {
  const draft = settingsDraftFrom(
    { idleTimeoutMin: 3, outputGuard: { enabled: false, maxBytes: 1024, maxLines: 10 }, failureBackoffMs: 1000 },
    ["idleTimeout", "outputGuard"],
  );
  assert.equal(settingsHas(draft, "idleTimeout"), true);
  assert.equal(settingsHas(draft, "failureBackoffMs"), false);
  assert.deepEqual(settingsToSubmit(draft), {
    idleTimeout: 3,
    outputGuard: { enabled: false, maxBytes: 1024, maxLines: 10 },
  });
  assert.deepEqual(
    settingsToSubmit(
      settingsDraftFrom(
        { idleTimeoutMin: 10, outputGuard: { enabled: true, maxBytes: 1, maxLines: 1 }, failureBackoffMs: 0 },
        [],
      ),
    ),
    {},
  );
});

test("validateSettingsDraft 拒绝非法数值", () => {
  const bad = { values: { idleTimeout: "x", "outputGuard.maxBytes": "0", failureBackoffMs: "1.5" } };
  const paths = validateSettingsDraft(bad).map((e) => e.path);
  assert.deepEqual(paths, ["settings.idleTimeout", "settings.failureBackoffMs", "settings.outputGuard.maxBytes"]);
  assert.deepEqual(validateSettingsDraft({ values: { idleTimeout: "0", "outputGuard.maxBytes": "1" } }), []);
});

test("字段顺序与宿主白名单一致（19 个字段 + meta）", () => {
  assert.equal(SERVER_FIELD_ORDER.length, 20);
  assert.equal(SERVER_FIELD_ORDER[SERVER_FIELD_ORDER.length - 1], "meta");
});
/* ---------------- UI-B：列表筛选 / 状态点 / 副标题 ---------------- */

const NOW = 1_760_000_000_000;

test("matchesFilter：全部 / 已启用 / 已停用 / 有错误", () => {
  const enabled = makeServerView({ serverName: "a" });
  const disabled = makeServerView({ serverName: "b", disabled: true });
  const failing = makeServerView({ serverName: "c", setFields: ["serverName", "transport", "command"] });
  const rows = new Map([["c", { name: "c", disabled: false, lastFailure: { message: "启动失败", at: NOW } }]]);
  assert.equal(matchesFilter(enabled, undefined, "all"), true);
  assert.equal(matchesFilter(disabled, undefined, "enabled"), false);
  assert.equal(matchesFilter(disabled, undefined, "disabled"), true);
  assert.equal(matchesFilter(failing, rows.get("c"), "failing"), true);
  assert.equal(matchesFilter(enabled, undefined, "failing"), false);
});

test("matchesQuery：名称 / 命令 / 描述 / 标签，大小写不敏感", () => {
  const view = makeServerView({
    serverName: "Demo",
    args: ["-y", "pkg"],
    meta: { description: "本地回显", tags: ["走查"] },
  });
  assert.equal(matchesQuery(view, ""), true);
  assert.equal(matchesQuery(view, "demo"), true);
  assert.equal(matchesQuery(view, "node"), true);
  assert.equal(matchesQuery(view, "回显"), true);
  assert.equal(matchesQuery(view, "走查"), true);
  assert.equal(matchesQuery(view, "nope"), false);
});

test("serverFilterCounts / visibleServers：计数与搜索筛选一致", () => {
  const servers = [
    makeServerView({ serverName: "a" }),
    makeServerView({ serverName: "b", disabled: true }),
    makeServerView({ serverName: "c" }),
  ];
  const rows = new Map([["c", { name: "c", disabled: false, lastFailure: { message: "启动失败", at: NOW } }]]);
  assert.deepEqual(serverFilterCounts(servers, rows), { all: 3, enabled: 2, disabled: 1, failing: 1 });
  assert.deepEqual(
    visibleServers(servers, rows, "", "disabled").map((view) => view.serverName),
    ["b"],
  );
  assert.deepEqual(
    visibleServers(servers, rows, "c", "all").map((view) => view.serverName),
    ["c"],
  );
  assert.deepEqual(
    visibleServers(servers, rows, "c", "failing").map((view) => view.serverName),
    ["c"],
  );
  assert.deepEqual(visibleServers(servers, rows, "c", "disabled"), []);
});

test("serverStatusTone：冷却 > 失败 > 有活跃实例 > 空闲", () => {
  const cooling = {
    name: "x",
    disabled: false,
    lastFailure: { message: "启动失败", at: NOW, cooldownUntil: NOW + 30_000 },
  };
  assert.equal(serverStatusTone(cooling, 2, NOW), "cooling");
  assert.equal(serverStatusTone(cooling, 2, NOW + 30_000), "failed");
  assert.equal(
    serverStatusTone({ name: "x", disabled: false, lastFailure: { message: "启动失败", at: NOW } }, 0, NOW),
    "failed",
  );
  assert.equal(serverStatusTone(undefined, 1, NOW), "active");
  assert.equal(serverStatusTone(undefined, 0, NOW), "idle");
  assert.equal(statusTitle("idle"), undefined);
  assert.equal(typeof statusTitle("active"), "string");
  assert.equal(typeof statusTitle("failed"), "string");
  assert.equal(typeof statusTitle("cooling"), "string");
});

test("cooldownText / formatDuration：倒计时文案随 now 变化，冷却结束就不显示", () => {
  const failure = { message: "启动失败", at: NOW, cooldownUntil: NOW + 47_000 };
  assert.equal(cooldownRemainingMs(failure, NOW), 47_000);
  assert.equal(cooldownText(failure, NOW), "冷却中，剩余 47 秒");
  assert.equal(cooldownText(failure, NOW + 47_000), undefined);
  assert.equal(cooldownText(undefined, NOW), undefined);
  assert.equal(formatDuration(65_000), "1 分 05 秒");
  assert.equal(formatDuration(999), "0 秒");
  assert.equal(formatDuration(3_900_000), "1 小时 05 分");
  assert.equal(
    cooldownRemainingMs({ message: "x", at: NOW, cooldownUntil: NOW + 1000 }, NOW + 60_000),
    0,
    "时钟回拨 / 已过期一律夹到 0",
  );
  assert.equal(cooldownRemainingMs({ message: "x", at: NOW }, NOW), 0, "cooldownUntil 缺失 = 冷却已结束");
});

test("rowSubtitleText：命令 / 地址 + 「· N 个工具」（没有缓存时省略）", () => {
  const view = makeServerView({ args: ["-y", "pkg"] });
  assert.equal(rowSubtitleText(view, undefined), "node -y pkg");
  assert.equal(
    rowSubtitleText(view, {
      name: "demo",
      disabled: false,
      cache: { toolCount: 4, updatedAt: NOW, stale: false, tools: [] },
    }),
    "node -y pkg · 4 个工具",
  );
  assert.equal(
    rowSubtitleText(makeServerView({ transport: "streamable-http", url: "https://x/y" }), undefined),
    "https://x/y",
  );
});

test("cacheLineText / cachedToolNames：抽屉「工具」小节", () => {
  assert.equal(cacheLineText(undefined), "还没有工具缓存（保存或刷新后会自动探测一次）");
  const row = {
    name: "demo",
    disabled: false,
    cache: { toolCount: 2, updatedAt: NOW, stale: true, tools: [{ name: "echo" }, { name: "slow" }] },
  };
  assert.equal(cacheLineText(row).includes("缓存 2 个工具"), true);
  assert.equal(cacheLineText(row).includes("缓存已过期"), true);
  assert.deepEqual(cachedToolNames(row), ["echo", "slow"]);
  assert.deepEqual(cachedToolNames(undefined), []);
  assert.deepEqual(
    cachedToolNames({
      name: "demo",
      disabled: false,
      cache: { toolCount: 1, updatedAt: NOW, stale: false, tools: [] },
    }),
    [],
  );
});

test("activeInstanceCount / runtimeIndex：从运行态会话里数实例", () => {
  const inst = (server: string) => ({ server, state: "ready", startedAt: NOW, lastUsedAt: NOW });
  const runtime = {
    servers: [{ name: "demo", disabled: false }],
    sessions: [
      { sessionId: "s1", instances: [inst("demo"), inst("other")] },
      { sessionId: "s2", instances: [inst("demo")] },
    ],
  };
  assert.equal(activeInstanceCount(runtime, "demo"), 2);
  assert.equal(activeInstanceCount(runtime, "nope"), 0);
  assert.equal(activeInstanceCount(undefined, "demo"), 0);
  assert.deepEqual([...runtimeIndex(runtime).keys()], ["demo"]);
});

test("formatClock：本地 HH:mm", () => {
  assert.match(formatClock(NOW), /^\d{2}:\d{2}$/);
  assert.equal(formatClock(undefined), "");
  assert.equal(formatClock(0), "");
});

test("列表行的紧凑命令：路径只留文件名，可执行文件去掉扩展名，包名与地址原样", () => {
  assert.equal(
    compactSummaryText({
      transport: "stdio",
      command: "D:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\x\\y\\fake-mcp-server.mjs"],
    }),
    "node fake-mcp-server.mjs",
  );
  assert.equal(
    compactSummaryText({ transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"] }),
    "npx -y @modelcontextprotocol/server-fetch",
  );
  assert.equal(
    compactSummaryText({
      transport: "stdio",
      command: "uvx",
      args: ["mcp-server-time", "--local-timezone=Asia/Shanghai"],
    }),
    "uvx mcp-server-time --local-timezone=Asia/Shanghai",
  );
  assert.equal(
    compactSummaryText({ transport: "stdio", command: "/usr/local/bin/python3", args: ["./server.py"] }),
    "python3 server.py",
  );
  assert.equal(
    compactSummaryText({ transport: "streamable-http", url: "https://example.com/mcp" }),
    "https://example.com/mcp",
  );
  assert.equal(isPathLike("@scope/pkg"), false);
  assert.equal(isPathLike("~/bin/tool"), true);
  assert.equal(shortPart("C:\\tools\\server.CMD", true), "server");
});

/* ---------------- 草稿与默认值（D-C1） ---------------- */

test("draftFromView 只搬显式设置过的字段", () => {
  const view = makeServerView({
    setFields: ["serverName", "transport", "command", "args", "env"],
    args: ["-y", "pkg"],
    env: { TOKEN: HIDDEN_VALUE },
  });
  const draft = draftFromView(view);
  for (const field of ["serverName", "transport", "command", "args", "env"])
    assert.equal(draftHas(draft, field), true, field);
  assert.equal(draftHas(draft, "cwd"), false);
  assert.equal(draftHas(draft, "lifecycle"), false);
});

test("draftFromValues 把数值字段转成文本，保留全部白名单字段", () => {
  const draft = draftFromValues({
    serverName: "a",
    transport: "stdio",
    command: "node",
    idleTimeout: 7,
    meta: { description: "d" },
  });
  assert.equal(draft.values.idleTimeout, "7");
  assert.deepEqual(draft.values.meta, { description: "d" });
  assert.equal(draftHas(draft, "idleTimeout"), true);
  assert.equal(draftHas(draft, "cwd"), false);
  assert.equal(withField(emptyServerDraft("stdio"), "command", "node").values.command, "node");
});
