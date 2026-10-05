/**
 * HubContext 解析：各模块拿到的目录、profile、日志与技能目录来源。
 *
 * 取值口径：
 *   - homeDir：默认 os.homedir()；插件配置 devOverrides.enabled 为真时取 devOverrides.homeDir。
 *   - dshHome：默认 <homeDir>/.dsh；可用 DSH_HOME 环境变量覆盖（与 DSH 的 resolveDshHome 一致）。
 *   - profileName：从 ctx.profileContext.name 取；拿不到时用 "unknown"。
 *   - customSkillDirs / bundledSkillDir：见 skill-roots.ts；拿不到给空数组 / undefined，绝不抛错。
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { makeLogger, safeGet } from "./host-ctx.ts";
import { scanSkillRoots, type SkillRootsOptions } from "./skill-roots.ts";
import type { PlatformContext } from "./types.ts";
import type { HubLogger } from "../contract/host.ts";

/** 插件原始配置里属于平台层的部分。 */
export interface PlatformConfig {
  devOverrides?: {
    enabled?: boolean;
    homeDir?: string;
    /** 打开后启用「故意失败」的演示模块，用来验证降级不影响 DSH。 */
    failureDemo?: boolean;
    /**
     * 调试开关：让指定的真实模块在装载时**强制抛错**（降级验证用）。
     *
     * 只可能来自 dev profile 自己的 patch；包内 cordis.patch.yml 绝不写它。
     * 例：failModules: ['mcp-config'] ⇒ mcp-config 降级，且依赖它的 mcp-runtime 也降级，
     * mcp 工具退回桩实现（描述里写明原因）。见 docs/DEV.md「降级验证」。
     */
    failModules?: string[];
  };
}

/** 解析 dshHome：环境变量 DSH_HOME > <homeDir>/.dsh。 */
export function resolveDshHome(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DSH_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return resolve(fromEnv);
  return join(homeDir, ".dsh");
}

function readProfileContext(ctx: unknown): { name: string; dir: string } {
  const profile = safeGet(ctx, "profileContext") as { name?: unknown; dir?: unknown } | undefined;
  return {
    name: typeof profile?.name === "string" && profile.name !== "" ? profile.name : "unknown",
    dir: typeof profile?.dir === "string" ? profile.dir : "",
  };
}

/**
 * 构造 HubContext。
 * @param ctx DSH 插件上下文（根 ctx）
 * @param config 插件原始配置
 * @param packageRoot 本包宿主半目录（import.meta.dirname）
 * @param logger 已包好的日志面（可不传）
 */
export function resolveHubContext(
  ctx: unknown,
  config: PlatformConfig,
  packageRoot: string,
  logger?: HubLogger,
  skillRoots: SkillRootsOptions = {},
): PlatformContext {
  const log = logger ?? makeLogger(ctx);
  const overrides = config?.devOverrides;
  const overrideHome =
    overrides?.enabled === true && typeof overrides.homeDir === "string" && overrides.homeDir.trim() !== ""
      ? resolve(overrides.homeDir)
      : undefined;
  const homeDir = overrideHome ?? homedir();
  const dshHome = resolveDshHome(homeDir);
  const profile = readProfileContext(ctx);
  const skills = scanSkillRoots(ctx, skillRoots);
  log.info(
    `技能根来源：遍历 ${skills.scannedEntries} 个条目，命中 skill-filesystem ${skills.matched} 个（未停用 ${skills.active} 个）` +
      `，customSkillDirs ${skills.customSkillDirs.length} 个` +
      (skills.bundledSkillDir === undefined
        ? "，bundledSkillDir 未取到"
        : `，bundledSkillDir（${skills.bundledSource}）=${skills.bundledSkillDir}`),
  );
  for (const note of skills.contributions.filter((c) => c.disabled || c.note !== undefined)) {
    log.debug(`skill-filesystem 来源 ${note.kind}/${note.id}：${note.disabled ? "已停用" : (note.note ?? "已采用")}`);
  }
  return {
    homeDir,
    dshHome,
    hubHome: join(dshHome, "storages", "dsh-capability-hub"),
    profileName: profile.name,
    profileDir: profile.dir,
    packageRoot,
    logger: log,
    /**
     * 活值：每次读都重新扫组合树。agent 预设里的 skill-filesystem 是**按会话**挂载的，
     * 插件刚启动（还没有任何会话）时可能还看不到；静态快照会让目录永远停在启动那一刻。
     * 扫描没有 I/O 重活（本机 187 个条目）。
     */
    get customSkillDirs(): string[] {
      try {
        return scanSkillRoots(ctx, skillRoots).customSkillDirs;
      } catch {
        return [...skills.customSkillDirs];
      }
    },
    ...(skills.bundledSkillDir === undefined ? {} : { bundledSkillDir: skills.bundledSkillDir }),
  };
}
