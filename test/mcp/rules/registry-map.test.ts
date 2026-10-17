/**
 * rules/registry-map.ts：一键生成配置的映射表、建议名、env 与 unsupported 的中文原因。
 *
 * 纯函数测试：不联网、不碰磁盘。重点钉住「优先级」与「缺字段不抛」这两件事。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_DESCRIPTION_LENGTH,
  MAX_SERVER_NAME_LENGTH,
  mapRegistryServer,
  normalizeDescription,
  registryItemOf,
  registryKinds,
  registryRequiredEnv,
  suggestServerName,
} from "../../../src/mcp/rules/registry-map.ts";

/** DSH 的服务器名规则（与 rules/server.ts 一致）。 */
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

type Raw = Record<string, unknown> & { serverName: string };

/** 要求能一键生成配置，返回 raw 与 notes。 */
function rawOf(server: unknown, existing: readonly string[] = []): { raw: Raw; notes: string[] } {
  const mapped = mapRegistryServer(server, existing);
  assert.ok(
    "raw" in mapped,
    "应当能生成配置，实际 unsupported：" + ("unsupported" in mapped ? mapped.unsupported : ""),
  );
  return mapped as unknown as { raw: Raw; notes: string[] };
}

/** 要求判为不支持，返回中文原因。 */
function unsupportedOf(server: unknown, existing: readonly string[] = []): string {
  const mapped = mapRegistryServer(server, existing);
  assert.ok("unsupported" in mapped, "应当判为不支持，实际生成了配置：" + JSON.stringify(mapped));
  return (mapped as { unsupported: string }).unsupported;
}

function npmPackage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registryType: "npm",
    identifier: "@example/demo",
    version: "1.0.0",
    transport: { type: "stdio" },
    ...overrides,
  };
}

describe("registry-map: 映射优先级", () => {
  it("有 streamable-http 远程就用远程（即使同时有 npm 包），env / command 都不填", () => {
    const { raw, notes } = rawOf({
      name: "io.example/remote-demo",
      title: "远程示例",
      description: "只有远程的示例",
      version: "1.2.3",
      remotes: [
        { type: "sse", url: "https://x.example/sse" },
        { type: "streamable-http", url: "https://x.example/mcp" },
      ],
      packages: [npmPackage({ environmentVariables: [{ name: "SHOULD_NOT_APPEAR", isRequired: true }] })],
    });
    assert.equal(raw.transport, "streamable-http");
    assert.equal(raw.url, "https://x.example/mcp");
    assert.equal(raw.serverName, "remote-demo");
    assert.equal(raw.command, undefined);
    assert.equal(raw.args, undefined);
    assert.equal(raw.env, undefined, "远程接入不需要本地 env");
    assert.deepEqual(raw.meta, { description: "只有远程的示例" });
    assert.ok(notes.some((note) => /同时提供了安装包，已优先用远程地址/.test(note)));
  });

  it("远程的请求头：带 value 的写进 headers，只有声明的进 notes（registry 的 headers 是声明式的）", () => {
    const { raw, notes } = rawOf({
      name: "io.example/headers-demo",
      version: "1.0.0",
      remotes: [
        {
          type: "streamable-http",
          url: "https://x.example/mcp",
          headers: [
            { name: "Authorization", description: "令牌", isSecret: true },
            { name: "X-Tenant", value: "acme" },
          ],
        },
      ],
    });
    assert.deepEqual(raw.headers, { "X-Tenant": "acme" });
    assert.equal(
      notes.some((note) => /远程需要请求头 Authorization/.test(note)),
      true,
      "没给值的请求头要在 notes 里说",
    );
    assert.equal(
      notes.some((note) => /X-Tenant/.test(note)),
      false,
      "给了值的请求头不该再提示",
    );
  });

  it("npm 包 → npx -y <identifier> + 位置参数（命名参数只进 notes）", () => {
    const { raw, notes } = rawOf({
      name: "io.github.example/npm-demo",
      version: "2.0.0",
      packages: [
        npmPackage({
          identifier: "@scope/pkg",
          runtimeArguments: [{ type: "named", name: "--port", value: "3000" }],
          packageArguments: [{ type: "positional", value: "/workspace" }],
        }),
      ],
    });
    assert.equal(raw.transport, "stdio");
    assert.equal(raw.command, "npx");
    assert.deepEqual(raw.args, ["-y", "@scope/pkg", "/workspace"]);
    assert.ok(notes.some((note) => /命名参数（--port）/.test(note)));
  });

  it("pypi 包 → uvx <identifier> + 位置参数", () => {
    const { raw } = rawOf({
      name: "io.example/pypi-demo",
      version: "0.1.0",
      packages: [
        {
          registryType: "pypi",
          identifier: "mcp-demo",
          version: "0.1.0",
          transport: { type: "stdio" },
          packageArguments: [
            { type: "positional", value: "--root" },
            { type: "positional", value: "/tmp" },
          ],
        },
      ],
    });
    assert.equal(raw.command, "uvx");
    assert.deepEqual(raw.args, ["mcp-demo", "--root", "/tmp"]);
  });

  it("oci 包 → docker run -i --rm <identifier> + 位置参数", () => {
    const { raw } = rawOf({
      name: "io.example/oci-demo",
      version: "1.0.0",
      packages: [{ registryType: "oci", identifier: "ghcr.io/example/demo:1", transport: { type: "stdio" } }],
    });
    assert.equal(raw.command, "docker");
    assert.deepEqual(raw.args, ["run", "-i", "--rm", "ghcr.io/example/demo:1"]);
  });

  it("npm 包缺 identifier 就降级到 pypi（不整条失败）", () => {
    const { raw, notes } = rawOf({
      name: "io.example/fallback-demo",
      version: "1.0.0",
      packages: [
        { registryType: "npm", transport: { type: "stdio" } },
        { registryType: "pypi", identifier: "pypi-demo", transport: { type: "stdio" } },
      ],
    });
    assert.equal(raw.command, "uvx");
    assert.deepEqual(raw.args, ["pypi-demo"]);
    assert.ok(notes.some((note) => /npm 包没有给出 identifier/.test(note)));
  });

  it("包的 transport 不是 stdio 时不能当本地命令启动", () => {
    const reason = unsupportedOf({
      name: "io.example/sse-package",
      version: "1.0.0",
      packages: [npmPackage({ transport: { type: "sse" } })],
    });
    assert.match(reason, /有 npm 包但不可用/);
    assert.match(reason, /transport 是 sse/);
  });
});

