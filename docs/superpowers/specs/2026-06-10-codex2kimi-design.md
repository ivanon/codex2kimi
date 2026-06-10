# codex2kimi 设计文档

日期：2026-06-10
状态：已确认，待实现计划（已纳入 cursor 评审 `2026-06-10-codex2kimi-design.review.md` 的修订）

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
- `litellm/llms/anthropic/experimental_pass_through/responses_adapters/streaming_iterator.py`：**方向修正** —— 该文件 `AnthropicResponsesStreamWrapper` 实际是 **Responses SSE → Anthropic SSE**（文件头注释 "re-emits events in Anthropic SSE format"）。我们要的是相反方向，实现时按它**逐行反向推导**，不能按字面照搬。
- `litellm/responses/litellm_completion_transformation/streaming_iterator.py`：Responses 流式事件序列的权威来源（含 `content_part.added` / `output_text.done` / `sequence_number` 等骨架），用于校准我们发给 Codex 的事件顺序。
- `litellm/llms/anthropic/chat/transformation.py`：Anthropic Messages 字段细节。

> 实现计划须单独开一节「litellm 正向 → 本项目反向」对照清单，避免误读参考代码。

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
| `src/config.ts` | 读配置文件 + 环境变量（见下方默认值表） | 无 |
| `src/translate/request.ts` | 纯函数：Responses 请求 → Anthropic 请求 | types |
| `src/translate/response.ts` | 纯函数：Anthropic 非流式响应 → Responses 响应 | types |
| `src/translate/stream.ts` | Anthropic SSE → Responses SSE，**有状态机**（维护 `response_id`/`item_id`/`output_index`/`content_index`/`sequence_number`，补全 `content_part.added`、`output_text.done` 等事件） | types, sse |
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
| `tool_choice` | Anthropic `tool_choice`（见下表逆映射） |
| `model` | 丢弃，固定填配置里的 claude 模型名 |
| `max_output_tokens` | `max_tokens`（缺省给默认值，见配置节） |
| `temperature` / `top_p` | 透传 |
| `reasoning`（effort） | 映射为 Anthropic `thinking`（effort ↔ budget_tokens 或 adaptive；`none` 则不带 thinking） |
| `parallel_tool_calls` | 记录，并在 `response.created` 骨架中回显 |
| `text.format`（含 json_schema） | 映射为 Anthropic 结构化输出约束（`output_format`/工具约束，联调确认 Kimi 支持度） |
| `user` / `metadata` | 映射为 Anthropic `metadata.user_id` |
| `truncation` / `store` / `previous_response_id` | 明确忽略（写入「已知限制」），联调确认 Codex 是否发送 |

**`tool_choice` 逆映射（Responses → Anthropic）：**

| Responses | Anthropic |
|---|---|
| `auto` | `{type:"auto"}` |
| `required` | `{type:"any"}` |
| `none` | 不带 tools 或 `{type:"none"}`（联调确认 Kimi 支持） |
| `{type:"function", name}` | `{type:"tool", name}` |

**相邻消息合并（关键）：** `function_call_output` 在 Responses 里是顶层 item，转成 Anthropic `tool_result` 后属于 `user` role。若它与普通 user 文本拆成两条连续 `role=user` message，部分 Anthropic 端会拒绝。`request.ts` 需有后处理步骤：**合并相邻同 role 消息的 content blocks**（参照 litellm `compact.py`）。

### 响应（流式）：Anthropic SSE → Responses SSE

`stream.ts` 必须维护**状态机**，跟踪：`response_id`、`item_id`、`output_index`、`content_index`、`sequence_number`（每个发出的事件单调递增）。`response.created` / `response.in_progress` 的 `response` 对象需携带完整骨架字段（`object`、`status`、`model`、`output:[]`、`parallel_tool_calls`、`usage` 占位等，参照 litellm `create_response_created_event()`）。

**文本块的完整事件序列**（Codex 消费端依赖，缺一不可）：

