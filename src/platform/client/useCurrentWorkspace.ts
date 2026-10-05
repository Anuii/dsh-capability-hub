/**
 * useCurrentWorkspace()：当前会话的工作区绝对路径（PLAN §3.8 / V6）。
 *
 * 调研结论（已写进 docs/CLIENT-GUIDE.md）：
 *   - main slot 的 keyed 条目不绑定会话（slot 契约原文：only the reserved
 *     conversation key hosts the Conversation, other keys receive no Session binding），
 *     所以拿不到「当前会话」这种 owner prop。
 *   - 但 slot 组件会收到一组标准 props，其中 useSessions 是 SnapshotSelectorHook，
 *     读的是 sessions 客户端的 list 快照，形状为
 *     { ids: string[], byId: Record<string, { id, cwd?, parentId?, displayTitle, running,
 *       retainedBy: { mainView?: number } }>, phase }
 *     来源：@deepseek-ai/dsh-api-session-controller/lib/client.js:3496-3576（projectList）。
 *   - 本 hook 走的是同一条数据的服务面：ctx.get("sessions").list（ISession 的 list 源），
 *     与标准 prop useSessions 是同一个 observable，因此两者结果一致。
 *   - 「当前会话」= 被中央视图保留（retainedBy.mainView > 0）的那一个；没有就退化为
 *     唯一/最近的根会话。cwd 就是工作区绝对路径。
 *
 * 降级：拿不到服务时返回 undefined（并在 docs 里说明）。
 */
import { useCallback, useSyncExternalStore } from "react";

/** sessions list 快照里的单行。 */
export interface SessionRow {
  id?: string;
  cwd?: string;
  parentId?: string;
  running?: boolean;
  updatedAt?: number;
  retainedBy?: { mainView?: number };
}

/** sessions list 快照。 */
export interface SessionsSnapshot {
  ids?: string[];
  byId?: Record<string, SessionRow>;
  phase?: string;
}

/** 一个可订阅的快照源。 */
export interface SnapshotSource {
  getSnapshot(): SessionsSnapshot;
  subscribe(listener: () => void): () => void;
}

const EMPTY: SessionsSnapshot = { ids: [], byId: {} };

let resolveSource: (() => SnapshotSource | undefined) | undefined;

/** apply() 里接上会话服务；传 undefined 解除。 */
export function setSessionSource(next: (() => SnapshotSource | undefined) | undefined): void {
  resolveSource = next;
}

/** 从客户端 ctx 里取 sessions.list 源（拿不到返回 undefined）。 */
export function sessionSourceFromCtx(ctx: unknown): SnapshotSource | undefined {
  try {
    const get = (ctx as { get?: (name: string, strict?: boolean) => unknown })?.get;
    if (typeof get !== "function") return undefined;
    const service = get.call(ctx, "sessions", false) as { list?: SnapshotSource } | undefined;
    const list = service?.list;
    if (list !== undefined && typeof list.getSnapshot === "function" && typeof list.subscribe === "function") {
      return list;
    }
  } catch {
    /* 服务不存在时静默降级 */
  }
  return undefined;
}

/** 内部：读一次快照（源不可用时返回空快照）。 */
function readSnapshot(): SessionsSnapshot {
  try {
    const source = resolveSource?.();
    return source?.getSnapshot() ?? EMPTY;
  } catch {
    return EMPTY;
  }
}

/** 内部：订阅源变化；源暂不可用时退化为 1 秒轮询，直到服务出现。 */
function subscribeSource(listener: () => void): () => void {
  let dispose: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attach = (): void => {
    const source = resolveSource?.();
    if (source === undefined) {
      timer = setTimeout(() => {
        attach();
        listener();
      }, 1000);
      return;
    }
    dispose = source.subscribe(listener);
  };
  attach();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    dispose?.();
  };
}

/** 从快照里挑出「当前会话」的行。 */
export function pickCurrentSession(snapshot: SessionsSnapshot | undefined): SessionRow | undefined {
  if (snapshot === undefined) return undefined;
  const byId = snapshot.byId ?? {};
  const ids = snapshot.ids ?? Object.keys(byId);
  const rows = ids.map((id) => byId[id]).filter((row): row is SessionRow => row !== undefined);
  if (rows.length === 0) return undefined;
  const retained = rows.filter((row) => (row.retainedBy?.mainView ?? 0) > 0 && row.parentId === undefined);
  if (retained.length === 1) return retained[0];
  const roots = rows.filter((row) => row.parentId === undefined);
  const pool = roots.length > 0 ? roots : rows;
  if (pool.length === 1) return pool[0];
  return [...pool].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0];
}

/** 订阅会话列表快照（供内部与标签页复用）。 */
export function useSessionsSnapshot(): SessionsSnapshot {
  return useSyncExternalStore(subscribeSource, readSnapshot, readSnapshot);
}

/**
 * slot owner 提供的标准 prop：SnapshotSelectorHook。
 *
 * **实测结论（V6）**：客户端 ctx 上并没有 `sessions` 这个服务 —— applier 的诊断里
 * 永远是 "sessions: 服务缺失"。会话数据只能通过 slot 的标准 props 拿（owner 注入），
 * 所以这里的取值顺序是：props.useSessions（首选）→ ctx 服务（兜底）。
 */
export type SessionsHook = (selector: (state: SessionsSnapshot) => unknown) => unknown;

/**
 * 当前会话的 { workspace, sessionId }；拿不到就是空对象。
 *
 * 阶段 B 起，标签页拿到的 props 就是它算出来的（见 tab-props.ts）：
 *   - workspace → 技能页的项目级根 / MCP 页的项目级导入；
 *   - sessionId → 运行态页按会话过滤实例。
 * @param useSessions slot 标准 prop（可选；没有时退回 ctx 服务源）
 */
export function useCurrentSession(useSessions?: SessionsHook): { workspace?: string; sessionId?: string } {
  // 本地订阅总是调用，保证 hook 调用顺序稳定。
  const local = useSessionsSnapshot();
  let fromProps: SessionsSnapshot | undefined;
  if (useSessions !== undefined) {
    try {
      fromProps = useSessions((state) => state) as SessionsSnapshot | undefined;
    } catch {
      fromProps = undefined;
    }
  }
  const row = pickCurrentSession(fromProps ?? local);
  const cwd = row?.cwd;
  const id = row?.id;
  return {
    ...(typeof cwd === "string" && cwd !== "" ? { workspace: cwd } : {}),
    ...(typeof id === "string" && id !== "" ? { sessionId: id } : {}),
  };
}

/**
 * 当前会话的工作区绝对路径；拿不到返回 undefined。
 * @param useSessions slot 标准 prop（可选；没有时退回 ctx 服务源）
 */
export function useCurrentWorkspace(useSessions?: SessionsHook): string | undefined {
  return useCurrentSession(useSessions).workspace;
}

/** useCallback 兼容导出（部分标签页需要稳定回调）。 */
export { useCallback };
