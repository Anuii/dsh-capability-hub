/**
 * draft.ts 的纯逻辑单测（不碰 DOM / React / 网络）：草稿与默认值（D-C1）、遮罩值往返（D-C5）、
 * JSON 互转（D-C3）、校验（表单检查 + 与宿主同一份规则）、错误路径映射、全局设置。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HIDDEN, SERVER_FIELDS } from "../../../src/mcp/rules/server.ts";
import { isHttpUrl } from "../../../src/mcp/rules/values.ts";
import {
  draftFromValues,
  draftFromView,
  draftHas,
  draftToJsonText,
  draftToSubmit,
  emptyServerDraft,
  fieldOfPath,
  groupErrors,
  parseJsonServer,
  settingsDraftFrom,
  settingsHas,
  settingsToSubmit,
  validateDraft,
  validateSettingsDraft,
  withField,
  withMetaField,
  withoutField,
} from "../../../src/mcp/client/draft.ts";
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
    env: { TOKEN: HIDDEN },
  });
  const submit = draftToSubmit(draftFromView(view));
  assert.deepEqual(submit.env, { TOKEN: HIDDEN });
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
    env: { TOKEN: HIDDEN },
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
  // 切到 http 后草稿里还留着 envFrom（来回切换不丢内容），但提交体按传输方式裁掉它，所以不算错
  const http = withField(withField(emptyServerDraft("streamable-http"), "serverName", "w"), "envFrom", { A: "echo" });
  assert.deepEqual(validateDraft(withField(http, "url", "https://x"), {}), []);
  assert.equal("envFrom" in draftToSubmit(withField(http, "url", "https://x")), false);
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

test("字段白名单（19 个字段 + meta）与宿主是同一份", () => {
  assert.equal(SERVER_FIELDS.length, 20);
  assert.equal(SERVER_FIELDS[SERVER_FIELDS.length - 1], "meta");
});

/* ---------------- 草稿与默认值（D-C1） ---------------- */

test("draftFromView 只搬显式设置过的字段", () => {
  const view = makeServerView({
    setFields: ["serverName", "transport", "command", "args", "env"],
    args: ["-y", "pkg"],
    env: { TOKEN: HIDDEN },
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
