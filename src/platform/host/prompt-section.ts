/**
 * 把运行时的「MCP 服务器」说明挂进 DSH 的系统提示词（ctx.systemPrompt.section，与官方 MCP 客户端同一做法）。
 *
 * 文字是活的（text 是函数，每次组装提示词时取），服务器或工具清单变化不需要重新挂；空串时 DSH 会丢掉这一段。
 * systemPrompt 服务可能晚于本插件出现，所以用 ctx.inject 等它；拿不到只降级（工具照样能用，只是少了说明）。
 */

import { safeGet } from "./host-ctx.ts";
import type { McpRuntime } from "../../mcp/contract/runtime.ts";
import type { HubLogger } from "../contract/host.ts";
import { errorText } from "../../shared/error-text.ts";

interface SystemPromptFace {
  section(options: { name: string; order: number; interpolate?: boolean; text: () => string }): unknown;
  getSectionOrder?(name: string): number;
}

export const PROMPT_SECTION_NAME = "capability-hub:mcp-servers";
/** 官方的 MCP_SERVERS 顺序拿不到时用的位置（在第一方指导之后、persona 后缀之前）。 */
const FALLBACK_ORDER = 9000;

export interface PromptSectionHandle {
  attached(): boolean;
  error(): string | undefined;
  dispose(): void;
}

export function attachMcpPromptSection(hostCtx: unknown, runtime: McpRuntime, logger: HubLogger): PromptSectionHandle {
  let attached = false;
  let failure: string | undefined;
  let release: (() => void) | undefined;
  const attach = (scoped: unknown): void => {
    if (attached) return;
    try {
      const service = (safeGet(scoped, "systemPrompt") ?? (scoped as { systemPrompt?: unknown })?.systemPrompt) as
        | SystemPromptFace
        | undefined;
      if (service === undefined || typeof service.section !== "function") throw new Error("systemPrompt 服务不可用");
      let order = FALLBACK_ORDER;
      try {
        if (typeof service.getSectionOrder === "function") order = service.getSectionOrder("MCP_SERVERS");
      } catch {
        // 没有这个具名位置就用默认位置
      }
      const result = service.section({
        name: PROMPT_SECTION_NAME,
        order,
        interpolate: false,
        text: () => {
          try {
            return runtime.promptText();
          } catch (error) {
            logger.warn("生成 MCP 服务器说明失败：" + errorText(error));
            return "";
          }
        },
      });
      if (typeof result === "function") release = result as () => void;
      attached = true;
      failure = undefined;
    } catch (error) {
      failure = errorText(error);
      logger.warn("MCP 服务器说明没能挂进系统提示词（工具不受影响）：" + failure);
    }
  };
  const inject = (hostCtx as { inject?: (names: string[], callback: (scoped: unknown) => void) => unknown })?.inject;
  if (typeof inject === "function") {
    try {
      inject.call(hostCtx, ["systemPrompt"], attach);
    } catch (error) {
      failure = errorText(error);
      logger.warn("等待 systemPrompt 服务失败：" + failure);
    }
  } else {
    attach(hostCtx);
  }
  return {
    attached: () => attached,
    error: () => failure,
    dispose(): void {
      try {
        release?.();
      } catch {
        // 作用域回收时 DSH 也会移除这一段
      }
      release = undefined;
      attached = false;
    },
  };
}
