/**
 * 回收站条目 id 的合法性（纯函数；ADR-0008）。
 *
 * trashId 由宿主生成（时间戳 + 随机后缀），这里只做「安全单段名」判据：
 * 拒绝 `.` / `..`、以点开头的名字、含 `/` `\\` NUL 或控制字符、空串、超长（>64）。
 * 这样 `trash/<trashId>/` 只可能是回收站根下的一个直接子目录，绝无路径穿越。
 */

export const TRASH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidTrashId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "." || value === "..") return false;
  return TRASH_ID_PATTERN.test(value);
}
