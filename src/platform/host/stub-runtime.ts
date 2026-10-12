/**
 * 桩运行时：真实 mcp-runtime 不可用时（依赖缺失、SDK 没加载、模块装载失败……）顶上。
 *
 * 不注册任何工具、不往提示词里写东西——模型看不到坏掉的 MCP 工具，比看到一个只会报错的工具更好；
 * 不可用的原因在 health（降级横幅）与启动报告里。
 */
import type { McpRuntime } from "../../mcp/contract/runtime.ts";

export function createStubRuntime(options: { reason?: string } = {}): McpRuntime {
  const reason = options.reason ?? "mcp-runtime 未加载";
  return {
    tools: () => [],
    onToolsChange: () => () => {},
    promptText: () => "",
    async call(name: string): Promise<string> {
      throw new Error("能力中心：MCP 运行时不可用，" + name + " 不能调用（" + reason + "）。");
    },
    sessionStarted(): void {},
    async sessionEnded(): Promise<void> {},
    async dispose(): Promise<void> {},
  };
}
