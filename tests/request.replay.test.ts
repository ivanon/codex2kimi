import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { translateRequest } from "../src/translate/request.js";
import type { ResponsesRequest } from "../src/types/responses.js";

const OPTS = { model: "claude-x", maxTokensDefault: 8192 };

function loadRequest(name: string): ResponsesRequest {
  const raw = readFileSync(join(import.meta.dirname, "..", "fixtures", "responses", name), "utf8");
  return JSON.parse(raw) as ResponsesRequest;
}

test("text request fixture translates to a single user message with forced model", () => {
  const out = translateRequest(loadRequest("text.json"), OPTS);
  expect(out.model).toBe("claude-x");
  expect(out.max_tokens).toBe(8192);
  expect(out.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]);
});

test("tool-loop request fixture round-trips tool_use/tool_result with consistent ids", () => {
  const out = translateRequest(loadRequest("tool-loop.json"), OPTS);
  expect(out.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "weather in SF?" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"temp":20}' }] },
  ]);
});
