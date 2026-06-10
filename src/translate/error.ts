import type { ResponsesError } from "../types/responses.js";

export interface ResponsesErrorBody {
  error: ResponsesError;
}

const TYPE_MAP: Record<string, string> = {
  invalid_request_error: "invalid_request_error",
  authentication_error: "authentication_error",
  permission_error: "permission_error",
  rate_limit_error: "rate_limit_error",
  api_error: "api_error",
  overloaded_error: "api_error",
};

// 供流式 error 分支复用，保证流式/非流式 error type 一致
export function mapErrorType(anthropicType: string): string {
  return TYPE_MAP[anthropicType] ?? "api_error";
}

export function translateError(
  anthropicBody: unknown,
  upstreamStatus: number,
): { status: number; body: ResponsesErrorBody } {
  const err = extractAnthropicError(anthropicBody);
  if (!err) {
    return {
      status: upstreamStatus || 500,
      body: { error: { type: "api_error", message: "upstream error", code: null } },
    };
  }
  return {
    status: upstreamStatus || 500,
    body: {
      error: {
        type: mapErrorType(err.type),
        message: err.message,
        code: null,
      },
    },
  };
}

function extractAnthropicError(body: unknown): { type: string; message: string } | null {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: { type?: string; message?: string } }).error;
    if (e?.type && e?.message) return { type: e.type, message: e.message };
  }
  return null;
}

export function badRequest(message: string): { status: number; body: ResponsesErrorBody } {
  return { status: 400, body: { error: { type: "invalid_request_error", message, code: null } } };
}
