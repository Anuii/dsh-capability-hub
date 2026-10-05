/**
 * kit 用到的宿主模块的类型补齐。
 *
 * react-dom 是平台种子模块之一（build.mjs 的 SEED_MODULES），运行期由宿主提供、
 * 由 esbuild 外置（见 CLIENT-GUIDE 第 1 节），但本仓库没有装 @types/react-dom，
 * 所以在这里给它一个最小的环境声明 —— 只用 createPortal（抽屉要挂到 body 上，
 * 才能躲开祖先容器的 overflow / stacking context）。
 */
declare module "react-dom" {
  export function createPortal(
    children: import("react").ReactNode,
    container: Element | DocumentFragment,
    key?: string | number | null,
  ): import("react").ReactPortal;
}
