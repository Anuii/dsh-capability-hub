/**
 * 「GitHub 镜像」对话框（D-B18）的**纯规则**与一个小状态仓库。
 *
 * 这里刻意不碰 DOM、不碰 React、不发请求：全部可以用 node:test 直接测
 * （见 test/skills/client/mirror-model.test.ts）。文案一律走 ../strings.ts 的 t()，
 * 所以测试断言的就是界面上真正会出现的字。
 *
 * 三层含义（对话框里必须说清）：镜像只作用于**下载**（安装 / 更新）；检查更新走
 * GitHub 接口、不经过镜像；镜像能看到并改动下载内容，所以只该用信任的镜像，
 * 而且走镜像时宿主不会发送 GitHub 令牌。
 *
 * 宿主路由（src/skills/remote/routes.ts，契约在 contract/remote.ts）：
 *   GET  skills/settings              → { version, githubMirror?, mirrorCapabilities?, directStatus? }
 *   POST skills/settings              → 保存后的设置（空串 = 清除；非法地址 422 + 中文 message）
 *   POST skills/settings/test-mirror  → { ok, ms?, message?, direct?, mirror? }（不保存；失败不抛错）
 *
 * D-B19（网络无感）：对话框除了自检结果，还要如实显示两行状态——直连（可用 / HTTP 403 / 超时（原因））
 * 与镜像能力（下载 ✓ · API ✗）。两行的文案都是本文件的纯函数，网络错误不再当成横幅往外弹。
 */

import { createStore, type Store } from "../../../kit/store.ts";
import { t } from "../strings.ts";
import { errorText } from "../../../shared/error-text.ts";
import { fieldErrorsOf } from "../../../platform/client/api.ts";
import type { FieldError } from "../../../platform/contract/host.ts";
import type { MirrorTestResult, SkillsRemoteSettings } from "../../contract/remote.ts";
import type { DirectStatus, MirrorCapabilities } from "../../../shared/network.ts";

/* ---------------- 纯规则 ---------------- */

/** 输入框的首尾空白一律丢掉：保存与测试都按去掉空白后的值发请求。 */
export function trimMirrorInput(raw: string): string {
  return (raw ?? "").trim();
}

/**
 * 镜像的主机名（带端口，例如 mirror.example.com:8443——换了端口的镜像其实是另一个镜像）；
 * 解析不出主机名时原样显示，用户至少能看到自己填了什么。
 */
export function mirrorHost(value: string): string {
  const trimmed = trimMirrorInput(value);
  try {
    const parsed = new URL(trimmed);
    return parsed.host === "" ? trimmed : parsed.host;
  } catch {
    return trimmed;
  }
}

/** 「⋯」菜单里那一项的标签：没设置是「GitHub 镜像…」，设置了带上镜像主机名。 */
export function mirrorMenuLabel(current: string | undefined): string {
  const trimmed = trimMirrorInput(current ?? "");
  if (trimmed === "") return t("skills.remote.menu.mirror");
  return t("skills.remote.menu.mirrorSet", { host: mirrorHost(trimmed) });
}

/** 自检结果那一行：成功给耗时，失败原样显示宿主给的中文原因。 */
export function mirrorTestText(result: MirrorTestResult): string {
  if (result.ok) {
    return typeof result.ms === "number"
      ? t("skills.remote.mirror.testOk", { ms: result.ms })
      : t("skills.remote.mirror.testOkNoMs");
  }
  const message = (result.message ?? "").trim();
  return message === "" ? t("skills.remote.mirror.testFailed") : message;
}

/* ---------------- 网络状态两行（D-B19） ---------------- */

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 直连状态 → 契约形状；形状不对（ok 不是布尔 / 没有 checkedAt）就整条丢掉，按「没探测过」处理。 */
export function normalizeDirectStatus(raw: unknown): DirectStatus | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record["ok"] !== "boolean") return undefined;
  const checkedAt = textOf(record["checkedAt"]);
  if (checkedAt === "") return undefined;
  const status: DirectStatus = { ok: record["ok"], checkedAt };
  if (typeof record["status"] === "number" && Number.isFinite(record["status"])) status.status = record["status"];
  const message = textOf(record["message"]);
  if (message !== "") status.message = message;
  return status;
}

