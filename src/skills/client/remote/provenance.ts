/**
 * 数据来源（D-B19）的纯逻辑：把宿主给的 DataProvenance 折成搜索结果区那一行小字。
 *
 * 背景（使用者要求「网络无感」）：直连失败时宿主自动退镜像、都没有时用缓存并标注，
 * 而不是把网络错误摆到界面上。界面这边只做一件事——如实标出这批结果是怎么来的：
 *   - cache  → 「缓存于 2026-01-02 03:04」（没有时间就只说「缓存结果」）
 *   - mirror → 「经镜像 ghfast.top」
 *   - direct → 不显示（刚联网取到就是正常结果，安静）
 *
 * 不碰 DOM / React / 网络，node:test 直接测（test/skills/client/provenance.test.ts）。
 * 文案走 ../strings.ts 的 t()，所以测试断言的就是界面上真正会出现的字。
 */

import { formatDateTime } from "../format.ts";
import { t } from "../strings.ts";
import type { DataProvenance } from "../../../shared/network.ts";

const ROUTES: readonly string[] = ["direct", "mirror", "cache"];

function nonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 宿主给的 provenance → 契约形状（D-B19）。
 *
 * 形状不对（不是对象、route 不认识）就整条丢掉：按「没标来源」处理，绝不让界面崩。
 * at 缺失时留空串（cache 那一行退化成「缓存结果」），mirrorHost 只在非空时带上。
 */
export function normalizeProvenance(raw: unknown): DataProvenance | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const route = record["route"];
  if (typeof route !== "string" || !ROUTES.includes(route)) return undefined;
  const provenance: DataProvenance = { route: route as DataProvenance["route"], at: nonEmpty(record["at"]) };
  const host = nonEmpty(record["mirrorHost"]);
  if (host !== "") provenance.mirrorHost = host;
  return provenance;
}

/**
 * 结果区那一行小字；undefined = 不显示（直连，或者根本没有来源信息）。
 *
 * 纯函数、只依赖入参：同一个 provenance 永远给同一句话，方便单测与界面判断。
 */
export function provenanceNote(provenance: DataProvenance | undefined): string | undefined {
  if (provenance === undefined) return undefined;
  if (provenance.route === "cache") {
    const at = typeof provenance.at === "string" ? provenance.at.trim() : "";
    // 时间缺失或解析不了就只说「缓存结果」，绝不显示「缓存于 不是时间」这种半句。
    const known = at !== "" && !Number.isNaN(Date.parse(at));
    return known
      ? t("skills.remote.provenance.cache", { time: formatDateTime(at) })
      : t("skills.remote.provenance.cacheNoTime");
  }
  if (provenance.route === "mirror") {
    const host = nonEmpty(provenance.mirrorHost);
    return host === "" ? t("skills.remote.provenance.mirrorNoHost") : t("skills.remote.provenance.mirror", { host });
  }
  // direct（或将来多出来的路）：刚联网取到，正常结果，不打扰。
  return undefined;
}
