# codex2kimi 设计文档

日期：2026-06-10
状态：已确认，待实现计划

## 目标

做一个本地 HTTP 代理：把 Codex（OpenAI Responses API 格式）的请求转换为 Anthropic Messages 格式，转发给 Kimi code 的 Anthropic 兼容端点，并把回复转换回 Responses 格式返回给 Codex。所有发往 Kimi 的请求伪装成 Claude Code（注入特定 User-Agent）。支持 SSE 流式、工具调用、多模态（图片）。

## 已确认的需求与约束

| 项 | 决策 |
|---|---|
| 语言/运行时 | Node.js + TypeScript |
| 运行形态 | 本地 HTTP 代理服务，Codex 把 `/v1/responses` 打过来 |
| 输入格式 | OpenAI Responses API（`input` 数组 + 多种 item 类型） |
| 上游 | Kimi code：`https://api.kimi.com/coding/`，认证 `x-api-key`（即 `ANTHROPIC_API_KEY`），上下文窗口 262144 |
| 伪装 | User-Agent 固定为 `claude-cli/2.1.150 (external, cli)` |
| 模型名 | 丢弃 Codex 的 model，固定填一个可配置的 claude 模型名 |
| 能力 | SSE 流式、工具调用、多模态（图片） |
| 验证 | 全面集成测试 + 录制回放 |
| 部署 | macOS LaunchAgent；API Key 通过权限 600 的配置文件注入 |
| HTTP 框架 | Hono（轻量、SSE 友好） |
| 架构 | Responses ⇄ Anthropic 直连映射，不引入 Chat Completions 中间层 |

## 参考实现

`refers/litellm-1.88.1` 中的直连适配器是主要参照（Python，我们用 TS 重写语义）：

- `litellm/llms/anthropic/experimental_pass_through/responses_adapters/transformation.py`（518 行）：Responses ⇄ Anthropic 直接映射，开头给出了映射表。我们方向取反。
- `litellm/llms/anthropic/experimental_pass_through/responses_adapters/streaming_iterator.py`：Anthropic SSE → Responses SSE 的事件映射。
- `litellm/llms/anthropic/chat/transformation.py`：Anthropic Messages 字段细节。

明确**否定** litellm 通用网关的"Responses → Chat Completions 中枢 → provider"双跳架构：我们只有一对源/目标格式，双跳会经过两次有损转换，属于过度设计。

## 架构总览

一个本地 HTTP 服务，核心只有一条路由 `POST /v1/responses`。分四层，传输与转换解耦：

```
Codex ──/v1/responses(OpenAI Responses)──▶ [HTTP层 Hono]
                                              │
                                    [请求转换 纯函数]  Responses → Anthropic Messages
                                              │
                                    [上游客户端 fetch] ──x-api-key + 伪装头──▶ Kimi (api.kimi.com/coding/)
                                              │
                                    [响应转换]  Anthropic → Responses
                                       ├─ 非流式：整体转换
                                       └─ 流式：SSE 事件流逐事件转换
                                              │
Codex ◀──────────── Responses(JSON 或 SSE) ──┘
```

## 模块边界

每个模块单一职责、可独立测试。