describe("registry-map: 不能一键生成时的中文原因", () => {
  it("只有 SSE 远程：说明「只提供 SSE 远程」，并说本插件支持什么", () => {
    const reason = unsupportedOf({
      name: "io.example/sse-only",
      version: "1.0.0",
      remotes: [{ type: "sse", url: "https://x.example/sse" }],
    });
    assert.match(reason, /只提供 SSE 远程/);
    assert.match(reason, /本插件只支持 streamable-http 远程与 npm \/ pypi \/ oci 包/);
  });

  it("只有 mcpb 包：说明「只有 mcpb 包」", () => {
    const reason = unsupportedOf({
      name: "io.example/mcpb-only",
      version: "1.0.0",
      packages: [{ registryType: "mcpb", identifier: "https://x.example/demo.mcpb" }],
    });
    assert.match(reason, /只有 mcpb 包/);
  });

  it("streamable-http 远程没给 url、也没有包：说清楚它声明了但缺地址", () => {
    const reason = unsupportedOf({
      name: "io.example/broken-remote",
      version: "1.0.0",
      remotes: [{ type: "streamable-http" }],
    });
    assert.match(reason, /声明了 streamable-http 远程但没有给 url/);
  });

  it("什么都没声明：说清楚「没有声明任何接入方式」", () => {
    const reason = unsupportedOf({ name: "io.example/empty", version: "1.0.0" });
    assert.match(reason, /没有声明任何接入方式/);
  });

  it("registry 数据不是对象 / 是空对象时也绝不抛错", () => {
    for (const garbage of [null, undefined, 42, "text", [], {}]) {
      const mapped = mapRegistryServer(garbage, []);
      assert.ok("unsupported" in mapped, "垃圾输入应当判为不支持：" + JSON.stringify(garbage));
    }
  });
});

describe("registry-map: env 与描述", () => {
  it("每个 environmentVariables 都进 env：有 default 用默认值，否则空串；必填的写进 notes", () => {
    const { raw, notes } = rawOf({
      name: "io.example/env-demo",
      version: "1.0.0",
      packages: [
        npmPackage({
          environmentVariables: [
            { name: "A_REQUIRED", description: "必填", isRequired: true },
            { name: "B_DEFAULT", default: "fast" },
            { name: "C_SECRET", isSecret: true },
          ],
        }),
      ],
    });
    assert.deepEqual(raw.env, { A_REQUIRED: "", B_DEFAULT: "fast", C_SECRET: "" });
    assert.equal(notes.includes("必填 A_REQUIRED，请填上再保存"), true);
    assert.equal(
      notes.some((note) => /B_DEFAULT|C_SECRET/.test(note)),
      false,
      "非必填的变量不用提示",
    );
  });

  it("没给名字的环境变量跳过，并在 notes 里说", () => {
    const { raw, notes } = rawOf({
      name: "io.example/env-noname",
      version: "1.0.0",
      packages: [npmPackage({ environmentVariables: [{ description: "没有名字" }, { name: "OK_KEY" }] })],
    });
    assert.deepEqual(raw.env, { OK_KEY: "" });
    assert.ok(notes.some((note) => /环境变量 registry 没给名字/.test(note)));
  });

  it("描述折掉换行，meta.description 截到 160 字", () => {
    assert.equal(normalizeDescription("  多行\n\n描述  带空格  "), "多行 描述 带空格");
    const long = "字".repeat(300);
    const { raw } = rawOf({
      name: "io.example/long-desc",
      version: "1.0.0",
      description: long,
      packages: [npmPackage()],
    });
    const description = (raw.meta as { description: string }).description;
    assert.equal(Array.from(description).length, MAX_DESCRIPTION_LENGTH);
    assert.equal(description.endsWith("…"), true);
  });

  it("没描述就不给 meta（不编一个空字符串）", () => {
    const { raw } = rawOf({ name: "io.example/no-desc", version: "1.0.0", packages: [npmPackage()] });
    assert.equal(raw.meta, undefined);
  });
});

