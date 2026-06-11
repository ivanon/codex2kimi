import { expect, test } from "vitest";
import { callUpstream } from "../src/upstream.js";
import type { Config } from "../src/config.js";
import type { AnthropicRequest } from "../src/types/anthropic.js";

const CONFIG: Config = {
  host: "127.0.0.1", port: 8787,
  anthropicBaseUrl: "https://api.kimi.com/coding/",
  anthropicApiKey: "sk-test", model: "claude-x",
  maxTokensDefault: 8192, userAgent: "claude-cli/2.1.150 (external, cli)", logLevel: "info",
};
const REQ: AnthropicRequest = { model: "claude-x", messages: [], max_tokens: 8 };

test("posts to v1/messages with disguise headers", async () => {
  let captured: { url: string; init: RequestInit } | null = null;
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    captured = { url: String(url), init: init! };
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  await callUpstream(REQ, CONFIG, { fetchImpl });
  expect(captured!.url).toBe("https://api.kimi.com/coding/v1/messages");
  const h = new Headers(captured!.init.headers);
  expect(h.get("x-api-key")).toBe("sk-test");
  expect(h.get("user-agent")).toBe("claude-cli/2.1.150 (external, cli)");
  expect(h.get("anthropic-version")).toBe("2023-06-01");
  expect(captured!.init.method).toBe("POST");
});

test("returns json result for application/json 2xx", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ id: "m" }), { status: 200, headers: { "content-type": "application/json" } });
  const res = await callUpstream(REQ, CONFIG, { fetchImpl });
  expect(res).toEqual({ kind: "json", status: 200, body: { id: "m" } });
});

test("returns stream result for text/event-stream 2xx", async () => {
  const body = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
  const fetchImpl = async () =>
    new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  const res = await callUpstream({ ...REQ, stream: true }, CONFIG, { fetchImpl });
  expect(res.kind).toBe("stream");
});

test("returns error result for non-2xx", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "no" } }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  const res = await callUpstream(REQ, CONFIG, { fetchImpl });
  expect(res).toMatchObject({ kind: "error", status: 401 });
});

test("normalizes base url without trailing slash (keeps path segment)", async () => {
  let capturedUrl = "";
  const fetchImpl = async (url: string | URL) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
  await callUpstream(REQ, { ...CONFIG, anthropicBaseUrl: "https://api.kimi.com/coding" }, { fetchImpl });
  expect(capturedUrl).toBe("https://api.kimi.com/coding/v1/messages");
});

test("connect timeout rejects when fetch never resolves", async () => {
  const fetchImpl = ((_url: string | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch;
  await expect(callUpstream(REQ, CONFIG, { fetchImpl, timeoutMs: 20 })).rejects.toBeTruthy();
});

test("connect timeout does not cut a slow streaming body after headers", async () => {
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      await new Promise((r) => setTimeout(r, 40)); // > timeoutMs
      c.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n"));
      c.close();
    },
  });
  const fetchImpl = (async () =>
    new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  const res = await callUpstream({ ...REQ, stream: true }, CONFIG, { fetchImpl, timeoutMs: 20 });
  expect(res.kind).toBe("stream");
  const stream = (res as { stream: ReadableStream<Uint8Array> }).stream;
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) { const { value, done } = await reader.read(); if (value) text += dec.decode(value); if (done) break; }
  expect(text).toContain("ping");
});
