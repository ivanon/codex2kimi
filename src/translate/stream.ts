import type {
  AnthropicStreamEvent,
  AnthropicResponse,
} from "../types/anthropic.js";
import type { ResponsesStreamEvent } from "../types/responses.js";
import { mapErrorType } from "./error.js";

export interface StreamOptions {
  model: string;
  createdAt: number;
  parallelToolCalls: boolean;
}

type BlockKind = "text" | "tool_use" | "thinking";

interface BlockState {
  kind: BlockKind;
  itemId: string;
  outputIndex: number;
  text: string; // text / thinking 累积
  json: string; // tool_use 参数累积
  toolName?: string;
  toolId?: string;
}

export class StreamTranslator {
  private seq = 0;
  private outputIndex = 0;
  private responseId = "resp_unknown";
  private blocks = new Map<number, BlockState>();
  protected stopReason: AnthropicResponse["stop_reason"] = null;
  protected usage: { input_tokens: number; output_tokens: number } = {
    input_tokens: 0,
    output_tokens: 0,
  };
  protected outputItems: unknown[] = [];

  constructor(protected opts: StreamOptions) {}

  protected evt(type: string, fields: Record<string, unknown>): ResponsesStreamEvent {
    return { type, sequence_number: this.seq++, ...fields };
  }

  protected skeleton(status: string) {
    return {
      id: this.responseId,
      object: "response",
      created_at: this.opts.createdAt,
      status,
      model: this.opts.model,
      output: [] as unknown[],
      parallel_tool_calls: this.opts.parallelToolCalls,
    };
  }

  handle(event: AnthropicStreamEvent): ResponsesStreamEvent[] {
    switch (event.type) {
      case "message_start":
        this.responseId = event.message.id || this.responseId;
        this.usage.input_tokens = event.message.usage?.input_tokens ?? 0;
        return [
          this.evt("response.created", { response: this.skeleton("in_progress") }),
          this.evt("response.in_progress", { response: this.skeleton("in_progress") }),
        ];
      case "content_block_start":
        return this.startBlock(event.index, event.content_block);
      case "content_block_delta":
        return this.onBlockDelta(event.index, event.delta);
      case "content_block_stop":
        return this.onBlockStop(event.index);
      case "message_delta":
        this.stopReason = event.delta.stop_reason;
        if (event.usage?.output_tokens !== undefined) this.usage.output_tokens = event.usage.output_tokens;
        return [];
      case "message_stop":
        return [this.evt("response.completed", { response: this.finalResponse() })];
      case "ping":
        return [];
      case "error":
        return [this.evt("response.failed", {
          response: { ...this.skeleton("failed"), output: this.outputItems, error: { type: mapErrorType(event.error.type), message: event.error.message } },
        })];
      default:
        return [];
    }
  }

  protected startBlock(index: number, block: { type: string; id?: string; name?: string }): ResponsesStreamEvent[] {
    const itemId = `${this.responseId}-${index}`;
    const outputIndex = this.outputIndex++;
    if (block.type === "text") {
      this.blocks.set(index, { kind: "text", itemId, outputIndex, text: "", json: "" });
      return [
        this.evt("response.output_item.added", {
          output_index: outputIndex,
          item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] },
        }),
        this.evt("response.content_part.added", {
          item_id: itemId, output_index: outputIndex, content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      ];
    }
    if (block.type === "tool_use") {
      this.blocks.set(index, {
        kind: "tool_use", itemId, outputIndex, text: "", json: "",
        toolName: block.name, toolId: block.id,
      });
      return [
        this.evt("response.output_item.added", {
          output_index: outputIndex,
          item: { type: "function_call", id: itemId, call_id: block.id, name: block.name, arguments: "", status: "in_progress" },
        }),
      ];
    }
    if (block.type === "thinking") {
      this.blocks.set(index, { kind: "thinking", itemId, outputIndex, text: "", json: "" });
      return [
        this.evt("response.output_item.added", {
          output_index: outputIndex,
          item: { type: "reasoning", id: itemId, summary: [] },
        }),
      ];
    }
    return [];
  }

  protected onBlockDelta(
    index: number,
    delta: { type: string; text?: string; partial_json?: string; thinking?: string },
  ): ResponsesStreamEvent[] {
    const block = this.blocks.get(index);
    if (!block) return [];
    if (block.kind === "text" && delta.type === "text_delta") {
      block.text += delta.text ?? "";
      return [this.evt("response.output_text.delta", {
        item_id: block.itemId, output_index: block.outputIndex, content_index: 0, delta: delta.text ?? "",
      })];
    }
    if (block.kind === "tool_use" && delta.type === "input_json_delta") {
      block.json += delta.partial_json ?? "";
      return [this.evt("response.function_call_arguments.delta", {
        item_id: block.itemId, output_index: block.outputIndex, delta: delta.partial_json ?? "",
      })];
    }
    if (block.kind === "thinking" && delta.type === "thinking_delta") {
      block.text += delta.thinking ?? "";
      return [this.evt("response.reasoning_summary_text.delta", {
        item_id: block.itemId, output_index: block.outputIndex, delta: delta.thinking ?? "",
      })];
    }
    return [];
  }

  protected onBlockStop(index: number): ResponsesStreamEvent[] {
    const block = this.blocks.get(index);
    if (!block) return [];
    if (block.kind === "text") {
      const item = {
        type: "message", id: block.itemId, role: "assistant", status: "completed",
        content: [{ type: "output_text", text: block.text, annotations: [] }],
      };
      this.outputItems.push(item);
      return [
        this.evt("response.output_text.done", {
          item_id: block.itemId, output_index: block.outputIndex, content_index: 0, text: block.text,
        }),
        this.evt("response.output_item.done", { output_index: block.outputIndex, item }),
      ];
    }
    if (block.kind === "tool_use") {
      const item = {
        type: "function_call", id: block.itemId, call_id: block.toolId, name: block.toolName,
        arguments: block.json, status: "completed",
      };
      this.outputItems.push(item);
      return [
        this.evt("response.function_call_arguments.done", {
          item_id: block.itemId, output_index: block.outputIndex, arguments: block.json,
        }),
        this.evt("response.output_item.done", { output_index: block.outputIndex, item }),
      ];
    }
    if (block.kind === "thinking") {
      const item = { type: "reasoning", id: block.itemId, summary: [{ type: "summary_text", text: block.text }] };
      this.outputItems.push(item);
      return [
        this.evt("response.reasoning_summary_text.done", {
          item_id: block.itemId, output_index: block.outputIndex, text: block.text,
        }),
        this.evt("response.output_item.done", { output_index: block.outputIndex, item }),
      ];
    }
    return [];
  }

  protected finalResponse() {
    const status = this.stopReason === "max_tokens" ? "incomplete" : "completed";
    return {
      ...this.skeleton(status),
      output: this.outputItems,
      usage: {
        input_tokens: this.usage.input_tokens,
        output_tokens: this.usage.output_tokens,
        total_tokens: this.usage.input_tokens + this.usage.output_tokens,
      },
      incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    };
  }

  fail(message: string): ResponsesStreamEvent[] {
    return [this.evt("response.failed", {
      response: { ...this.skeleton("failed"), output: this.outputItems, error: { type: "api_error", message } },
    })];
  }

  incomplete(): ResponsesStreamEvent[] {
    return [this.evt("response.incomplete", {
      response: { ...this.skeleton("incomplete"), output: this.outputItems },
    })];
  }
}
