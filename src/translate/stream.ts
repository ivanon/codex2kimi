import type {
  AnthropicStreamEvent,
  AnthropicResponse,
} from "../types/anthropic.js";
import type { ResponsesStreamEvent } from "../types/responses.js";

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
      default:
        return []; // tool/thinking/message_delta/message_stop/ping/error 在 Task 10 扩展
    }
  }

  protected startBlock(index: number, block: { type: string }): ResponsesStreamEvent[] {
    if (block.type === "text") {
      const itemId = `${this.responseId}-${index}`;
      const outputIndex = this.outputIndex++;
      this.blocks.set(index, { kind: "text", itemId, outputIndex, text: "", json: "" });
      return [
        this.evt("response.output_item.added", {
          output_index: outputIndex,
          item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] },
        }),
        this.evt("response.content_part.added", {
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      ];
    }
    return []; // 非 text 块在 Task 10 处理
  }

  protected onBlockDelta(
    index: number,
    delta: { type: string; text?: string; partial_json?: string; thinking?: string },
  ): ResponsesStreamEvent[] {
    const block = this.blocks.get(index);
    if (!block) return [];
    if (block.kind === "text" && delta.type === "text_delta") {
      block.text += delta.text ?? "";
      return [
        this.evt("response.output_text.delta", {
          item_id: block.itemId,
          output_index: block.outputIndex,
          content_index: 0,
          delta: delta.text ?? "",
        }),
      ];
    }
    return []; // tool_use/thinking delta 在 Task 10 处理
  }

  protected onBlockStop(index: number): ResponsesStreamEvent[] {
    const block = this.blocks.get(index);
    if (!block) return [];
    if (block.kind === "text") {
      return [
        this.evt("response.output_text.done", {
          item_id: block.itemId,
          output_index: block.outputIndex,
          content_index: 0,
          text: block.text,
        }),
        this.evt("response.output_item.done", {
          output_index: block.outputIndex,
          item: {
            type: "message",
            id: block.itemId,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: block.text, annotations: [] }],
          },
        }),
      ];
    }
    return []; // tool_use/thinking stop 在 Task 10 处理
  }
}
