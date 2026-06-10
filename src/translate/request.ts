import type {
  ResponsesContentPart,
  ResponsesInputItem,
} from "../types/responses.js";
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
} from "../types/anthropic.js";

export function inputImageToBlock(imageUrl: string): AnthropicImageBlock {
  const m = /^data:([^;]+);base64,(.*)$/.exec(imageUrl);
  if (m) {
    return { type: "image", source: { type: "base64", media_type: m[1]!, data: m[2]! } };
  }
  return { type: "image", source: { type: "url", url: imageUrl } };
}

function userPartsToBlocks(content: ResponsesContentPart[] | string): AnthropicContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "input_text" || part.type === "output_text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "input_image") {
      blocks.push(inputImageToBlock(part.image_url));
    }
  }
  return blocks;
}

export function buildMessages(input: ResponsesInputItem[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  for (const item of input) {
    if (item.type === "message") {
      if (item.role === "system" || item.role === "developer") continue; // 走 system
      const role = item.role; // "user" | "assistant"
      messages.push({ role, content: userPartsToBlocks(item.content) });
    } else if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: [
          { type: "tool_use", id: item.call_id, name: item.name, input: parseArgs(item.arguments) },
        ],
      });
    } else if (item.type === "function_call_output") {
      const content =
        typeof item.output === "string" ? item.output : JSON.stringify(item.output);
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: item.call_id, content }],
      });
    }
    // reasoning items：上游无需，忽略
  }
  return mergeAdjacentSameRole(messages);
}

function parseArgs(args: string): Record<string, unknown> {
  try {
    return args ? (JSON.parse(args) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function mergeAdjacentSameRole(messages: AnthropicMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const msg of messages) {
    const last = out[out.length - 1];
    if (last && last.role === msg.role) {
      last.content = [...last.content, ...msg.content];
    } else {
      out.push({ role: msg.role, content: [...msg.content] });
    }
  }
  return out;
}
