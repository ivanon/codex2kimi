import { expect, test } from "vitest";
import { createApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";

const ENABLED = process.env.CODEX2KIMI_INTEGRATION === "1";
const it = ENABLED ? test : test.skip;

function app() {
  return createApp(loadConfig());
}
function send(body: unknown) {
  return app().request("/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const TEXT_INPUT = [
  { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with the single word: ok" }] },
];

it("real Kimi: non-stream text round-trip returns completed", async () => {
  const res = await send({ model: "gpt-5-codex", stream: false, input: TEXT_INPUT });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { status: string; output: unknown[] };
  expect(json.status).toBe("completed");
  expect(json.output.length).toBeGreaterThan(0);
});

it("real Kimi: stream text yields created and completed events", async () => {
  const res = await send({ model: "gpt-5-codex", stream: true, input: TEXT_INPUT });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  expect(text).toContain("event: response.created");
  expect(text).toContain("event: response.completed");
});

it("real Kimi: tool call surfaces function_call output", async () => {
  const res = await send({
    model: "gpt-5-codex",
    stream: false,
    tool_choice: "required",
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Get weather by city",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Weather in SF? Use the tool." }] },
    ],
  });
  expect(res.status).toBe(200);
  const json = (await res.json()) as { output: { type: string }[] };
  expect(json.output.some((o) => o.type === "function_call")).toBe(true);
});
