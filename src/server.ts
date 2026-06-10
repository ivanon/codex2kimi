import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { serve } from "@hono/node-server";
import { loadConfig, type Config } from "./config.js";
import { parseSSEStream, serializeSSE } from "./sse.js";
import { translateRequest } from "./translate/request.js";
import { translateResponse } from "./translate/response.js";
import { translateError, badRequest } from "./translate/error.js";
import { StreamTranslator } from "./translate/stream.js";
import { callUpstream, type FetchImpl } from "./upstream.js";
import type { AnthropicStreamEvent } from "./types/anthropic.js";
import type { ResponsesRequest } from "./types/responses.js";
import { VERSION } from "./version.js";

export interface ServerDeps {
  fetchImpl?: FetchImpl;
  now?: () => number;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function pumpStream(
  upstream: ReadableStream<Uint8Array>,
  translator: StreamTranslator,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (events: ReturnType<StreamTranslator["handle"]>) => {
        for (const ev of events) controller.enqueue(encoder.encode(serializeSSE(ev.type, ev)));
      };
      try {
        for await (const frame of parseSSEStream(upstream)) {
          if (!frame.data) continue;
          const event = JSON.parse(frame.data) as AnthropicStreamEvent;
          emit(translator.handle(event));
        }
      } catch (err) {
        // 客户端断连/上游 abort → incomplete；解析或逻辑错误 → failed
        const aborted = err instanceof Error && err.name === "AbortError";
        emit(aborted ? translator.incomplete() : translator.fail(errMessage(err)));
      } finally {
        controller.close();
      }
    },
  });
}

export function createApp(config: Config, deps: ServerDeps = {}) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok", version: VERSION }));

  app.post("/v1/responses", async (c) => {
    let body: ResponsesRequest;
    try {
      body = (await c.req.json()) as ResponsesRequest;
    } catch {
      const { status, body: errBody } = badRequest("invalid JSON body");
      return c.json(errBody, status as ContentfulStatusCode);
    }
    if (!Array.isArray(body.input)) {
      const { status, body: errBody } = badRequest("missing required field: input");
      return c.json(errBody, status as ContentfulStatusCode);
    }

    const anthropicReq = translateRequest(body, {
      model: config.model,
      maxTokensDefault: config.maxTokensDefault,
    });

    if (anthropicReq.messages.length === 0) {
      const { status, body: errBody } = badRequest(
        "input must contain at least one user or assistant message",
      );
      return c.json(errBody, status as ContentfulStatusCode);
    }

    const upstream = await callUpstream(anthropicReq, config, {
      fetchImpl: deps.fetchImpl,
      signal: c.req.raw.signal,
    });

    if (upstream.kind === "error") {
      const { status, body: errBody } = translateError(upstream.body, upstream.status);
      return c.json(errBody, status as ContentfulStatusCode);
    }

    if (body.stream) {
      if (upstream.kind !== "stream") {
        const { status, body: errBody } = translateError(
          { error: { type: "api_error", message: "expected stream from upstream" } },
          502,
        );
        return c.json(errBody, status as ContentfulStatusCode);
      }
      const translator = new StreamTranslator({
        model: body.model,
        createdAt: now(),
        parallelToolCalls: body.parallel_tool_calls ?? true,
      });
      const rs = pumpStream(upstream.stream, translator);
      return new Response(rs, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    if (upstream.kind !== "json") {
      const { status, body: errBody } = translateError(
        { error: { type: "api_error", message: "expected json from upstream" } },
        502,
      );
      return c.json(errBody, status as ContentfulStatusCode);
    }
    const responsesBody = translateResponse(upstream.body as never, {
      model: body.model,
      createdAt: now(),
    });
    return c.json(responsesBody);
  });

  return app;
}

function main(): void {
  const config = loadConfig();
  const app = createApp(config);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`codex2kimi listening on http://${config.host}:${info.port}`);
  });
  process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  try {
    main();
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
