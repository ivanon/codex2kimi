import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { pumpStream } from "../src/server.js";
import { StreamTranslator } from "../src/translate/stream.js";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) out += dec.decode(value, { stream: true });
    if (done) break;
  }
  return out;
}

function replay(fixturePath: string) {
  const root = join(import.meta.dirname, "..");
  const fixture = readFileSync(join(root, fixturePath), "utf8");
  const translator = new StreamTranslator({ model: "gpt-5-codex", createdAt: 1000, parallelToolCalls: true });
  return drain(pumpStream(streamFromText(fixture), translator));
}

test("replays recorded anthropic text SSE into valid Responses stream", async () => {
  const out = await replay("fixtures/anthropic/stream/text.sse");
  expect(out).toContain("event: response.created");
  expect(out).toContain('"text":"Hello world"');
  expect(out).toContain("event: response.completed");
});

test("replays recorded tool_use SSE into function_call events", async () => {
  const out = await replay("fixtures/anthropic/stream/tools.sse");
  expect(out).toContain("event: response.function_call_arguments.delta");
  expect(out).toContain("event: response.function_call_arguments.done");
  expect(out).toContain('"call_id":"call_42"');
  expect(out).toContain("event: response.completed");
});
