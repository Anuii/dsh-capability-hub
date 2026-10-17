/**
 * 「从 Official Registry 搜索」的纯逻辑单测（0.9.0，界面侧）：
 *   1. 结果行视图（标题回退、接入方式标签、需要填 N 个变量）；
 *   2. 服务器名校验与错误文案（空 / 非法 / 重名，以及判定顺序）；
 *   3. 环境变量表单的初值、必填标记与「空着」；
 *   4. 「能不能保存」的判定与真正提交的配置体（白名单、名字覆盖、空值不落盘）。
 *
 * 只测纯函数（不碰 DOM / React / 网络），所以 node:test 直接跑。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSubmitConfig,
  envFieldViews,
  envKeys,
  initialEnvValues,
  kindLabel,
  missingRequiredEnv,
  nameIssueText,
  previewConfigText,
  registryRowView,
  saveGate,
  serverNameIssue,
} from "../../../src/mcp/client/registry/pure.ts";
import type {
  RegistryDetail,
  RegistryItem,
  RegistryKind,
  RegistrySuggestedConfig,
} from "../../../src/mcp/contract/registry.ts";

function makeItem(overrides: Partial<RegistryItem> = {}): RegistryItem {
  return {
    name: "io.github.upstash/context7",
    version: "1.0.2",
    kinds: ["remotes"],
    requiresEnv: [],
    ...overrides,
  };
}

function makeRaw(overrides: Partial<RegistrySuggestedConfig> = {}): RegistrySuggestedConfig {
  return {
    serverName: "context7",
    transport: "streamable-http",
    url: "https://mcp.context7.com/mcp",
    ...overrides,
  };
}

function makeDetail(overrides: Partial<RegistryDetail> = {}): RegistryDetail {
  return { item: makeItem(), raw: makeRaw(), notes: [], ...overrides };
}

/* ---------------- 结果行 ---------------- */

test("kindLabel：四种接入方式各有中文说法", () => {
  const kinds: RegistryKind[] = ["remotes", "npm", "pypi", "oci"];
  const labels = kinds.map(kindLabel);
  for (const label of labels) assert.ok(label.trim() !== "", "接入方式标签不能为空");
  assert.equal(new Set(labels).size, kinds.length, "四种说法的文案不能一样");
});

test("registryRowView：标题回退、版本原样、接入方式按 kinds 顺序", () => {
  const view = registryRowView(makeItem({ title: "Context7", kinds: ["remotes", "npm"], version: "2.0.0" }));
  assert.equal(view.heading, "Context7");
  assert.equal(view.name, "io.github.upstash/context7");
  assert.equal(view.version, "2.0.0");
  assert.deepEqual(view.kindLabels, [kindLabel("remotes"), kindLabel("npm")]);
});

test("registryRowView：没有展示名（或只有空白）就用 registry 名", () => {
  assert.equal(registryRowView(makeItem()).heading, "io.github.upstash/context7");
  assert.equal(registryRowView(makeItem({ title: "   " })).heading, "io.github.upstash/context7");
});

test("registryRowView：必填变量为 0 个时不提示「需要填」", () => {
  assert.equal(registryRowView(makeItem()).needsEnv, undefined);
  const view = registryRowView(makeItem({ requiresEnv: ["GCS_BUCKET", "API_KEY"] }));
  assert.ok(view.needsEnv !== undefined);
  assert.match(view.needsEnv, /2/);
});

test("registryRowView：description 空着就不带", () => {
  assert.equal(registryRowView(makeItem()).description, undefined);
  assert.equal(registryRowView(makeItem({ description: "查文档" })).description, "查文档");
});

/* ---------------- 服务器名 ---------------- */

test("serverNameIssue：空 / 非法 / 重名", () => {
  assert.equal(serverNameIssue(""), "empty");
  assert.equal(serverNameIssue("   "), "empty");
  assert.equal(serverNameIssue("context7"), undefined);
  assert.equal(serverNameIssue("a_b-1"), undefined);
  assert.equal(serverNameIssue("io.github.upstash/context7"), "invalid");
  assert.equal(serverNameIssue("has space"), "invalid");
  assert.equal(serverNameIssue("a".repeat(33)), "invalid");
  assert.equal(serverNameIssue("a".repeat(32)), undefined);
  assert.equal(serverNameIssue("dup", ["dup", "other"]), "conflict");
  assert.equal(serverNameIssue("dup", []), undefined);
});

test("serverNameIssue：既非法又重名时报非法（先修能修的那个）", () => {
  assert.equal(serverNameIssue("bad name", ["bad name"]), "invalid");
});

test("nameIssueText：三种问题都有中文说明，冲突带上名字", () => {
  assert.ok(nameIssueText("empty", "").length > 0);
  assert.ok(nameIssueText("invalid", "x").length > 0);
  assert.match(nameIssueText("conflict", "context7"), /context7/);
});

/* ---------------- 环境变量表单 ---------------- */

test("envKeys：raw.env 的键在前，只在 requiresEnv 里出现的键补在后面且不重复", () => {
  const item = makeItem({ requiresEnv: ["TOKEN", "REGION"] });
  const raw = makeRaw({ env: { TOKEN: "", PROXY: "http://localhost:7890" } });
  assert.deepEqual(envKeys(item, raw), ["TOKEN", "PROXY", "REGION"]);
});

