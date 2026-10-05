/**
 * 任意抛出物 → 一句可以给人看的文字（宿主与浏览器两侧共用；ADR-0001 的共享区）。
 *
 * 接口错误（platform/client/api.ts 的 ApiError）与宿主的 HubError 的 message 都是中文，原样返回；
 * 没有 message 的 Error 退回它的 name；其余按字符串 / JSON 尽力而为。调用方要确保 message 本身不含令牌。
 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