```
response.created
→ response.in_progress
→ response.output_item.added (message)
→ response.content_part.added (output_text)     ← 必须，紧跟 output_item.added
→ response.output_text.delta (多次)
→ response.output_text.done                      ← 必须，块结束时
→ response.output_item.done
→ response.completed
```

**事件映射表：**

| Anthropic SSE | Responses SSE |
|---|---|
| `message_start` | `response.created` + `response.in_progress` |
| `content_block_start`(text) | `response.output_item.added`(message) + `response.content_part.added`(output_text) |
| `content_block_delta`/`text_delta` | `response.output_text.delta` |
| `content_block_stop`(text) | `response.output_text.done` + `response.output_item.done` |
| `content_block_start`(tool_use) | `response.output_item.added`(function_call) |
| `content_block_delta`/`input_json_delta` | `response.function_call_arguments.delta` |
| `content_block_stop`(tool_use) | `response.function_call_arguments.done` + `response.output_item.done` |
| `content_block_start`(thinking) | `response.output_item.added`(reasoning) |
| `content_block_delta`/`thinking_delta` | `response.reasoning_summary_text.delta` |
| `content_block_stop`(thinking) | `response.reasoning_summary_text.done` + `response.output_item.done` |
| `message_delta`(stop_reason, usage) | 累积到最终 |
| `message_stop` | `response.completed`（带完整 output + usage）|
| `ping` | 吞掉（不转发，见上游契约） |
| 上游 error 事件 | `response.failed` / `response.incomplete`（见错误处理） |

### 响应（非流式）：Anthropic JSON → Responses JSON

`response.ts` 规则：

| Anthropic | Responses |
|---|---|
| `content[]` 的 `text` 块 | `output[]` 的 `message`(role=assistant, `output_text`) |
| `content[]` 的 `tool_use` 块 | `output[]` 的 `function_call`(name, arguments, call_id) |
| `content[]` 的 `thinking` 块 | `output[]` 的 `reasoning` |
| `stop_reason=end_turn` | `status="completed"` |
| `stop_reason=tool_use` | `status="completed"`（带 function_call output） |
| `stop_reason=max_tokens` | `status="incomplete"` + `incomplete_details={reason:"max_output_tokens"}` |
| `usage`（input/output tokens，含 cache 字段） | Responses `usage`（对齐字段，cache token 尽量透传） |

## 伪装与请求头

向 Kimi 发的每个请求注入：

- `User-Agent: claude-cli/2.1.150 (external, cli)`
- `x-api-key: <ANTHROPIC_API_KEY>`
- `anthropic-version: 2023-06-01`
- 视需要补 `anthropic-beta` / `x-app: cli` 等 Claude Code 常见头（联调时按真实抓包对齐）。

## 上游 HTTP 客户端契约（`upstream.ts`）

- 固定注入伪装头（见下节）；`stream:true` 时向上游传 `stream:true`。
- 请求超时与 abort：Codex 断连时取消对 Kimi 的请求（透传 `AbortSignal`）。
- 响应 Content-Type 判断：上游可能在 `stream:true` 下仍返回 JSON 错误体，需按 Content-Type 分流（SSE vs JSON error）。
- Anthropic `ping` 事件：吞掉，不转发给 Codex。

## 错误处理

- 缺 `ANTHROPIC_API_KEY` → 启动即报错 `exit 1`（避免 LaunchAgent 反复无效重启，见部署节）。
- 输入 JSON 解析失败 / 必填字段缺失 → 返回 Responses 风格 400 错误体（`{error:{type,message,code}}`，字段以真实 Codex 期望为准，联调抓一条 golden fixture）。
- 上游非 2xx → 把 Anthropic 错误体映射成 Responses 错误格式，透传状态码。
- 流式错误按来源分列，不一律映射为 failed：
  - 上游 4xx/5xx、JSON 解析失败 → `response.failed`。
  - 中途断流 / Codex abort → `response.incomplete`。
  - 发完终止事件后关闭流，避免 Codex 卡死。

