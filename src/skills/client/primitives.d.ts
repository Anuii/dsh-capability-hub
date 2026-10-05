/**
 * @deepseek-ai/dsh-client-ui-primitives 的类型占位。
 *
 * 事实（docs/PRIMITIVES.md P2/P3）：该包**不发布 .d.ts**，运行时也无 PropTypes，
 * 所以 TS 里 import 进来只能是 any —— 编译期不会校验任何 props，
 * 每个 props 都必须对照 docs/PRIMITIVES.md 逐项核对。
 *
 * 这里用「简写环境模块声明」而不是逐项 declare const：简写形式可以与其他
 * 目录（例如 T4b 的 mcp/runtime 标签页）的同名声明安全共存，
 * 逐项声明则会在两处同时存在时报「重复标识符」。
 */
declare module "@deepseek-ai/dsh-client-ui-primitives";
