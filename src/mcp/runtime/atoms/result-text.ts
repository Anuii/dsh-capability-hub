/**
 * 把 MCP 的 CallToolResult 整理成给模型的文本（D-D2 / F3-Q1 renderToolResult）。
 *
 * - 文本内容按出现顺序拼接；
 * - 图片 / 音频 / 资源 / 结构化结果等给**简短占位说明**（本网关只回文本，不转发像素）；
 * - isError 结果**原样返回**给模型，只标明这是服务器返回的错误（不抛异常、不吞掉内容）。
 */

export function projectContentItem(item: unknown): string {
  if (item === null || typeof item !== "object") return "";
  const block = item as Record<string, unknown>;
  const type = typeof block.type === "string" ? block.type : "unknown";
  switch (type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "image": {
      const mime = typeof block.mimeType === "string" ? block.mimeType : "未知类型";
      const data = typeof block.data === "string" ? block.data : "";
      const bytes = Math.floor((data.length * 3) / 4);
      return "[图片：" + mime + "，约 " + bytes + " 字节 —— 本网关只回文本，像素未转发]";
    }
    case "audio": {
      const mime = typeof block.mimeType === "string" ? block.mimeType : "未知类型";
      return "[音频：" + mime + " —— 本网关只回文本，音频未转发]";
    }
    case "resource": {
      const resource = block.resource as Record<string, unknown> | undefined;
      const uri = resource && typeof resource.uri === "string" ? resource.uri : "未知 uri";
      const text = resource && typeof resource.text === "string" ? resource.text : undefined;
      if (text !== undefined) return "[资源：" + uri + "]\n" + text;
      return "[资源：" + uri + " —— 二进制内容未转发]";
    }
    case "resource_link": {
      const uri = typeof block.uri === "string" ? block.uri : "未知 uri";
      return "[资源链接：" + uri + "]";
    }
    default:
      return "[未识别的返回块：" + type + "]";
  }
}

export interface RenderedResult {
  text: string;
  isError: boolean;
  structuredContent?: unknown;
}

export function renderCallToolResult(result: unknown): RenderedResult {
  if (result === null || typeof result !== "object") {
    return { text: "服务器返回了无法识别的结果：" + safeJson(result), isError: true };
  }
  const value = result as Record<string, unknown>;
  const isError = value.isError === true;
  const parts: string[] = [];
  const content = value.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      const text = projectContentItem(item);
      if (text.length > 0) parts.push(text);
    }
  } else if (content !== undefined) {
    parts.push(safeJson(content));
  }
  let body = parts.join("\n\n");
  if (body.length === 0) {
    if (value.structuredContent !== undefined) {
      body = "（该工具没有返回文本内容，只有结构化结果）\n" + safeJson(value.structuredContent);
    } else {
      body = "（该工具返回了空结果）";
    }
  }
  const rendered: RenderedResult = { text: body, isError };
  if (value.structuredContent !== undefined) rendered.structuredContent = value.structuredContent;
  return rendered;
}

export function safeJson(value: unknown): string {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}
