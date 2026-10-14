/**
 * session-guard.mjs：走查 / 截图脚本共用的会话守卫（只读会话存储）。
 *
 * 夹具全在 os.tmpdir() 下的临时目录里自建（**多帧** zstdCompressSync 造日志、utimesSync 设修改时间），
 * **绝不读真实的 ~/.dsh**（AGENTS.md 硬规则 2）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { zstdCompressSync } from "node:zlib";

import {
  newSessions,
  pickViewTarget,
  redactSession,
  selectionSeedScript,
  sessionsRoot,
  snapshotSessions,
  SESSION_FILE,
} from "../../scripts/lib/session-guard.mjs";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

interface SessionOptions {
  header?: Record<string, unknown>;
  events?: Array<Record<string, unknown>>;
  mtimeMs?: number;
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "session-guard-"));
}

/**
 * 把若干行编成 DSH 真实存储那样的**多帧** zstd：每行一帧，首尾相接。
 * （真实会话是一批事件一帧，一个会话上百帧；单帧夹具会掩盖「只解第一帧」的 bug。）
 */
function multiFrame(lines: string[]): Buffer {
  return Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + "\n", "utf8"))));
}

/** 写一个会话目录：header 为头，events 追加在头后面（每行一帧）；mtimeMs 决定「多久没动过」。 */
function writeSession(root: string, workspace: string, id: string, options: SessionOptions = {}): string {
  const {
    header = { type: "session", version: 4, id, cwd: "C:\\work", delegationDepth: 0 },
    events = [],
    mtimeMs = NOW - 2 * HOUR,
  } = options;
  const dir = join(root, workspace, id);
  mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))];
  const file = join(dir, SESSION_FILE);
  writeFileSync(file, multiFrame(lines));
  const stamp = new Date(mtimeMs);
  utimesSync(file, stamp, stamp);
  return file;
}

const turnStart = { type: "turn/start", turn: 1 };

