import { expect, test } from "vitest";
import { StreamTranslator } from "../src/translate/stream.js";
import type { AnthropicStreamEvent } from "../src/types/anthropic.js";

const OPTS = { model: "gpt-5-codex", createdAt: 1000, parallelToolCalls: true };

function run(events: AnthropicStreamEvent[]) {
  const t = new StreamTranslator(OPTS);
  const out = events.flatMap((e) => t.handle(e));
  return out;
}

const START: AnthropicStreamEvent = {
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-x",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 0 },
  },
};

test("message_start emits created then in_progress with skeleton", () => {
  const out = run([START]);
  expect(out.map((e) => e.type)).toEqual(["response.created", "response.in_progress"]);
  expect(out[0]!.sequence_number).toBe(0);
  expect(out[1]!.sequence_number).toBe(1);
  const r = (out[0]! as unknown as { response: { id: string; status: string; model: string } }).response;
  expect(r.id).toBe("msg_1");
  expect(r.status).toBe("in_progress");
  expect(r.model).toBe("gpt-5-codex");
});

test("text block emits full ordered sequence", () => {
  const out = run([
    START,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "He" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "llo" } },
    { type: "content_block_stop", index: 0 },
  ]);
  expect(out.map((e) => e.type)).toEqual([
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.output_item.done",
  ]);
  const done = out.find((e) => e.type === "response.output_text.done") as unknown as { text: string };
  expect(done.text).toBe("Hello");
  expect(out.map((e) => e.sequence_number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
});

test("output_item.added carries message item with output_index 0", () => {
  const out = run([
    START,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ]);
  const added = out.find((e) => e.type === "response.output_item.added") as unknown as {
    output_index: number;
    item: { type: string; role: string; id: string };
  };
  expect(added.output_index).toBe(0);
  expect(added.item.type).toBe("message");
  expect(added.item.role).toBe("assistant");
  expect(added.item.id).toBe("msg_1-0");
});
