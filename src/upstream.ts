import type { Config } from "./config.js";
import type { AnthropicRequest } from "./types/anthropic.js";

export type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface UpstreamDeps {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  timeoutMs?: number; // 默认 120s
}

export type UpstreamResult =
  | { kind: "stream"; status: number; stream: ReadableStream<Uint8Array> }
  | { kind: "json"; status: number; body: unknown }
  | { kind: "error"; status: number; body: unknown };

export async function callUpstream(
  req: AnthropicRequest,
  config: Config,
  deps: UpstreamDeps = {},
): Promise<UpstreamResult> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const base = config.anthropicBaseUrl.endsWith("/")
    ? config.anthropicBaseUrl
    : config.anthropicBaseUrl + "/";
  const url = new URL("v1/messages", base);
  const connect = new AbortController();
  const timer = setTimeout(
    () => connect.abort(new DOMException("upstream connect timeout", "TimeoutError")),
    deps.timeoutMs ?? 120000,
  );
  const signal = deps.signal ? AbortSignal.any([deps.signal, connect.signal]) : connect.signal;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "user-agent": config.userAgent,
      },
      body: JSON.stringify(req),
      signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const contentType = res.headers.get("content-type") ?? "";

  if (!res.ok) {
    const body = contentType.includes("application/json")
      ? await res.json().catch(() => res.text().catch(() => ""))
      : await res.text().catch(() => "");
    return { kind: "error", status: res.status, body };
  }

  if (contentType.includes("text/event-stream") && res.body) {
    return { kind: "stream", status: res.status, stream: res.body };
  }

  return { kind: "json", status: res.status, body: await res.json().catch(() => null) };
}
