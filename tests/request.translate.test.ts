import { expect, test } from "vitest";
import { translateRequest } from "../src/translate/request.js";
import type { ResponsesRequest } from "../src/types/responses.js";

const OPTS = { model: "claude-x", maxTokensDefault: 8192 };

function base(overrides: Partial<ResponsesRequest> = {}): ResponsesRequest {
  return {
    model: "gpt-5-codex",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    ...overrides,
  };
}

test("forces configured model and default max_tokens", () => {
  const out = translateRequest(base(), OPTS);
  expect(out.model).toBe("claude-x");
  expect(out.max_tokens).toBe(8192);
});

test("max_output_tokens overrides default", () => {
  expect(translateRequest(base({ max_output_tokens: 100 }), OPTS).max_tokens).toBe(100);
});

test("instructions and system messages combine into system", () => {
  const out = translateRequest(
    base({
      instructions: "be brief",
      input: [
        { type: "message", role: "system", content: [{ type: "input_text", text: "you are X" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    }),
    OPTS,
  );
  expect(out.system).toBe("be brief\n\nyou are X");
  expect(out.messages).toHaveLength(1);
});

test("clamps temperature to <=1 and passes top_p, drops penalties", () => {
  const out = translateRequest(
    base({ temperature: 1.8, top_p: 0.9, presence_penalty: 1, frequency_penalty: 1 }),
    OPTS,
  );
  expect(out.temperature).toBe(1);
  expect(out.top_p).toBe(0.9);
  expect(out).not.toHaveProperty("presence_penalty");
  expect(out).not.toHaveProperty("frequency_penalty");
});

test("maps tools to anthropic input_schema", () => {
  const out = translateRequest(
    base({ tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object" } }] }),
    OPTS,
  );
  expect(out.tools).toEqual([{ name: "f", description: "d", input_schema: { type: "object" } }]);
});

test("maps tool_choice variants", () => {
  expect(translateRequest(base({ tool_choice: "required" }), OPTS).tool_choice).toEqual({ type: "any" });
  expect(translateRequest(base({ tool_choice: "auto" }), OPTS).tool_choice).toEqual({ type: "auto" });
  expect(translateRequest(base({ tool_choice: "none" }), OPTS).tool_choice).toEqual({ type: "none" });
  expect(
    translateRequest(base({ tool_choice: { type: "function", name: "f" } }), OPTS).tool_choice,
  ).toEqual({ type: "tool", name: "f" });
});

test("tool_choice none strips tools to avoid upstream 400", () => {
  const out = translateRequest(
    base({
      tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
      tool_choice: "none",
    }),
    OPTS,
  );
  expect(out.tool_choice).toEqual({ type: "none" });
  expect(out.tools).toBeUndefined();
});

test("maps reasoning effort to thinking budget", () => {
  expect(translateRequest(base({ reasoning: { effort: "medium" } }), OPTS).thinking).toEqual({
    type: "enabled",
    budget_tokens: 4096,
  });
  expect(translateRequest(base({ reasoning: { effort: "none" } }), OPTS).thinking).toBeUndefined();
});

test("maps user to metadata.user_id", () => {
  expect(translateRequest(base({ user: "u1" }), OPTS).metadata).toEqual({ user_id: "u1" });
});

test("sets stream flag through", () => {
  expect(translateRequest(base({ stream: true }), OPTS).stream).toBe(true);
});

test("raises max_tokens above thinking budget to satisfy Anthropic", () => {
  const out = translateRequest(base({ reasoning: { effort: "high" } }), OPTS);
  expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
  expect(out.max_tokens).toBeGreaterThan(16384);
});

test("does not lower an already-sufficient max_tokens for thinking", () => {
  const out = translateRequest(base({ reasoning: { effort: "low" }, max_output_tokens: 8192 }), OPTS);
  expect(out.max_tokens).toBe(8192); // budget 1024 < 8192, no change
});
