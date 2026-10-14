/**
 * 插件版本号：由 build.mjs 用 esbuild 的 define 在构建时写进两份产物（宿主半与浏览器半）。
 * 单测直接跑源码时没有构建注入，取 "dev"（版本比对因此被跳过）。
 *
 * 用途：客户端把自己的版本与 health 里宿主报告的版本比对——不一致说明插件刚升级、
 * DSH 还在运行旧的宿主代码（浏览器半会热更新，宿主半要重启 DSH 才换），页头给出提示。
 */
declare const __HUB_VERSION__: string | undefined;
/**
 * 本包名（= package.json 的 name）：同样由 build.mjs 注入，只在 package.json 里写一次。
 *
 * 用途：keyed slot 的 key 是「<包名>#<行 id>」（config-button.tsx），DSH 靠它把行与包对上，
 * 所以包名必须与安装的包一致。单测直接跑源码时没有注入，退回兜底值（与 package.json 一致）。
 */
declare const __HUB_PACKAGE__: string | undefined;

export const HUB_VERSION: string = typeof __HUB_VERSION__ === "string" ? __HUB_VERSION__ : "dev";

export const HUB_PACKAGE: string = typeof __HUB_PACKAGE__ === "string" ? __HUB_PACKAGE__ : "dsh-capability-hub";