## 测试

- **录制回放**：用真实 Kimi 端点抓一组 Anthropic 响应（纯文本、工具调用、多模态、流式 SSE）存为 fixtures；单测让 fixtures 过转换层，断言输出符合 Responses 规范。
  - fixtures 目录约定：`fixtures/anthropic/{text,tools,image,stream}/`。
  - 同时录 **Codex 真实发出的 Responses 请求** 作为输入 fixture（`fixtures/responses/`），验证请求翻译方向。
  - 脱敏规则：录制时剥离 API Key、用户内容中的敏感数据。
- **集成测试**：起本地代理，用真实 Codex 配置（base URL 指向本代理）跑通文本、工具调用、图片三类场景。标记为 `*.integration.test.ts`，用环境变量门控，避免 CI 默认失败。
- 测试栈：`vitest` + 一份联调 runbook，至少覆盖：文本、单工具调用、**工具回环**、图片、流式中断五条路径。

## 其他（迭代项）

- `GET /health` 健康检查，便于 LaunchAgent / 手动探活。
- `package.json` 写明 `engines.node`（`>=20`，因依赖内置 `fetch`）。
- SIGTERM 优雅退出：关闭进行中的 SSE 连接。
- 结构化日志（request_id、耗时、token usage），联调期很有帮助。
- `web_search` 类内置 tools：若 Codex 不发，列入非目标。

## 配置（`config.ts` 规范）

配置文件 `~/.config/codex2kimi/config.json`（权限 600），环境变量可覆盖。默认值：

| 键 | 默认值 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | **仅绑回环**，禁止 `0.0.0.0`，README 警告勿暴露公网 |
| `port` | `8787` | 本地监听端口 |
| `anthropicBaseUrl` | `https://api.kimi.com/coding/` | Kimi 上游 |
| `anthropicApiKey` | （必填，缺则 `exit 1`） | 注入 `x-api-key` |
| `model` | 待联调确认（一个 claude 模型名 string） | 固定填给上游 |
| `maxTokensDefault` | `8192` | Codex 未给 `max_output_tokens` 时的 Anthropic `max_tokens` |
| `userAgent` | `claude-cli/2.1.150 (external, cli)` | 伪装头 |

## 工程与命令

- 构建/运行：`tsx`（开发热跑）+ `tsc`（类型检查/产物）。
- `package.json` 脚本：`dev`(tsx watch)、`build`(tsc)、`start`(node dist/server.js)、`test`(vitest)、`typecheck`。
- 入口：起服务后，Codex 把 provider base URL 指到 `http://localhost:<port>`。

## 部署：macOS 系统服务（LaunchAgent）

采用 per-user LaunchAgent（无需 root，登录自启，可访问用户环境）。

- `deploy/com.codex2kimi.proxy.plist`：
  - `ProgramArguments` 用 **node 绝对路径** + `dist/server.js`（LaunchAgent 的 PATH 极简，`node` 通常不在 PATH；install.sh 用 `which node` 解析后写入）。
  - `WorkingDirectory` 设为项目目录（否则相对路径找不到 `dist/server.js`）。
  - `RunAtLoad=true`。`KeepAlive` 用 `{SuccessfulExit:false}`：仅在非正常退出时重启；配置错误导致的 `exit 1`（如缺 API Key）不会无限重启。
  - `StandardOutPath`/`StandardErrorPath` 日志写到 `~/Library/Logs/codex2kimi.log`；日志轮转交给 macOS `newsyslog` 或文档提示手动清理（避免无上限增长）。
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

### 已知限制

- `truncation` / `store` / `previous_response_id` 不实现（忽略，必要时记日志）；是否影响 Codex 待联调确认。
- `text.format` 结构化输出依赖 Kimi 上游支持度，联调确认。
- v1 主力保证流式路径；非流式按 `response.ts` 表实现，best-effort。