function withRoot(body: (root: string) => void): void {
  const root = makeRoot();
  try {
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("session-guard: sessionsRoot", () => {
  it("默认是 ~/.dsh/sessions", () => {
    assert.equal(sessionsRoot({}), join(homedir(), ".dsh", "sessions"));
  });

  it("DSH_HOME 优先", () => {
    assert.equal(sessionsRoot({ DSH_HOME: "D:\\dsh-home" }), join("D:\\dsh-home", "sessions"));
  });
});

describe("session-guard: snapshotSessions / newSessions", () => {
  it("目录不存在返回空集", () => {
    withRoot((root) => {
      assert.deepEqual([...snapshotSessions(join(root, "nope"))], []);
    });
  });

  it("只收 <工作区>/<session-…> 目录，键用 / 连接", () => {
    withRoot((root) => {
      writeSession(root, "--C-Users-me-misc--", "session-aaaa1111");
      writeSession(root, "--C-Users-me-work--", "session-bbbb2222");
      // 不是 session- 前缀的目录、工作区下的散文件都不算
      mkdirSync(join(root, "--C-Users-me-misc--", "other-dir"), { recursive: true });
      writeFileSync(join(root, "--C-Users-me-misc--", "stray.txt"), "x");
      writeFileSync(join(root, "loose.txt"), "x");
      assert.deepEqual([...snapshotSessions(root)].sort(), [
        "--C-Users-me-misc--/session-aaaa1111",
        "--C-Users-me-work--/session-bbbb2222",
      ]);
    });
  });

  it("newSessions 只报 after 里新出现的键", () => {
    const before = new Set(["--w--/session-old11111", "--w--/session-gone2222"]);
    const after = new Set(["--w--/session-old11111", "--w--/session-new33333"]);
    assert.deepEqual(newSessions(before, after), ["--w--/session-new33333"]);
  });

  it("newSessions 在两边相同时为空", () => {
    const same = new Set(["--w--/session-old11111"]);
    assert.deepEqual(newSessions(same, new Set(same)), []);
  });

  it("快照与比较合起来能抓到新增会话", () => {
    withRoot((root) => {
      writeSession(root, "--C-Users-me-misc--", "session-aaaa1111");
      const before = snapshotSessions(root);
      writeSession(root, "--C-Users-me-misc--", "session-bbbb2222");
      assert.deepEqual(newSessions(before, snapshotSessions(root)), ["--C-Users-me-misc--/session-bbbb2222"]);
    });
  });
});

describe("session-guard: redactSession", () => {
  // 夹具一律用假用户名与假会话 id，绝不写进真实路径 / 真实会话 id（AGENTS.md 硬规则 6）。
  const KEY = "--C-Users-me-Desktop-misc--\\session-0123456789abcdef";
  const SHORT_KEY = "--C-Users-me-Desktop-misc--/session-0123456789abcdef";

  it("会话 id 只留前 8 位十六进制", () => {
    assert.equal(redactSession(KEY), "--C-…-misc--\\session-01234567…");
  });

  it("不包含完整会话 id", () => {
    const redacted = redactSession(SHORT_KEY);
    assert.ok(!redacted.includes("session-0123456789abcdef"), redacted);
    assert.ok(!redacted.includes("89abcdef"), redacted);
  });

  it("不包含工作区目录名中间那段绝对路径", () => {
    const redacted = redactSession(SHORT_KEY);
    assert.ok(!redacted.includes("Users-me-Desktop"), redacted);
    assert.ok(!redacted.includes("me-Desktop-misc"), redacted);
  });

  it("没有工作区前缀时只打印 id", () => {
    assert.equal(redactSession("session-0123456789abcdef"), "session-01234567…");
  });
});

describe("session-guard: pickViewTarget", () => {
  const pick = (root: string, options: { now?: number; minIdleMs?: number } = {}) =>
    pickViewTarget(root, { now: NOW, minIdleMs: HOUR, ...options });

  it("没有候选时返回 undefined（目录不存在）", () => {
    withRoot((root) => {
      assert.equal(pick(join(root, "nope")), undefined);
    });
  });

  it("空存储返回 undefined", () => {
    withRoot((root) => {
      assert.equal(pick(root), undefined);
    });
  });

  it("选 depth 0、有 turn/start、足够旧的会话", () => {
    withRoot((root) => {
      writeSession(root, "--w--", "session-aaaa1111", { events: [turnStart] });
      assert.equal(pick(root), "session-aaaa1111");
    });
  });

  it("空白会话（没有 turn/start）不选", () => {
    withRoot((root) => {
      writeSession(root, "--w--", "session-blank111", { events: [{ type: "session/end-seed" }] });
      assert.equal(pick(root), undefined);
    });
  });

  it("delegationDepth 非 0 不选", () => {
    withRoot((root) => {
      writeSession(root, "--w--", "session-deep1111", {
        header: { type: "session", version: 4, id: "session-deep1111", cwd: "C:\\w", delegationDepth: 1 },
        events: [turnStart],
      });
      assert.equal(pick(root), undefined);
    });
  });

  it("头不是 session 的不选", () => {
    withRoot((root) => {
      writeSession(root, "--w--", "session-notahead", {
        header: { type: "session/end-seed", version: 4, delegationDepth: 0 },
        events: [turnStart],
      });
      assert.equal(pick(root), undefined);
    });
  });

  it("刚动过的会话（不足 minIdleMs）不选", () => {
    withRoot((root) => {
      writeSession(root, "--w--", "session-fresh111", { events: [turnStart], mtimeMs: NOW - 60_000 });
      assert.equal(pick(root), undefined);
    });
  });

  it("边界：正好等于 now - minIdleMs 的不选", () => {
    withRoot((root) => {
      writeSession(root, "--w--", "session-edge1111", { events: [turnStart], mtimeMs: NOW - HOUR });
      assert.equal(pick(root), undefined);
    });
  });

  it("从新到旧取第一个可用的", () => {
    withRoot((root) => {
      writeSession(root, "--w--", "session-older111", { events: [turnStart], mtimeMs: NOW - 5 * HOUR });
      writeSession(root, "--w--", "session-newer111", { events: [turnStart], mtimeMs: NOW - 2 * HOUR });
      writeSession(root, "--w--", "session-newest11", { events: [turnStart], mtimeMs: NOW - 3 * HOUR });
      assert.equal(pick(root), "session-newer111");
    });
  });

  it("最新的那个不可用时跳过，取下一个", () => {
    withRoot((root) => {
      writeSession(root, "--w--", "session-usable111", { events: [turnStart], mtimeMs: NOW - 6 * HOUR });
      writeSession(root, "--w--", "session-blank222", { events: [], mtimeMs: NOW - 2 * HOUR });
      assert.equal(pick(root), "session-usable111");
    });
  });

  it("坏文件（不是 zstd）跳过", () => {
    withRoot((root) => {
      const dir = join(root, "--w--", "session-broken111");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, SESSION_FILE), "not zstd at all");
      const stamp = new Date(NOW - 2 * HOUR);
      utimesSync(join(dir, SESSION_FILE), stamp, stamp);
      writeSession(root, "--w--", "session-good1111", { events: [turnStart], mtimeMs: NOW - 4 * HOUR });
      assert.equal(pick(root), "session-good1111");
    });
  });

  it("头不是合法 JSON 的跳过", () => {
    withRoot((root) => {
      const dir = join(root, "--w--", "session-badhead11");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, SESSION_FILE);
      writeFileSync(file, multiFrame(["{ not json", JSON.stringify(turnStart)]));
      const stamp = new Date(NOW - 2 * HOUR);
      utimesSync(file, stamp, stamp);
      assert.equal(pick(root), undefined);
    });
  });

  it("没有日志文件的会话目录跳过", () => {
    withRoot((root) => {
      mkdirSync(join(root, "--w--", "session-nofile111"), { recursive: true });
      assert.equal(pick(root), undefined);
    });
  });

  it("坏行里的 turn/start 不算数（必须是一条真事件）", () => {
    withRoot((root) => {
      const dir = join(root, "--w--", "session-faketurn1");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, SESSION_FILE);
      writeFileSync(
        file,
        multiFrame([JSON.stringify({ type: "session", version: 4, delegationDepth: 0 }), '{"note":"turn/start"']),
      );
      const stamp = new Date(NOW - 2 * HOUR);
      utimesSync(file, stamp, stamp);
      assert.equal(pick(root), undefined);
    });
  });

  it("turn/start 在后面的帧里也能找到（真实会话是多帧 zstd）", () => {
    withRoot((root) => {
      // 头一帧，中间一堆事件帧，turn/start 只在最后一帧 —— 只解第一帧会误判成「空白会话」。
      const dir = join(root, "--w--", "session-late1111");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, SESSION_FILE);
      writeFileSync(
        file,
        multiFrame([
          JSON.stringify({ type: "session", version: 4, delegationDepth: 0 }),
          JSON.stringify({ type: "user/message", text: "a" }),
          JSON.stringify({ type: "assistant/message", text: "b" }),
          JSON.stringify({ type: "user/message", text: "c" }),
          JSON.stringify(turnStart),
        ]),
      );
      const stamp = new Date(NOW - 2 * HOUR);
      utimesSync(file, stamp, stamp);
      assert.equal(pick(root), "session-late1111");
    });
  });

  it("多帧但没有 turn/start 的仍不选", () => {
    withRoot((root) => {
      const dir = join(root, "--w--", "session-multiblank");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, SESSION_FILE);
      writeFileSync(
        file,
        multiFrame([
          JSON.stringify({ type: "session", version: 4, delegationDepth: 0 }),
          JSON.stringify({ type: "session/end-seed" }),
          JSON.stringify({ type: "user/message", text: "a" }),
        ]),
      );
      const stamp = new Date(NOW - 2 * HOUR);
      utimesSync(file, stamp, stamp);
      assert.equal(pick(root), undefined);
    });
  });

  it("中间夹一段不是合法帧的魔数字节时照样能解出其余帧", () => {
    withRoot((root) => {
      const dir = join(root, "--w--", "session-fakemagic");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, SESSION_FILE);
      const head = zstdCompressSync(
        Buffer.from(JSON.stringify({ type: "session", version: 4, delegationDepth: 0 }) + "\n"),
      );
      const tail = zstdCompressSync(Buffer.from(JSON.stringify(turnStart) + "\n"));
      // 28 B5 2F FD 只是恰好出现的字节，后面跟的不是真帧；解不动要跳过，不能挡住后面的真帧。
      const fakeMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03]);
      writeFileSync(file, Buffer.concat([head, fakeMagic, tail]));
      const stamp = new Date(NOW - 2 * HOUR);
      utimesSync(file, stamp, stamp);
      assert.equal(pick(root), "session-fakemagic");
    });
  });

  it("跨工作区按修改时间一起比", () => {
    withRoot((root) => {
      writeSession(root, "--w-one--", "session-one11111", { events: [turnStart], mtimeMs: NOW - 8 * HOUR });
      writeSession(root, "--w-two--", "session-two11111", { events: [turnStart], mtimeMs: NOW - 3 * HOUR });
      assert.equal(pick(root), "session-two11111");
    });
  });

  it("返回的是会话 id（目录名），不是整个键", () => {
    withRoot((root) => {
      writeSession(root, "--w--", "session-aaaa1111", { events: [turnStart] });
      const id = pick(root);
      assert.equal(id, "session-aaaa1111");
      assert.ok(!String(id).includes("/"));
    });
  });
});