| 模块 | 职责 | 依赖 |
|---|---|---|
| `src/server.ts` | Hono app、路由、装配各层 | config, translate/*, upstream |
| `src/config.ts` | 读配置文件 + 环境变量：端口、`ANTHROPIC_BASE_URL`(默认 `https://api.kimi.com/coding/`)、`ANTHROPIC_API_KEY`、固定 claude 模型名、User-Agent | 无 |
| `src/translate/request.ts` | 纯函数：Responses 请求 → Anthropic 请求 | types |
| `src/translate/response.ts` | 纯函数：Anthropic 非流式响应 → Responses 响应 | types |
| `src/translate/stream.ts` | Anthropic SSE 事件 → Responses SSE 事件（转换器/生成器） | types, sse |
| `src/upstream.ts` | 向 Kimi 发请求，注入伪装头，返回 JSON 或字节流 | config |
| `src/sse.ts` | SSE 解析与序列化工具 | 无 |
| `src/types/` | Responses API 与 Anthropic Messages 的 TS 类型 | 无 |

## 数据流

- **非流式**（`stream:false`）：转换请求 → fetch 拿到完整 Anthropic JSON → `response.ts` 整体转换 → 返回 JSON。
- **流式**（`stream:true`，Codex 默认）：转换请求 → fetch 拿到 Anthropic SSE 字节流 → `sse.ts` 切帧 → `stream.ts` 把每个 Anthropic 事件转成 Responses 事件并写出 → Codex 实时消费。

## 核心映射表

### 请求：Responses.input → Anthropic.messages

| Responses item | Anthropic |
|---|---|
| `message` role=user + `input_text` | user message, `text` block |
| `input_image`(image_url / dataURI) | user message, `image` block（base64 或 url source）|
| `function_call`(assistant 发起) | assistant message, `tool_use` block |
| `function_call_output` | user message, `tool_result` block |
| `message` role=assistant + `output_text` | assistant message, `text` block |
| 顶层 `instructions` | Anthropic `system` |
| `tools`(Responses 扁平 schema) | Anthropic `tools`(name/description/input_schema) |
| `tool_choice` | Anthropic `tool_choice` |
| `model` | 丢弃，固定填配置里的 claude 模型名 |
| `max_output_tokens` | `max_tokens`（缺省给默认值） |

### 响应：Anthropic → Responses（含 SSE 事件）

| Anthropic SSE | Responses SSE |
|---|---|
| `message_start` | `response.created`（+ `response.in_progress`）|
| `content_block_start`(text) | `response.output_item.added`(message)|
| `content_block_delta`/`text_delta` | `response.output_text.delta` |
| `content_block_start`(tool_use) | `response.output_item.added`(function_call)|
| `content_block_delta`/`input_json_delta` | `response.function_call_arguments.delta` |
| `content_block_delta`/`thinking_delta` | `response.reasoning_summary_text.delta` |
| `content_block_stop` | `response.output_item.done` |
| `message_delta`(stop_reason, usage) | 累积到最终 |
| `message_stop` | `response.completed`（带完整 output + usage）|
| 上游 error 事件 | `response.failed` / `response.incomplete` |

## 伪装与请求头

向 Kimi 发的每个请求注入：

- `User-Agent: claude-cli/2.1.150 (external, cli)`
- `x-api-key: <ANTHROPIC_API_KEY>`
- `anthropic-version: 2023-06-01`
- 视需要补 `anthropic-beta` / `x-app: cli` 等 Claude Code 常见头（联调时按真实抓包对齐）。

## 错误处理

- 缺 `ANTHROPIC_API_KEY` → 启动即报错退出。
- 输入 JSON 解析失败 / 必填字段缺失 → 返回 Responses 风格的 400 错误体。
- 上游非 2xx → 把 Anthropic 错误体映射成 Responses 错误格式，透传状态码。
- 流式中途上游报错 → 发 `response.failed` 事件后关闭流，避免 Codex 卡死。

## 测试

- **录制回放**：用真实 Kimi 端点抓一组 Anthropic 响应（纯文本、工具调用、多模态、流式 SSE）存为 fixtures；单测让 fixtures 过转换层，断言输出符合 Responses 规范。fixtures 让测试可离线、可回归。
- **集成测试**：起本地代理，用真实 Codex 配置（base URL 指向本代理）跑通文本、工具调用、图片三类场景，验证端到端。
- 测试栈：`vitest`（单测/录制回放）+ 一份联调 runbook（真实 Codex+Kimi）。

## 工程与命令

- 构建/运行：`tsx`（开发热跑）+ `tsc`（类型检查/产物）。
- `package.json` 脚本：`dev`(tsx watch)、`build`(tsc)、`start`(node dist/server.js)、`test`(vitest)、`typecheck`。
- 入口：起服务后，Codex 把 provider base URL 指到 `http://localhost:<port>`。

## 部署：macOS 系统服务（LaunchAgent）

采用 per-user LaunchAgent（无需 root，登录自启，可访问用户环境）。

- `deploy/com.codex2kimi.proxy.plist`：
  - `ProgramArguments` 用 `node dist/server.js`（跑编译产物，不依赖 tsx）。
  - `RunAtLoad=true`、`KeepAlive=true`（崩溃自动拉起）。
  - `StandardOutPath`/`StandardErrorPath` 日志写到 `~/Library/Logs/codex2kimi.log`。
- `deploy/install.sh`：`build` → 生成/拷贝 plist 到 `~/Library/LaunchAgents/` → `launchctl bootstrap gui/$UID` 启动。
- `deploy/uninstall.sh`：`launchctl bootout` + 删除 plist。
- README 写明管理命令：`launchctl kickstart -k`（重启）、`launchctl print`（查状态）。

### API Key 注入（方式 2：配置文件）

- 服务从 `~/.config/codex2kimi/config.json`（权限 600）读取 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`、端口、claude 模型名等。
- Key 不写进 plist，集中管理。
- `config.ts` 同时支持环境变量覆盖（便于开发与测试）。

## 非目标（YAGNI）

- 不支持除 Responses API 外的 OpenAI 端点（如 `/v1/chat/completions`）。
- 不引入 Chat Completions 中间表示层。
- 不做多 provider/多上游路由（只对接 Kimi）。
- 不做鉴权/多用户（本地单用户代理）。
