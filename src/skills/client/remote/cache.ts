/**
 * 来源表 / 凭据的加载与去重（一次会话里只拉一次，写操作后强制刷新）。
 *
 * 组件只管调 ensureSources()/loadAuth()，不用关心并发：同一 workspace 的在途请求会被合并，
 * 换工作区或写操作后调 force=true 重新拉。
 */

import { fetchGithubAuth, listSources } from "./data.ts";
import { remoteStore } from "./store.ts";
import { errorText } from "../../../shared/error-text.ts";

let currentKey: string | undefined;
let loadingKey: string | undefined;
let generation = 0;

function keyOf(workspace: string | undefined): string {
  return workspace ?? "";
}

/** 拉来源表；已加载且工作区没变时直接返回。 */
export async function ensureSources(workspace: string | undefined, force = false): Promise<void> {
  const key = keyOf(workspace);
  const snapshot = remoteStore.state.get();
  if (!force && snapshot.sourcesLoaded && currentKey === key) return;
  if (!force && loadingKey === key) return;
  loadingKey = key;
  const generationAtStart = ++generation;
  remoteStore.state.patch({ sourcesLoading: true, sourcesError: undefined });
  try {
    const entries = await listSources(workspace);
    if (generationAtStart !== generation) return;
    currentKey = key;
    remoteStore.setSources(entries);
  } catch (error) {
    if (generationAtStart !== generation) return;
    remoteStore.state.patch({ sourcesLoading: false, sourcesError: errorText(error) });
  } finally {
    if (loadingKey === key) loadingKey = undefined;
  }
}

/** 写操作后强制重拉。 */
export function reloadSources(workspace: string | undefined): Promise<void> {
  return ensureSources(workspace, true);
}

/** 读一次 GitHub 凭据模式（只返回模式与剩余配额，绝不含令牌）。 */
export async function loadAuth(): Promise<void> {
  try {
    const auth = await fetchGithubAuth();
    remoteStore.setAuth(auth.mode, auth.rateLimitRemaining);
  } catch {
    // 凭据模式拿不到不影响主流程（界面上显示「未知」）
  }
}
