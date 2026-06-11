import { expect, test } from "vitest";
import { translateResponse } from "../src/translate/response.js";
import type { AnthropicResponse } from "../src/types/anthropic.js";

const OPTS = { model: "gpt-5-codex", createdAt: 1000, parallelToolCalls: true };

function resp(overrides: Partial<AnthropicResponse>): AnthropicResponse {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-x",
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };
}

test("text content -> message output item, status completed", () => {
  const out = translateResponse(resp({ content: [{ type: "text", text: "hello" }] }), OPTS);
  expect(out.object).toBe("response");
  expect(out.status).toBe("completed");
  expect(out.model).toBe("gpt-5-codex");
  expect(out.created_at).toBe(1000);
  expect(out.output).toEqual([
    {
      type: "message",
      id: "msg_1-0",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "hello", annotations: [] }],
    },
  ]);
  expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
});

test("tool_use -> function_call output item with same call_id", () => {
  const out = translateResponse(
    resp({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "call_9", name: "f", input: { a: 1 } }],
    }),
    OPTS,
  );
  expect(out.status).toBe("completed");
  expect(out.output[0]).toEqual({
    type: "function_call",
    id: "msg_1-0",
    call_id: "call_9",
    name: "f",
    arguments: '{"a":1}',
    status: "completed",
  });
});

test("max_tokens -> incomplete with reason", () => {
  const out = translateResponse(
    resp({ stop_reason: "max_tokens", content: [{ type: "text", text: "x" }] }),
    OPTS,
  );
  expect(out.status).toBe("incomplete");
  expect(out.incomplete_details).toEqual({ reason: "max_output_tokens" });
});

test("thinking -> reasoning output item", () => {
  const out = translateResponse(
    resp({ content: [{ type: "thinking", thinking: "hmm" }] }),
    OPTS,
  );
  expect(out.output[0]).toEqual({
    type: "reasoning",
    id: "msg_1-0",
    summary: [{ type: "summary_text", text: "hmm" }],
  });
});

test("cache read tokens surfaced in usage details", () => {
  const out = translateResponse(
    resp({
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4 },
    }),
    OPTS,
  );
  expect(out.usage?.input_tokens_details).toEqual({ cached_tokens: 4 });
});

test("echoes parallel_tool_calls from options", () => {
  const out = translateResponse(resp({ content: [{ type: "text", text: "x" }] }), {
    model: "gpt-5-codex", createdAt: 1000, parallelToolCalls: false,
  });
  expect(out.parallel_tool_calls).toBe(false);
});