describe("session-guard: selectionSeedScript", () => {
  /** 只实现 setItem 的最小 localStorage 替身。 */
  function fakeStorage() {
    const store = new Map<string, string>();
    return {
      getItem: (key: string): string => {
        const value = store.get(key);
        if (value === undefined) throw new Error("没有写入 " + key);
        return value;
      },
      setItem: (key: string, value: string) => store.set(key, String(value)),
      raw: store,
    };
  }

  function runSeed(sessionId: string) {
    const storage = fakeStorage();
    // 脚本只依赖 localStorage；这里在一个假 window 上执行它。
    new Function("localStorage", selectionSeedScript(sessionId))(storage);
    return storage;
  }

  it("写入 dsh.sessions.current 为 { sessionId }", () => {
    const storage = runSeed("session-aaaa1111");
    assert.deepEqual(JSON.parse(storage.getItem("dsh.sessions.current")), { sessionId: "session-aaaa1111" });
  });

  it("只写这一个键", () => {
    const storage = runSeed("session-aaaa1111");
    assert.deepEqual([...storage.raw.keys()], ["dsh.sessions.current"]);
  });

  it("id 用 JSON.stringify 安全嵌入（引号 / 反斜杠不会破脚本）", () => {
    const weird = 'session-x"y\\z';
    const storage = runSeed(weird);
    assert.deepEqual(JSON.parse(storage.getItem("dsh.sessions.current")), { sessionId: weird });
  });

  it("localStorage 抛异常时静默失败", () => {
    const storage = {
      setItem: () => {
        throw new Error("quota");
      },
    };
    assert.doesNotThrow(() => new Function("localStorage", selectionSeedScript("session-aaaa1111"))(storage));
  });
});
