// OpenAI Responses API（/v1/responses）—— 仅覆盖本代理需要的子集

export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: ResponsesToolChoice;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  reasoning?: { effort?: "none" | "low" | "medium" | "high" };
  parallel_tool_calls?: boolean;
  text?: { format?: ResponsesTextFormat };
  metadata?: Record<string, string>;
  user?: string;
  stream?: boolean;
  truncation?: string;
  store?: boolean;
  previous_response_id?: string;
}

export type ResponsesTextFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name?: string; schema: Record<string, unknown>; strict?: boolean };

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem;

export interface ResponsesMessageItem {
  type: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: ResponsesContentPart[] | string;
}

export type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string; annotations?: unknown[] }
  | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" };

export interface ResponsesFunctionCallItem {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string; // JSON 字符串
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string | Record<string, unknown> | unknown[];
}

export interface ResponsesReasoningItem {
  type: "reasoning";
  summary?: { type: "summary_text"; text: string }[];
}

export interface ResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>; // JSON Schema
  strict?: boolean;
}

export type ResponsesToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string };

// ---- 响应（非流式）----

export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  status: "completed" | "incomplete" | "failed" | "in_progress";
  model: string;
  output: ResponsesOutputItem[];
  parallel_tool_calls: boolean;
  incomplete_details?: { reason: string } | null;
  usage?: ResponsesUsage;
  error?: ResponsesError | null;
}

export type ResponsesOutputItem =
  | {
      type: "message";
      id: string;
      role: "assistant";
      status: "completed" | "in_progress";
      content: { type: "output_text"; text: string; annotations: unknown[] }[];
    }
  | {
      type: "function_call";
      id: string;
      call_id: string;
      name: string;
      arguments: string;
      status: "completed" | "in_progress";
    }
  | {
      type: "reasoning";
      id: string;
      summary: { type: "summary_text"; text: string }[];
    };

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens: number };
  output_tokens_details?: { reasoning_tokens: number };
}

export interface ResponsesError {
  type: string;
  message: string;
  code?: string | null;
}

// ---- 流式 SSE 事件 ----
export interface ResponsesStreamEvent {
  type: string;
  sequence_number: number;
  [k: string]: unknown;
}
