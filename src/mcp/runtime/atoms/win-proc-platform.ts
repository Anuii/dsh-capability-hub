/** 平台判定单独成文件，避免 win-proc.ts 出现循环依赖。 */
export const IS_WINDOWS = process.platform === "win32";
