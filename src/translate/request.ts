import type {
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesRequest,
  ResponsesTool,
  ResponsesToolChoice,
} from "../types/responses.js";
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTool,
  AnthropicToolChoice,
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
      const blocks = userPartsToBlocks(item.content);
      if (blocks.length > 0) messages.push({ role: item.role, content: blocks });
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

// Anthropic tool_use.input 必须是对象；arguments 非法时以空对象兜底（有意的防御策略，
// 上游正常情况下保证 arguments 是合法 JSON）
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

export interface TranslateOptions {
  model: string;
  maxTokensDefault: number;
}

const REASONING_BUDGET: Record<string, number> = { low: 1024, medium: 4096, high: 16384 };

export function collectSystem(req: ResponsesRequest): string | undefined {
  const parts: string[] = [];
  if (req.instructions) parts.push(req.instructions);
  for (const item of req.input) {
    if (item.type === "message" && (item.role === "system" || item.role === "developer")) {
      const text =
        typeof item.content === "string"
          ? item.content
          : item.content
              .map((p) => ("text" in p ? p.text : ""))
              .filter(Boolean)
              .join("");
      if (text) parts.push(text);
    }
  }
  return parts.length ? parts.join("\n\n") : undefined;
}

export function mapTools(tools?: ResponsesTool[]): AnthropicTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export function mapToolChoice(tc?: ResponsesToolChoice): AnthropicToolChoice | undefined {
  if (tc === undefined) return undefined;
  if (tc === "auto") return { type: "auto" };
  if (tc === "required") return { type: "any" };
  if (tc === "none") return { type: "none" };
  return { type: "tool", name: tc.name };
}

export function mapReasoning(
  reasoning?: ResponsesRequest["reasoning"],
): AnthropicRequest["thinking"] | undefined {
  const effort = reasoning?.effort;
  if (!effort || effort === "none") return undefined;
  return { type: "enabled", budget_tokens: REASONING_BUDGET[effort] ?? 4096 };
}

export function translateRequest(req: ResponsesRequest, opts: TranslateOptions): AnthropicRequest {
  const out: AnthropicRequest = {
    model: opts.model,
    messages: buildMessages(req.input),
    max_tokens: req.max_output_tokens ?? opts.maxTokensDefault,
  };
  const system = collectSystem(req);
  if (system) out.system = system;
  if (req.temperature !== undefined) out.temperature = Math.min(req.temperature, 1);
  if (req.top_p !== undefined) out.top_p = req.top_p;
  const toolChoice = mapToolChoice(req.tool_choice);
  if (toolChoice) out.tool_choice = toolChoice;
  // tool_choice=none 时不带 tools，避免部分 Anthropic 兼容端拒绝
  const tools = req.tool_choice === "none" ? undefined : mapTools(req.tools);
  if (tools) out.tools = tools;
  const thinking = mapReasoning(req.reasoning);
  if (thinking) out.thinking = thinking;
  const userId = req.user ?? req.metadata?.user;
  if (userId) out.metadata = { user_id: userId };
  if (req.stream !== undefined) out.stream = req.stream;
  // presence_penalty / frequency_penalty：Anthropic 不支持，丢弃（不复制）
  // text.format：Kimi 支持度未确认，v1 不映射（已知限制，联调后再加）
  return out;
}
