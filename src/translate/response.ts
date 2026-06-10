import type {
  AnthropicResponse,
  AnthropicStopReason,
} from "../types/anthropic.js";
import type {
  ResponsesOutputItem,
  ResponsesResponse,
  ResponsesUsage,
} from "../types/responses.js";

export interface ResponseOptions {
  model: string;
  createdAt: number;
}

export function translateResponse(
  resp: AnthropicResponse,
  opts: ResponseOptions,
): ResponsesResponse {
  const output: ResponsesOutputItem[] = [];
  resp.content.forEach((block, i) => {
    const id = `${resp.id}-${i}`;
    if (block.type === "text") {
      output.push({
        type: "message",
        id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: block.text, annotations: [] }],
      });
    } else if (block.type === "tool_use") {
      output.push({
        type: "function_call",
        id,
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
        status: "completed",
      });
    } else if (block.type === "thinking") {
      output.push({
        type: "reasoning",
        id,
        summary: [{ type: "summary_text", text: block.thinking }],
      });
    }
  });

  const incomplete = resp.stop_reason === "max_tokens";
  return {
    id: resp.id,
    object: "response",
    created_at: opts.createdAt,
    status: incomplete ? "incomplete" : "completed",
    model: opts.model,
    output,
    parallel_tool_calls: true,
    incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
    usage: mapUsage(resp.usage),
    error: null,
  };
}

function mapUsage(u: AnthropicResponse["usage"]): ResponsesUsage {
  const usage: ResponsesUsage = {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    total_tokens: u.input_tokens + u.output_tokens,
  };
  if (u.cache_read_input_tokens !== undefined) {
    usage.input_tokens_details = { cached_tokens: u.cache_read_input_tokens };
  }
  return usage;
}

export type { AnthropicStopReason };
