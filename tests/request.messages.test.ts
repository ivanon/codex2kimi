import { expect, test } from "vitest";
import { buildMessages, mergeAdjacentSameRole, inputImageToBlock } from "../src/translate/request.js";
import type { ResponsesInputItem } from "../src/types/responses.js";

test("user input_text -> user text block", () => {
  const input: ResponsesInputItem[] = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ];
  expect(buildMessages(input)).toEqual([
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ]);
});

test("assistant output_text -> assistant text block", () => {
  const input: ResponsesInputItem[] = [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
  ];
  expect(buildMessages(input)).toEqual([
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ]);
});

test("function_call -> assistant tool_use with parsed input and same id", () => {
  const input: ResponsesInputItem[] = [
    { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"SF"}' },
  ];
  expect(buildMessages(input)).toEqual([
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } }],
    },
  ]);
});

test("function_call_output object output -> user tool_result stringified", () => {
  const input: ResponsesInputItem[] = [
    { type: "function_call_output", call_id: "call_1", output: { temp: 20 } },
  ];
  expect(buildMessages(input)).toEqual([
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: '{"temp":20}' }],
    },
  ]);
});

test("function_call_output string output -> tool_result string as-is", () => {
  const input: ResponsesInputItem[] = [
    { type: "function_call_output", call_id: "c", output: "done" },
  ];
  const msgs = buildMessages(input);
  expect(msgs[0]!.content[0]).toEqual({ type: "tool_result", tool_use_id: "c", content: "done" });
});

test("inputImageToBlock handles dataURI and http url", () => {
  expect(inputImageToBlock("data:image/png;base64,QUJD")).toEqual({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJD" },
  });
  expect(inputImageToBlock("https://x/y.png")).toEqual({
    type: "image",
    source: { type: "url", url: "https://x/y.png" },
  });
});

test("message with empty content is skipped (avoids Anthropic 400)", () => {
  expect(buildMessages([{ type: "message", role: "user", content: [] }])).toEqual([]);
});

test("mergeAdjacentSameRole merges consecutive same-role messages", () => {
  const merged = mergeAdjacentSameRole([
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "r" }] },
    { role: "user", content: [{ type: "text", text: "and also" }] },
    { role: "assistant", content: [{ type: "text", text: "x" }] },
  ]);
  expect(merged).toEqual([
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c", content: "r" },
        { type: "text", text: "and also" },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "x" }] },
  ]);
});
