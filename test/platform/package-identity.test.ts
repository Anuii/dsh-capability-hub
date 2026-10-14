/**
 * 包身份的一致性守卫：包名只在 package.json 里写一次。
 *
 * DSH 靠包名认插件，三处必须永远一致：
 *   1. package.json 的 name —— 安装 / 升级的身份；
 *   2. cordis.patch.yml 里 insert 条目的 name —— DSH 按它加载包；
 *   3. 客户端 keyed slot 的 key 前缀 —— config-button.tsx 的 PACKAGE_NAME，构建时由 build.mjs
 *      以 define 注入 __HUB_PACKAGE__（src/version.ts），测试直接跑源码时取兜底值。
 *
 * 同时钉住**不能跟着包名一起改**的产品标识：接口前缀与数据目录。它们一旦被「顺手改名」，
 * 已装用户的 MCP 配置、来源记录、镜像设置就全部读不到了。
 *
 * .tsx 不能直接被 node 载入（同 test/platform/client/shell.test.ts），所以 config-button 的
 * 那几条按源码文本断言：值由构建注入，源码里只该有「取注入值」这一种写法。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";
import { HUB_PACKAGE } from "../../src/version.ts";
import { ROUTE_PREFIX } from "../../src/platform/host/router.ts";
import { API_PREFIX } from "../../src/platform/client/api.ts";
import { resolveHubContext } from "../../src/platform/host/hub-context.ts";
import type { PresetSkillsDir } from "../../src/platform/host/skill-roots.ts";

/** 这些用例里组合树是空的，没有预设声明要推导；被调用到就是夹具搭错了。 */
const noPreset = (): PresetSkillsDir => {
  throw new Error("不该推导预设目录");
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { name: string };
const configButton = fs.readFileSync(path.join(root, "src", "platform", "client", "config-button.tsx"), "utf8");

/** cordis.patch.yml 里 insert 的条目（只 insert，不写 config）。 */
interface PatchEntry {
  id?: unknown;
  name?: unknown;
}

const patch = YAML.parse(fs.readFileSync(path.join(root, "cordis.patch.yml"), "utf8")) as Array<{
  insert?: PatchEntry[];
}>;
const inserted = patch.flatMap((layer) => layer.insert ?? []);

test("cordis.patch.yml 只 insert 一个条目，name 就是 package.json 的 name", () => {
  assert.equal(inserted.length, 1, "包内 patch 只该有一个条目");
  assert.equal(inserted[0]!.name, pkg.name);
  assert.equal(inserted[0]!.id, "capability-hub");
});

test("客户端 keyed slot 的 key 前缀就是包名（构建注入失败时的兜底值也一样）", () => {
  assert.equal(HUB_PACKAGE, pkg.name, "src/version.ts 的兜底值必须与 package.json 一致");
  assert.ok(
    configButton.includes('import { HUB_PACKAGE } from "../../version.ts";'),
    "config-button 必须取构建注入的包名，不能自己再写一份字面量",
  );
  assert.ok(configButton.includes("export const PACKAGE_NAME = HUB_PACKAGE;"));
  assert.ok(configButton.includes('export const ROW_ID = "capability-hub";'));
  assert.ok(configButton.includes("export const ROW_CONFIG_KEY = `${PACKAGE_NAME}#${ROW_ID}`;"));
  // 包名不许再以字面量出现在这个文件里（注释里提到的除外，这里只查代码行的引号写法）
  assert.equal(configButton.includes('"dsh-capability-hub"'), false, "包名字面量不该再出现在客户端代码里");
});

test("产品标识不跟着包名走：接口前缀仍是 /api/dsh-capability-hub", () => {
  assert.equal(ROUTE_PREFIX, "/api/dsh-capability-hub");
  assert.equal(API_PREFIX, "api/dsh-capability-hub/");
  assert.equal(API_PREFIX, ROUTE_PREFIX.slice(1) + "/", "客户端前缀 = 宿主前缀去掉前导斜杠");
});

test("产品标识不跟着包名走：数据目录仍是 <dshHome>/storages/dsh-capability-hub", () => {
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const home = path.join(os.tmpdir(), "chub-identity");
  // resolveDshHome 认 DSH_HOME（与 DSH 的 resolveDshHome 一致）：本机跑测试时它可能已被设上，
  // 那样 hubHome 会落在真实用户目录上。这里临时清掉，只为让断言确定；结束后原样还回去。
  const savedDshHome = process.env.DSH_HOME;
  delete process.env.DSH_HOME;
  try {
    const ctx = resolveHubContext({}, { devOverrides: { enabled: true, homeDir: home } }, "pkg", silent, {
      env: {},
      resolvePresetSkillsDir: noPreset,
    });
    assert.equal(ctx.dshHome, path.join(home, ".dsh"));
    assert.equal(ctx.hubHome, path.join(home, ".dsh", "storages", "dsh-capability-hub"));
  } finally {
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
  }
  // 不管 DSH_HOME 指向哪里，目录名的最后两段都不变（产品标识，不跟包名走）。
  const ctx2 = resolveHubContext({}, {}, "pkg", silent, { env: {}, resolvePresetSkillsDir: noPreset });
  assert.deepEqual(ctx2.hubHome.split(path.sep).slice(-2), ["storages", "dsh-capability-hub"]);
});
