/**
 * 搜索结果「是怎么来的」的纯逻辑（D-B19，界面侧）：normalizeProvenance 与 provenanceNote。
 *
 * 覆盖使用者提的四条：缓存带时间、镜像带主机名、直连不显示、字段缺失时不崩。
 * 断言的是界面上真正会出现的那句话（文案从 strings.ts 取），不碰 DOM / React / 网络。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProvenance, provenanceNote } from "../../../src/skills/client/remote/provenance.ts";
import { t } from "../../../src/skills/client/strings.ts";
import type { DataProvenance } from "../../../src/shared/network.ts";

/** 本地时间 2026-01-02 03:04 的 ISO（避免时区把断言弄歪）。 */
const AT = new Date(2026, 0, 2, 3, 4, 5).toISOString();

test("cache：标出缓存时刻（本地时间）", () => {
  assert.equal(
    provenanceNote({ route: "cache", at: AT }),
    t("skills.remote.provenance.cache", { time: "2026-01-02 03:04" }),
  );
});

test("cache：时间缺失或解析不了就只说「缓存结果」", () => {
  assert.equal(provenanceNote({ route: "cache", at: "" }), t("skills.remote.provenance.cacheNoTime"));
  assert.equal(provenanceNote({ route: "cache", at: "   " }), t("skills.remote.provenance.cacheNoTime"));
  assert.equal(provenanceNote({ route: "cache", at: "不是时间" }), t("skills.remote.provenance.cacheNoTime"));
  assert.equal(
    provenanceNote({ route: "cache", at: undefined as unknown as string }),
    t("skills.remote.provenance.cacheNoTime"),
    "字段缺失也不许崩",
  );
});

test("mirror：带镜像主机名；没给主机名就只说「经镜像」", () => {
  assert.equal(
    provenanceNote({ route: "mirror", at: AT, mirrorHost: "ghfast.top" }),
    t("skills.remote.provenance.mirror", { host: "ghfast.top" }),
  );
  assert.equal(
    provenanceNote({ route: "mirror", at: AT, mirrorHost: "  ghfast.top  " }),
    t("skills.remote.provenance.mirror", { host: "ghfast.top" }),
    "主机名首尾空白去掉",
  );
  assert.equal(provenanceNote({ route: "mirror", at: AT }), t("skills.remote.provenance.mirrorNoHost"));
  assert.equal(
    provenanceNote({ route: "mirror", at: AT, mirrorHost: "  " }),
    t("skills.remote.provenance.mirrorNoHost"),
  );
});

test("direct / 没有来源：安静，不显示任何小字", () => {
  assert.equal(provenanceNote({ route: "direct", at: AT }), undefined);
  assert.equal(provenanceNote(undefined), undefined);
});

test("正常形状原样保留；route 不认识、不是对象就整条丢掉", () => {
  assert.deepEqual(normalizeProvenance({ route: "cache", at: AT }), { route: "cache", at: AT });
  assert.deepEqual(normalizeProvenance({ route: "mirror", at: AT, mirrorHost: "ghfast.top" }), {
    route: "mirror",
    at: AT,
    mirrorHost: "ghfast.top",
  });
  assert.deepEqual(normalizeProvenance({ route: "mirror", at: AT, mirrorHost: "   " }), { route: "mirror", at: AT });
  assert.deepEqual(normalizeProvenance({ route: "cache" }), { route: "cache", at: "" }, "at 缺失留空串，不崩");
  assert.equal(normalizeProvenance({ route: "卫星" }), undefined);
  assert.equal(normalizeProvenance({ at: AT }), undefined);
  assert.equal(normalizeProvenance(null), undefined);
  assert.equal(normalizeProvenance("cache"), undefined);
  assert.equal(normalizeProvenance(undefined), undefined);
});

test("归一化之后再出文案：脏数据只会少一行字，不会抛错", () => {
  const dirty: unknown[] = [
    { route: "cache" },
    { route: "cache", at: 42 },
    { route: "mirror", at: AT, mirrorHost: 7 },
    { route: "direct", at: AT },
    { route: "nope" },
    null,
    "x",
  ];
  for (const raw of dirty) {
    const provenance: DataProvenance | undefined = normalizeProvenance(raw);
    assert.doesNotThrow(() => provenanceNote(provenance));
  }
  assert.equal(
    provenanceNote(normalizeProvenance({ route: "cache", at: 42 })),
    t("skills.remote.provenance.cacheNoTime"),
  );
  assert.equal(
    provenanceNote(normalizeProvenance({ route: "mirror", at: AT, mirrorHost: 7 })),
    t("skills.remote.provenance.mirrorNoHost"),
  );
});
