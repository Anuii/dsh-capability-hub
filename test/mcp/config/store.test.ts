/**
 * store.ts：加载、原子写、默认值不落盘、外部修改、写前合并、损坏恢复、onChange、并发。
 * 全部落在 os.tmpdir() 的临时目录。
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createMcpStore } from "../../../src/mcp/config/store.ts";
import { delay, makeTempDir, readJson, recordingLogger } from "./helpers.ts";

function open(hubHome: string, pollIntervalMs = 0) {
  const logger = recordingLogger();
  const store = createMcpStore(hubHome, logger, { pollIntervalMs });
  return { store, logger };
}

describe("store: 加载", () => {
  it("文件不存在时以空配置启动", async () => {
    const dir = await makeTempDir();
    try {
      const { store, logger } = open(join(dir.path, "hub"));
      await store.ready();
      assert.deepEqual(store.get(), {
        settings: {
          idleTimeoutMin: 10,
          outputGuard: { enabled: true, maxBytes: 51200, maxLines: 2000 },
          failureBackoffMs: 60000,
        },
        servers: [],
      });
      assert.deepEqual(store.warnings, []);
      assert.equal(logger.text(), "");
      assert.equal(store.path, join(dir.path, "hub", "mcp", "config.json"));
      store.dispose();
    } finally {
      await dir.cleanup();
    }
  });

  it("读回已有配置并解析默认值与全局 idleTimeout", async () => {
    const dir = await makeTempDir();
    try {
      const hub = join(dir.path, "hub");
      await fs.mkdir(join(hub, "mcp"), { recursive: true });
      await fs.writeFile(
        join(hub, "mcp", "config.json"),
        JSON.stringify({
          version: 1,
          settings: { idleTimeout: 3, outputGuard: { maxLines: 5 } },
          servers: [
            { serverName: "a", transport: "stdio", command: "node" },
            { serverName: "b", transport: "stdio", command: "node", idleTimeout: 9 },
          ],
        }),
        "utf8",
      );
      const { store } = open(hub);
      await store.ready();
      assert.equal(store.get().settings.idleTimeoutMin, 3);
      assert.deepEqual(store.get().settings.outputGuard, { enabled: true, maxBytes: 51200, maxLines: 5 });
      assert.equal(store.get().servers[0].idleTimeoutMin, 3);
      assert.equal(store.get().servers[1].idleTimeoutMin, 9);
      store.dispose();
    } finally {
      await dir.cleanup();
    }
  });
});

describe("store: 写入与默认值不落盘", () => {
  it("原子写：只落盘非默认字段", async () => {
    const dir = await makeTempDir();
    try {
      const hub = join(dir.path, "hub");
      const { store } = open(hub);
      await store.ready();
      await store.save((draft) => {
        draft.servers.push({ serverName: "demo", transport: "stdio", command: "node" });
        draft.settings = {};
      });
      const onDisk = (await readJson(store.path)) as { version: number; settings: unknown; servers: unknown[] };
      assert.equal(onDisk.version, 1);
      assert.deepEqual(onDisk.settings, {});
      assert.deepEqual(onDisk.servers, [{ serverName: "demo", transport: "stdio", command: "node" }]);
      const text = await fs.readFile(store.path, "utf8");
      for (const key of [
        "args",
        "envFrom",
        "envFromTimeoutMs",
        "toolCallTimeoutMs",
        "lifecycle",
        "disabled",
        "debug",
        "searchKeywords",
      ]) {
        assert.equal(text.includes('"' + key + '"'), false, key + " 是默认值，不应落盘");
      }
      store.dispose();
    } finally {
      await dir.cleanup();
    }
  });

  it("临时文件不在目录里残留", async () => {
    const dir = await makeTempDir();
    try {
      const hub = join(dir.path, "hub");
      const { store } = open(hub);
      await store.ready();
      await store.save((draft) => draft.servers.push({ serverName: "a", transport: "stdio", command: "node" }));
      const entries = await fs.readdir(join(hub, "mcp"));
      assert.deepEqual(entries, ["config.json"]);
      store.dispose();
    } finally {
      await dir.cleanup();
    }
  });

  it("并发 save 串行执行，不丢更新", async () => {
    const dir = await makeTempDir();
    try {
      const hub = join(dir.path, "hub");
      const { store } = open(hub);
      await store.ready();
      await Promise.all([
        store.save((draft) => draft.servers.push({ serverName: "a", transport: "stdio", command: "node" })),
        store.save((draft) => draft.servers.push({ serverName: "b", transport: "stdio", command: "node" })),
        store.save((draft) => draft.servers.push({ serverName: "c", transport: "stdio", command: "node" })),
      ]);
      assert.deepEqual(
        store.get().servers.map((s) => s.serverName),
        ["a", "b", "c"],
      );
      store.dispose();
    } finally {
      await dir.cleanup();
    }
  });

  it("mutator 抛错时放弃本次写入", async () => {
    const dir = await makeTempDir();
    try {
      const hub = join(dir.path, "hub");
      const { store } = open(hub);
      await store.ready();
      await store.save((draft) => draft.servers.push({ serverName: "a", transport: "stdio", command: "node" }));
      await assert.rejects(
        async () =>
          await store.save(() => {
            throw new Error("boom");
          }),
        /boom/,
      );
      assert.deepEqual(
        store.get().servers.map((s) => s.serverName),
        ["a"],
      );
      store.dispose();
    } finally {
      await dir.cleanup();
    }
  });
});

describe("store: onChange", () => {
  it("变更时给出 next 与 prev", async () => {
    const dir = await makeTempDir();
    try {
      const hub = join(dir.path, "hub");
      const { store } = open(hub);
      await store.ready();
      const events: { next: string[]; prev: string[] }[] = [];
      const off = store.onChange((next, prev) => {
        events.push({ next: next.servers.map((s) => s.serverName), prev: prev.servers.map((s) => s.serverName) });
      });
      await store.save((draft) => draft.servers.push({ serverName: "a", transport: "stdio", command: "node" }));
      await store.save((draft) => draft.servers.push({ serverName: "b", transport: "stdio", command: "node" }));
      assert.deepEqual(events, [
        { next: ["a"], prev: [] },
        { next: ["a", "b"], prev: ["a"] },
      ]);
      off();
      await store.save((draft) => draft.servers.push({ serverName: "c", transport: "stdio", command: "node" }));
      assert.equal(events.length, 2);
      store.dispose();
    } finally {
      await dir.cleanup();
    }
  });

  it("无变化时不触发", async () => {
    const dir = await makeTempDir();
    try {
      const hub = join(dir.path, "hub");
      const { store } = open(hub);
      await store.ready();
      let count = 0;
      store.onChange(() => {
        count += 1;
      });
      await store.save(() => undefined);
      await store.reload();
      assert.equal(count, 0);
      store.dispose();
    } finally {
      await dir.cleanup();
    }
  });
});

describe("store: 外部修改", () => {
  it("轮询检测到外部修改后重新加载并触发 onChange", async () => {
    const dir = await makeTempDir();
    try {
      const hub = join(dir.path, "hub");
      const { store } = open(hub, 30);
      await store.ready();
      const events: string[][] = [];
      store.onChange((next) => events.push(next.servers.map((s) => s.serverName)));
      // 模拟另一个 DSH 进程写文件
      await fs.mkdir(join(hub, "mcp"), { recursive: true });
      await fs.writeFile(
        join(hub, "mcp", "config.json"),
        JSON.stringify({
          version: 1,
          settings: {},
          servers: [{ serverName: "external", transport: "stdio", command: "node" }],
        }),
        "utf8",
      );
      for (let i = 0; i < 60 && events.length === 0; i += 1) await delay(25);
      assert.deepEqual(events, [["external"]]);
      assert.deepEqual(
        store.get().servers.map((s) => s.serverName),
        ["external"],
      );
      store.dispose();
    } finally {
      await dir.cleanup();
    }
  });

  it("写前发现外部修改：先重新加载再应用本次变更", async () => {
    const dir = await makeTempDir();
    try {
      const hub = join(dir.path, "hub");
      const { store } = open(hub);
      await store.ready();
      await store.save((draft) => draft.servers.push({ serverName: "mine", transport: "stdio", command: "node" }));

      // 外部进程追加了一个服务器，并改了全局设置
      await fs.writeFile(
        store.path,
        JSON.stringify({
          version: 1,
          settings: { idleTimeout: 1 },
          servers: [
            { serverName: "mine", transport: "stdio", command: "node" },
            { serverName: "theirs", transport: "stdio", command: "node" },
          ],
        }),
        "utf8",
      );

      await store.save((draft) => {
        draft.servers.push({ serverName: "added-by-me", transport: "stdio", command: "node" });
      });

      assert.deepEqual(
        store.get().servers.map((s) => s.serverName),
        ["mine", "theirs", "added-by-me"],
      );
      assert.equal(store.get().settings.idleTimeoutMin, 1);
      const onDisk = (await readJson(store.path)) as { settings: { idleTimeout?: number } };
      assert.equal(onDisk.settings.idleTimeout, 1, "外部改动不能被本次写入覆盖");
      store.dispose();
    } finally {
      await dir.cleanup();
    }
  });

  it("dispose 停止轮询", async () => {
    const dir = await makeTempDir();
    try {
      const hub = join(dir.path, "hub");
      const { store } = open(hub, 20);
      await store.ready();
      store.dispose();
      await fs.mkdir(join(hub, "mcp"), { recursive: true });
      await fs.writeFile(
        join(hub, "mcp", "config.json"),
        JSON.stringify({
          version: 1,
          settings: {},
          servers: [{ serverName: "x", transport: "stdio", command: "node" }],
        }),
        "utf8",
      );
      await delay(120);
      assert.deepEqual(store.get().servers, []);
    } finally {
      await dir.cleanup();
    }
  });
});

describe("store: 损坏恢复", () => {
  it("非法 JSON：备份为 .corrupt-<时间戳> 并以空配置启动，给出 warning", async () => {
    const dir = await makeTempDir();
    try {
      const hub = join(dir.path, "hub");
      await fs.mkdir(join(hub, "mcp"), { recursive: true });
      await fs.writeFile(join(hub, "mcp", "config.json"), "{ 这不是 JSON", "utf8");
      const { store, logger } = open(hub);
      await store.ready();
      assert.deepEqual(store.get().servers, []);
      assert.equal(store.warnings.length, 1);
      assert.match(store.warnings[0], /不是合法 JSON/);
      const files = await fs.readdir(join(hub, "mcp"));
      const backups = files.filter((f) => f.startsWith("config.json.corrupt-"));
      assert.equal(backups.length, 1);
      assert.equal(await fs.readFile(join(hub, "mcp", backups[0]), "utf8"), "{ 这不是 JSON");
      assert.equal(files.includes("config.json"), false);
      assert.match(logger.text(), /不是合法 JSON/);
      // 恢复后还能正常写
      await store.save((draft) => draft.servers.push({ serverName: "a", transport: "stdio", command: "node" }));
      assert.deepEqual(
        store.get().servers.map((s) => s.serverName),
        ["a"],
      );
      store.dispose();
    } finally {
      await dir.cleanup();
    }
  });

  it("结构异常（顶层不是对象）时忽略内容并给出 warning", async () => {
    const dir = await makeTempDir();
    try {
      const hub = join(dir.path, "hub");
      await fs.mkdir(join(hub, "mcp"), { recursive: true });
      await fs.writeFile(join(hub, "mcp", "config.json"), "[1,2,3]", "utf8");
      const { store } = open(hub);
      await store.ready();
      assert.deepEqual(store.get().servers, []);
      assert.equal(store.warnings.length, 1);
      assert.match(store.warnings[0], /结构异常/);
      store.dispose();
    } finally {
      await dir.cleanup();
    }
  });
});
