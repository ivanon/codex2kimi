import { expect, test } from "vitest";
import { createApp } from "../src/server.js";
import type { Config } from "../src/config.js";

const CONFIG: Config = {
  host: "127.0.0.1", port: 8787, anthropicBaseUrl: "https://api.kimi.com/coding/",
  anthropicApiKey: "sk-test", model: "claude-x", maxTokensDefault: 8192,
  userAgent: "claude-cli/2.1.150 (external, cli)", logLevel: "info",
};

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const REQ = {
  model: "gpt-5-codex",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  stream: false,
};

test("GET /health returns ok", async () => {
  const app = createApp(CONFIG, { fetchImpl: jsonFetch({}), now: () => 1000 });
  const res = await app.request("/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "ok" });
});

test("non-stream request returns translated Responses JSON echoing codex model", async () => {
  const anthropic = {
    id: "msg_1", type: "message", role: "assistant", model: "claude-x",
    content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  };
  const app = createApp(CONFIG, { fetchImpl: jsonFetch(anthropic), now: () => 1000 });
  const res = await post(app, REQ);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { object: string; model: string; status: string };
  expect(json.object).toBe("response");
  expect(json.model).toBe("gpt-5-codex");
  expect(json.status).toBe("completed");
});

test("missing input returns 400 invalid_request_error", async () => {
  const app = createApp(CONFIG, { fetchImpl: jsonFetch({}), now: () => 1000 });
  const res = await post(app, { model: "gpt-5-codex" });
  expect(res.status).toBe(400);
  expect((await res.json()) as { error: { type: string } }).toMatchObject({
    error: { type: "invalid_request_error" },
  });
});

test("input with only system message yields 400 (empty anthropic messages)", async () => {
  const app = createApp(CONFIG, { fetchImpl: jsonFetch({}), now: () => 1000 });
  const res = await post(app, {
    model: "gpt-5-codex",
    input: [{ type: "message", role: "system", content: [{ type: "input_text", text: "sys only" }] }],
  });
  expect(res.status).toBe(400);
  expect((await res.json()) as { error: { type: string } }).toMatchObject({
    error: { type: "invalid_request_error" },
  });
});

test("upstream error is mapped with status preserved", async () => {
  const app = createApp(CONFIG, {
    fetchImpl: jsonFetch({ type: "error", error: { type: "authentication_error", message: "no" } }, 401),
    now: () => 1000,
  });
  const res = await post(app, REQ);
  expect(res.status).toBe(401);
  expect((await res.json()) as { error: { type: string } }).toMatchObject({
    error: { type: "authentication_error" },
  });
});

test("stream request pipes translated SSE with created and completed", async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const streamFetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(sse));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
  const app = createApp(CONFIG, { fetchImpl: streamFetch, now: () => 1000 });
  const res = await post(app, { ...REQ, stream: true });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  expect(text).toContain("event: response.created");
  expect(text).toContain("event: response.output_text.delta");
  expect(text).toContain("event: response.completed");
});

test("cancelling the response stream aborts upstream via onCancel", async () => {
  let aborted = false;
  const neverEndingFetch = ((url: string | URL, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => { aborted = true; });
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"claude-x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
              ),
            );
            // never closes
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
  }) as unknown as typeof fetch;
  const app = createApp(CONFIG, { fetchImpl: neverEndingFetch, now: () => 1000 });
  const res = await post(app, { ...REQ, stream: true });
  await res.body!.cancel();
  expect(aborted).toBe(true);
});

test("mid-stream abort yields response.incomplete (not failed)", async () => {
  const head =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n';
  const abortFetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(head));
        },
        pull() {
          const e = new Error("aborted");
          e.name = "AbortError";
          throw e;
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as unknown as typeof fetch;
  const app = createApp(CONFIG, { fetchImpl: abortFetch, now: () => 1000 });
  const res = await post(app, { ...REQ, stream: true });
  const text = await res.text();
  expect(text).toContain("event: response.incomplete");
  expect(text).not.toContain("event: response.failed");
});
