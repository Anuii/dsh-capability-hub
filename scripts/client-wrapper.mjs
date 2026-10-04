/**
 * esbuild 辅助：把客户端产物包进 DSH 的「懒加载 CJS 工厂」封装。
 *
 * 依据（F2-Q1）：
 *   - DSH 浏览器侧用经典 <script> 投递每个包的 client 产物，产物执行时必须调用
 *     window.__ModuleLoader__.load({ id, factory }) 注册自己。官方与社区插件的
 *     产物都是这个形状（@deepseek-ai/dsh-client-ui-schedule/lib/client.js:1-14、
 *     @linxin666/dsh-client-ui-skill-explorer/lib/client.js:1-8）。
 *   - factory 收到的 require 就是 DSH 的模块表 require：它先查 9 个平台种子模块，
 *     再查已物化模块与已注册的包工厂，都miss就抛错。所以「外置」= 让 esbuild 保持
 *     require("x") 调用，交给这个 require 解析。
 *
 * 这里不引入 tsdown，只用 esbuild 的 ESM→CJS 转换再手工套壳：
 *   - 工厂只声明、不立即执行（懒加载语义与官方一致）；
 *   - 不改写 require，完全沿用 DSH 的解析与报错。
 */

/**
 * @param {string} code esbuild 以 format=cjs 产出的 bundle 正文
 * @param {{ id: string }} options
 * @returns {string} 完整的 client.js 文本
 */
export function wrapClientBundle(code, options) {
  const { id } = options;
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${code}
\t\treturn module.exports;
\t}
});
`;
}