/** 镜像能力 → 契约形状；形状不对（configured 不是布尔）就整条丢掉。 */
export function normalizeMirrorCapabilities(raw: unknown): MirrorCapabilities | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record["configured"] !== "boolean") return undefined;
  const capabilities: MirrorCapabilities = { configured: record["configured"] };
  if (typeof record["downloads"] === "boolean") capabilities.downloads = record["downloads"];
  if (typeof record["api"] === "boolean") capabilities.api = record["api"];
  const probedAt = textOf(record["probedAt"]);
  if (probedAt !== "") capabilities.probedAt = probedAt;
  const error = textOf(record["error"]);
  if (error !== "") capabilities.error = error;
  return capabilities;
}

/**
 * 「直连：可用 / HTTP 403 / 超时（原因）」那一行；undefined = 没有直连状态（从不显示半行）。
 *
 * 有状态码时只显示状态码（状态码本身就是结论，宿主的 message 往往重复它）；
 * 网络层失败（没有状态码）才把中文原因括在括号里——超时 / 其它失败按 message 里的字样分。
 */
export function directStatusLine(status: DirectStatus | undefined): string | undefined {
  if (status === undefined) return undefined;
  const message = textOf(status.message);
  const value = status.ok
    ? t("skills.remote.mirror.directOk")
    : typeof status.status === "number"
      ? t("skills.remote.mirror.directHttp", { status: status.status })
      : /超时|timeout/i.test(message)
        ? t("skills.remote.mirror.directTimeout")
        : t("skills.remote.mirror.directFailed");
  const reason =
    !status.ok && message !== "" && typeof status.status !== "number"
      ? t("skills.remote.mirror.reason", { message })
      : "";
  return t("skills.remote.mirror.directLine", { value: value + reason });
}

function capabilityState(value: boolean | undefined): string {
  if (value === true) return t("skills.remote.mirror.capYes");
  if (value === false) return t("skills.remote.mirror.capNo");
  return t("skills.remote.mirror.capUnknown");
}

/**
 * 「镜像：下载 ✓ · API ✗」那一行（下载与 API 的能力并不一致，所以分两项写）。
 * 没探测过 → 「镜像：未探测」；没配置镜像 → 「镜像：未配置」。
 */
export function mirrorCapabilityLine(capabilities: MirrorCapabilities | undefined): string {
  const line = (value: string): string => t("skills.remote.mirror.mirrorLine", { value });
  if (capabilities === undefined) return line(t("skills.remote.mirror.capUnknown"));
  if (!capabilities.configured) return line(t("skills.remote.mirror.mirrorUnconfigured"));
  const pair =
    t("skills.remote.mirror.capDownloads") +
    " " +
    capabilityState(capabilities.downloads) +
    " · " +
    t("skills.remote.mirror.capApi") +
    " " +
    capabilityState(capabilities.api);
  const reason = textOf(capabilities.error);
  return line(reason === "" ? pair : pair + t("skills.remote.mirror.reason", { message: reason }));
}

/** 保存成功后的 Toast：清空 = 改回直连 GitHub。 */
export function mirrorToastText(value: string): string {
  return trimMirrorInput(value) === "" ? t("skills.remote.mirror.cleared") : t("skills.remote.mirror.saved");
}

/* ---------------- 小状态仓库 ---------------- */

/** 数据访问（data.ts 的 mirrorApi；单测用内存 fake）。 */
export interface MirrorAdapter {
  load(): Promise<SkillsRemoteSettings>;
  /** 保存（空串 = 清除）；非法地址抛 422，调用方把宿主的中文 message 显示在对话框里 */
  save(mirror: string): Promise<SkillsRemoteSettings>;
  /** 自检：不保存；失败也 resolve（ok:false + 中文原因） */
  test(mirror: string): Promise<MirrorTestResult>;
}

export interface MirrorState {
  /** 已经成功（或尝试过）读过一次设置 */
  loaded: boolean;
  loading: boolean;
  /** 已保存的镜像（没有就是 undefined = 直连） */
  current: string | undefined;
  open: boolean;
  /** 输入框里的原文（首尾空白只在发请求前去掉，不改用户正在敲的字） */
  input: string;
  testing: boolean;
  /** 保存在途 */
  busy: boolean;
  /** 上次探测到的直连状态（D-B19；没探测过就是 undefined = 不显示那一行） */
  directStatus: DirectStatus | undefined;
  /** 上次探测到的镜像能力（D-B19） */
  mirrorCapabilities: MirrorCapabilities | undefined;
  result: MirrorTestResult | undefined;
  /** 保存失败的原因（宿主的中文 message），显示在对话框里且不关闭 */
  error: string | undefined;
  errors: readonly FieldError[];
}

