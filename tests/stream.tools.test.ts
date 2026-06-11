import { expect, test } from "vitest";
import { StreamTranslator } from "../src/translate/stream.js";
import type { AnthropicStreamEvent } from "../src/types/anthropic.js";

const OPTS = { model: "gpt-5-codex", createdAt: 1000, parallelToolCalls: true };
const START: AnthropicStreamEvent = {
  type: "message_start",
  message: {
    id: "msg_1", type: "message", role: "assistant", model: "claude-x",
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 0 },
  },
};

function run(events: AnthropicStreamEvent[]) {
  const t = new StreamTranslator(OPTS);
  return events.flatMap((e) => t.handle(e));
}

test("tool_use block emits added/args.delta/args.done/item.done", () => {
  const out = run([
    START,
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_7", name: "f", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":' } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "1}" } },
    { type: "content_block_stop", index: 0 },
  ]);
  expect(out.map((e) => e.type)).toEqual([
    "response.created", "response.in_progress",
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.done",
  ]);
  const added = out.find((e) => e.type === "response.output_item.added") as unknown as { item: { type: string; call_id: string; name: string } };
  expect(added.item).toMatchObject({ type: "function_call", call_id: "call_7", name: "f" });
  const argsDone = out.find((e) => e.type === "response.function_call_arguments.done") as unknown as { arguments: string };
  expect(argsDone.arguments).toBe('{"a":1}');
});

test("thinking block emits reasoning item and summary deltas", () => {
  const out = run([
    START,
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ho" } },
    { type: "content_block_stop", index: 0 },
  ]);
  expect(out.map((e) => e.type)).toEqual([
    "response.created", "response.in_progress",
    "response.output_item.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.output_item.done",
  ]);
  const added = out.find((e) => e.type === "response.output_item.added") as unknown as { item: { type: string } };
  expect(added.item.type).toBe("reasoning");
});

test("message_stop emits response.completed with output and usage", () => {
  const out = run([
    START,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ]);
  const completed = out.find((e) => e.type === "response.completed") as unknown as {
    response: { status: string; output: unknown[]; usage: { output_tokens: number; total_tokens: number } };
  };
  expect(completed.response.status).toBe("completed");
  expect(completed.response.output).toHaveLength(1);
  expect(completed.response.usage.output_tokens).toBe(7);
  expect(completed.response.usage.total_tokens).toBe(10);
});

test("max_tokens stop_reason emits response.incomplete event", () => {
  const out = run([
    START,
    { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
  const ev = out.find((e) => e.type === "response.incomplete") as unknown as { response: { status: string } };
  expect(ev).toBeTruthy();
  expect(ev.response.status).toBe("incomplete");
  expect(out.find((e) => e.type === "response.completed")).toBeUndefined();
});

test("ping is swallowed", () => {
  const t = new StreamTranslator(OPTS);
  expect(t.handle({ type: "ping" })).toEqual([]);
});

test("error event maps to response.failed with mapped error type", () => {
  const t = new StreamTranslator(OPTS);
  t.handle(START);
  const out = t.handle({ type: "error", error: { type: "overloaded_error", message: "busy" } });
  expect(out[0]!.type).toBe("response.failed");
  const r = (out[0] as unknown as { response: { error: { type: string } } }).response;
  expect(r.error.type).toBe("api_error");
});

test("incomplete() helper emits response.incomplete for mid-stream break", () => {
  const t = new StreamTranslator(OPTS);
  t.handle(START);
  const out = t.incomplete();
  expect(out[0]!.type).toBe("response.incomplete");
});

test("unknown content block type does not consume an output_index", () => {
  const out = run([
    START,
    { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking" } as never },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  ]);
  const added = out.find((e) => e.type === "response.output_item.added") as unknown as { output_index: number };
  expect(added.output_index).toBe(0); // text block got index 0, not 1
});

test("error after a completed block includes accumulated output in failed response", () => {
  const t = new StreamTranslator(OPTS);
  t.handle(START);
  t.handle({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  t.handle({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } });
  t.handle({ type: "content_block_stop", index: 0 });
  const out = t.handle({ type: "error", error: { type: "api_error", message: "boom" } });
  const r = (out[0] as unknown as { response: { output: unknown[] } }).response;
  expect(r.output).toHaveLength(1);
});
