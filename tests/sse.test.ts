import { expect, test } from "vitest";
import { parseSSEStream, serializeSSE } from "../src/sse.js";

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: { event?: string; data: string }[] = [];
  for await (const frame of parseSSEStream(stream)) out.push(frame);
  return out;
}

test("parses event + data frames split by blank line", async () => {
  const frames = await collect(
    streamFromChunks(["event: message_start\ndata: {\"a\":1}\n\n", "event: ping\ndata: {}\n\n"]),
  );
  expect(frames).toEqual([
    { event: "message_start", data: '{"a":1}' },
    { event: "ping", data: "{}" },
  ]);
});

test("reassembles a frame split across chunk boundaries", async () => {
  const frames = await collect(streamFromChunks(["event: content_block_de", "lta\ndata: {\"x\":", "5}\n\n"]));
  expect(frames).toEqual([{ event: "content_block_delta", data: '{"x":5}' }]);
});

test("joins multiple data: lines with newline", async () => {
  const frames = await collect(streamFromChunks(["data: line1\ndata: line2\n\n"]));
  expect(frames).toEqual([{ data: "line1\nline2" }]);
});

test("handles CRLF line endings and ignores comment lines", async () => {
  const frames = await collect(streamFromChunks([": keep-alive\r\nevent: ping\r\ndata: {}\r\n\r\n"]));
  expect(frames).toEqual([{ event: "ping", data: "{}" }]);
});

test("serializeSSE emits event + data + blank line", () => {
  expect(serializeSSE("response.created", { id: "r1" })).toBe(
    'event: response.created\ndata: {"id":"r1"}\n\n',
  );
});
