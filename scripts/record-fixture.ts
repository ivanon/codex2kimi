// 用法：CODEX2KIMI_API_KEY=... npx tsx scripts/record-fixture.ts > fixtures/anthropic/stream/new.sse
// 直接打真实 Kimi 上游，把原始 Anthropic SSE 落盘（提交前按 fixtures/README.md 脱敏）。
import { loadConfig } from "../src/config.js";
import { translateRequest } from "../src/translate/request.js";
import { callUpstream } from "../src/upstream.js";

const config = loadConfig();
const sample = {
  model: "gpt-5-codex",
  stream: true,
  input: [{ type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text: "Say hello in 3 words." }] }],
};
const aReq = translateRequest(sample, { model: config.model, maxTokensDefault: config.maxTokensDefault });
const res = await callUpstream({ ...aReq, stream: true }, config);
if (res.kind !== "stream") {
  console.error("expected stream, got", res.kind, JSON.stringify(res));
  process.exit(1);
}
const reader = res.stream.getReader();
const dec = new TextDecoder();
for (;;) {
  const { value, done } = await reader.read();
  if (value) process.stdout.write(dec.decode(value, { stream: true }));
  if (done) break;
}
