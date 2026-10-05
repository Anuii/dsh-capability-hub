/**
 * Windows 进程查询输出的解析（纯函数，便于单测）。
 */
import { IS_WINDOWS } from "./win-proc-platform.ts";

export { IS_WINDOWS };

/** CSV 行解析：支持双引号包裹与 "" 转义。 */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export interface TasklistRow {
  image: string;
  pid: number;
}

/**
 * 解析 `tasklist /NH /FO CSV` 输出。
 * 关键点：杀完进程后 tasklist 会打印 `信息: 没有运行的任务匹配指定标准。` 这类提示行，
 * 必须按「至少 2 个字段且第 2 个字段是纯数字」判定，否则会把提示当进程。
 */
export function parseTasklistCsv(text: string): TasklistRow[] {
  const rows: TasklistRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.startsWith('"')) continue;
    const fields = parseCsvLine(line);
    if (fields.length < 2) continue;
    const pidText = fields[1].trim();
    if (!/^\d+$/.test(pidText)) continue;
    rows.push({ image: fields[0], pid: Number(pidText) });
  }
  return rows;
}