test("initialEnvValues：宿主给的值原样带进表单，没给的填空串", () => {
  const item = makeItem({ requiresEnv: ["REGION"] });
  const raw = makeRaw({ env: { PROXY: "http://localhost:7890" } });
  assert.deepEqual(initialEnvValues(item, raw), { PROXY: "http://localhost:7890", REGION: "" });
  assert.deepEqual(initialEnvValues(item, undefined), { REGION: "" });
});

test("envFieldViews：必填标出来，空着算 missing；可选空着不拦", () => {
  const item = makeItem({ requiresEnv: ["TOKEN"] });
  const raw = makeRaw({ env: { TOKEN: "", PROXY: "" } });
  const fields = envFieldViews(item, raw, { TOKEN: "  " });
  assert.deepEqual(
    fields.map((field) => [field.key, field.required, field.missing]),
    [
      ["TOKEN", true, true],
      ["PROXY", false, false],
    ],
  );
  assert.notEqual(fields[0].placeholder, fields[1].placeholder, "必填与可选的占位文字要区分");
  const filled = envFieldViews(item, raw, { TOKEN: "abc" });
  assert.equal(filled[0].missing, false);
  assert.equal(filled[0].value, "abc");
});

test("missingRequiredEnv：按表单顺序列出还空着的必填变量", () => {
  const item = makeItem({ requiresEnv: ["B_TOKEN", "A_TOKEN"] });
  const raw = makeRaw({ env: { A_TOKEN: "" } });
  assert.deepEqual(missingRequiredEnv(item, raw, {}), ["A_TOKEN", "B_TOKEN"]);
  assert.deepEqual(missingRequiredEnv(item, raw, { A_TOKEN: "x", B_TOKEN: "y" }), []);
});

/* ---------------- 能不能保存 ---------------- */

test("saveGate：能生成 + 名字合法 + 必填都填了才放行", () => {
  const item = makeItem({ requiresEnv: ["TOKEN"] });
  const detail = makeDetail({ item, raw: makeRaw({ env: { TOKEN: "" } }) });
  assert.equal(saveGate({ detail, name: "context7", envValues: { TOKEN: "abc" } }).ok, true);

  const missing = saveGate({ detail, name: "context7", envValues: {} });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missingEnv, ["TOKEN"]);

  const badName = saveGate({ detail, name: "带空格 的名字", envValues: { TOKEN: "abc" } });
  assert.equal(badName.ok, false);
  assert.equal(badName.nameIssue, "invalid");

  const conflict = saveGate({ detail, name: "context7", existingNames: ["context7"], envValues: { TOKEN: "abc" } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.nameIssue, "conflict");
});

test("saveGate：详情还没读到 / 不能生成时一律不许保存", () => {
  assert.equal(saveGate({ detail: undefined, name: "context7" }).ok, false);
  const unsupported = makeDetail({ raw: undefined, unsupported: "只提供 SSE 远程" });
  assert.equal(saveGate({ detail: unsupported, name: "context7" }).ok, false);
  const noRaw = makeDetail({ raw: undefined });
  assert.equal(saveGate({ detail: noRaw, name: "context7" }).ok, false);
});

/* ---------------- 提交体与预览 ---------------- */

test("buildSubmitConfig：用界面上的名字覆盖宿主建议名", () => {
  const detail = makeDetail();
  const body = buildSubmitConfig(detail, "my-context7", {});
  assert.equal(body?.serverName, "my-context7");
  assert.equal(body?.url, "https://mcp.context7.com/mcp");
  assert.equal(body?.transport, "streamable-http");
});

test("buildSubmitConfig：表单里的变量值落盘，空着的可选变量不落盘", () => {
  const item = makeItem({ requiresEnv: ["TOKEN"] });
  const detail = makeDetail({
    item,
    raw: makeRaw({ env: { TOKEN: "", PROXY: "" }, transport: "stdio", command: "npx" }),
  });
  const body = buildSubmitConfig(detail, "pkg", { TOKEN: "secret", PROXY: "" });
  assert.deepEqual(body?.env, { TOKEN: "secret" });
});

test("buildSubmitConfig：一个变量都不用填时整条 env 不落盘", () => {
  const detail = makeDetail({ raw: makeRaw({ env: { PROXY: "" } }) });
  const body = buildSubmitConfig(detail, "context7", { PROXY: "" });
  assert.equal(body === undefined ? "undefined" : "env" in body, false);
});

test("buildSubmitConfig：只带白名单字段（registry 里多出来的键被丢掉）", () => {
  const raw = { ...makeRaw(), bogus: "x", packages: [] } as unknown as RegistrySuggestedConfig;
  const body = buildSubmitConfig(makeDetail({ raw }), "context7", {});
  assert.deepEqual(Object.keys(body ?? {}).sort(), ["serverName", "transport", "url"]);
});

test("buildSubmitConfig：没有 raw（不能生成）时返回 undefined", () => {
  assert.equal(buildSubmitConfig(makeDetail({ raw: undefined, unsupported: "只提供 SSE" }), "x", {}), undefined);
});

test("previewConfigText：预览就是提交体本身，能解析回来", () => {
  const detail = makeDetail();
  const text = previewConfigText(detail, "context7", {});
  assert.deepEqual(JSON.parse(text), buildSubmitConfig(detail, "context7", {}));
  assert.equal(previewConfigText(undefined, "context7", {}), "");
});