export interface MirrorStore {
  readonly state: Store<MirrorState>;
  /** 读一次设置；失败只降级（标签按「没设置」显示），不打扰用户 */
  ensureLoaded(): Promise<void>;
  /** 打开对话框：填入当前值，清掉上一次的结果与错误 */
  open(): void;
  close(): void;
  setInput(value: string): void;
  test(): Promise<void>;
  /** 成功 → 返回 Toast 文案（并关闭对话框）；失败 → undefined（错误已进 state） */
  save(): Promise<string | undefined>;
}

/**
 * 一次读取 / 自检带回来的两路状态：只覆盖宿主这次真的给了的那一项。
 * 没给的那一路保留上一次的结论（旧事实比没有事实有用，界面也不会半行跳变）。
 */
function statusPatch(source: {
  directStatus?: DirectStatus | undefined;
  mirrorCapabilities?: MirrorCapabilities | undefined;
}): Partial<MirrorState> {
  const patch: Partial<MirrorState> = {};
  if (source.directStatus !== undefined) patch.directStatus = source.directStatus;
  if (source.mirrorCapabilities !== undefined) patch.mirrorCapabilities = source.mirrorCapabilities;
  return patch;
}

export function createMirrorStore(adapter: MirrorAdapter): MirrorStore {
  const state = createStore<MirrorState>({
    loaded: false,
    loading: false,
    current: undefined,
    open: false,
    input: "",
    testing: false,
    busy: false,
    directStatus: undefined,
    mirrorCapabilities: undefined,
    result: undefined,
    error: undefined,
    errors: [],
  });
  const clean = { result: undefined, error: undefined, errors: [] as readonly FieldError[] };
  /** 在途的那一次读取（并发调用共用它，不是各自发一遍） */
  let inFlight: Promise<void> | undefined;
  /** 每次打开对话框 +1：设置读回来得太晚时，只补进「这次打开、还没输入过」的对话框 */
  let openSeq = 0;

  const ensureLoaded = (): Promise<void> => {
    if (state.get().loaded) return Promise.resolve();
    if (inFlight !== undefined) return inFlight;
    const seqAtStart = openSeq;
    state.patch({ loading: true });
    inFlight = adapter.load().then(
      (settings) => {
        // D-B19：设置里带着上次探测到的两路状态，读回来就显示（没有 = 没探测过）
        state.patch({
          loading: false,
          loaded: true,
          current: settings.githubMirror,
          ...statusPatch(settings),
        });
        // 打开对话框时设置还没读回来（输入框是空的）→ 补填当前值，别让用户对着空框猜。
        const snapshot = state.get();
        if (snapshot.open && openSeq === seqAtStart && snapshot.input === "") {
          state.patch({ input: settings.githubMirror ?? "" });
        }
      },
      () => {
        // 读设置失败只降级：菜单标签按「没设置」显示，保存 / 测试时宿主会给出真正的原因。
        state.patch({ loading: false, loaded: true });
      },
    );
    void inFlight.finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    state,
    ensureLoaded,
    open() {
      const snapshot = state.get();
      openSeq += 1;
      state.patch({ ...clean, open: true, input: snapshot.current ?? "" });
      if (!snapshot.loaded) void ensureLoaded();
    },
    close() {
      state.patch({ ...clean, open: false, testing: false, busy: false });
    },
    setInput(value) {
      // 改了输入，上一次的自检结果与保存错误就不再对应当前内容了
      state.patch({ ...clean, input: value });
    },
    async test() {
      if (state.get().testing) return;
      state.patch({ ...clean, testing: true });
      const result = await adapter
        .test(trimMirrorInput(state.get().input))
        .catch((failure: unknown): MirrorTestResult => ({ ok: false, message: errorText(failure) }));
      // D-B19：这次探测到的两路结果一并换上（宿主没给的那一路保留上一次的结论）
      state.patch({
        testing: false,
        result,
        ...statusPatch({ directStatus: result.direct, mirrorCapabilities: result.mirror }),
      });
    },
    async save() {
      if (state.get().busy) return undefined;
      const value = trimMirrorInput(state.get().input);
      state.patch({ ...clean, busy: true });
      try {
        const saved = await adapter.save(value);
        state.patch({
          busy: false,
          open: false,
          loaded: true,
          current: saved.githubMirror,
          input: saved.githubMirror ?? "",
          // 保存后宿主会顺手探测一次并回写设置：拿到新的两路状态就换上
          ...statusPatch(saved),
        });
        return mirrorToastText(value);
      } catch (failure) {
        // 422 的 message 与逐字段 details 都留在对话框里，不关闭
        state.patch({ busy: false, error: errorText(failure), errors: fieldErrorsOf(failure) });
        return undefined;
      }
    },
  };
}
