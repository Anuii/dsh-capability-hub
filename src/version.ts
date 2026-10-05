/**
 * 插件版本号：由 build.mjs 用 esbuild 的 define 在构建时写进两份产物（宿主半与浏览器半）。
 * 单测直接跑源码时没有构建注入，取 "dev"（版本比对因此被跳过）。
 *
 * 用途：客户端把自己的版本与 health 里宿主报告的版本比对——不一致说明插件刚升级、
 * DSH 还在运行旧的宿主代码（浏览器半会热更新，宿主半要重启 DSH 才换），页头给出提示。
 */
declare const __HUB_VERSION__: string | undefined;

export const HUB_VERSION: string = typeof __HUB_VERSION__ === "string" ? __HUB_VERSION__ : "dev";