describe("registry-map: 建议名", () => {
  it("取 / 之后那一段、非法字符换 -、转小写", () => {
    assert.equal(suggestServerName("io.github.upstash/context7", []), "context7");
    assert.equal(suggestServerName("io.github.User/My Cool.Server!", []), "my-cool-server-");
    assert.equal(NAME_RE.test(suggestServerName("io.github.User/My Cool.Server!", [])), true);
  });

  it("截到 32，且重名加后缀后仍然不超过 32", () => {
    const longName = "io.example/" + "a".repeat(50);
    const short = suggestServerName(longName, []);
    assert.equal(short.length, MAX_SERVER_NAME_LENGTH);
    assert.equal(NAME_RE.test(short), true);
    const deduped = suggestServerName(longName, [short]);
    assert.equal(deduped.length, MAX_SERVER_NAME_LENGTH);
    assert.equal(deduped.endsWith("-2"), true);
    assert.equal(NAME_RE.test(deduped), true);
  });

  it("重名依次加 -2、-3…", () => {
    assert.equal(suggestServerName("io.example/demo", []), "demo");
    assert.equal(suggestServerName("io.example/demo", ["other"]), "demo");
    assert.equal(suggestServerName("io.example/demo", ["demo"]), "demo-2");
    assert.equal(suggestServerName("io.example/demo", ["demo", "demo-2"]), "demo-3");
  });

  it("重名比较不分大小写（已有 Demo 时不再建议 demo）", () => {
    assert.equal(suggestServerName("io.example/demo", ["Demo"]), "demo-2");
  });

  it("一个可用字符都没有时退回兜底名，仍然合法", () => {
    assert.equal(suggestServerName("", []), "server");
    assert.equal(suggestServerName("   ", []), "---");
    assert.equal(NAME_RE.test(suggestServerName("   ", [])), true);
    assert.equal(suggestServerName("", ["server"]), "server-2");
  });

  it("建议名用在 raw.serverName 上，existingNames 参与去重", () => {
    const { raw } = rawOf({ name: "io.example/demo", version: "1.0.0", packages: [npmPackage()] }, ["demo"]);
    assert.equal(raw.serverName, "demo-2");
    assert.equal(NAME_RE.test(raw.serverName), true);
  });
});

describe("registry-map: RegistryItem（列表与详情共用）", () => {
  it("kinds 只列本插件真能接的形态：只有 SSE 远程时不给 remotes 标签", () => {
    assert.deepEqual(registryKinds({ remotes: [{ type: "sse", url: "https://x/sse" }] }), []);
    assert.deepEqual(
      registryKinds({ remotes: [{ type: "streamable-http", url: "https://x/mcp" }], packages: [npmPackage()] }),
      ["remotes", "npm"],
    );
    assert.deepEqual(registryKinds({ packages: [{ registryType: "oci", identifier: "img" }] }), ["oci"]);
    assert.deepEqual(
      registryKinds({
        packages: [
          { registryType: "npm", identifier: "a" },
          { registryType: "pypi", identifier: "b" },
        ],
      }),
      ["npm", "pypi"],
    );
  });

  it("requiresEnv 只收 isRequired 的变量名，并去重", () => {
    assert.deepEqual(
      registryRequiredEnv({
        packages: [
          npmPackage({ environmentVariables: [{ name: "A", isRequired: true }, { name: "B" }] }),
          { registryType: "pypi", identifier: "b", environmentVariables: [{ name: "A", isRequired: true }] },
        ],
      }),
      ["A"],
    );
  });

  it("字段齐全时给出完整 item；缺什么就少给什么", () => {
    assert.deepEqual(
      registryItemOf({
        name: "io.example/demo",
        title: "演示",
        description: "一句话描述",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://x/mcp" }],
        packages: [npmPackage({ environmentVariables: [{ name: "DEMO_KEY", isRequired: true }] })],
      }),
      {
        name: "io.example/demo",
        version: "1.0.0",
        kinds: ["remotes", "npm"],
        requiresEnv: ["DEMO_KEY"],
        title: "演示",
        description: "一句话描述",
      },
    );
    assert.deepEqual(registryItemOf({}), { name: "", version: "", kinds: [], requiresEnv: [] });
    assert.deepEqual(registryItemOf(null), { name: "", version: "", kinds: [], requiresEnv: [] });
  });
});
