# 设计评审：codex2kimi

评审对象：`docs/superpowers/specs/2026-06-10-codex2kimi-design.md`  
评审日期：2026-06-10  
评审结论：**方向正确、边界清晰，可作为实现基础；但 SSE 事件映射与请求字段覆盖明显不完整，需在实现计划阶段补齐，否则 Codex 联调大概率会在流式首包或工具回环阶段失败。**

---

## 总体评价

文档结构清楚：目标 → 约束 → 参考实现 → 架构 → 模块 → 映射表 → 运维，阅读路径合理。核心决策（直连映射、不引入 Chat Completions 中间层、Hono + 纯函数转换层、录制回放测试）与问题域匹配，工程上可行。

主要风险不在架构选型，而在 **Responses API 协议细节的覆盖度**。对照 `refers/litellm-1.88.1` 中的参考实现及 OpenAI Responses 流式事件序列，当前映射表偏「骨架级」，缺少若干 Codex 消费端依赖的事件与请求字段。参考实现本身方向也与文档描述有一处不一致，实现时需以代码为准做反向推导，不能只看注释。

---

## 优点

1. **架构简洁**：四层拆分（HTTP / 请求转换 / 上游 / 响应转换）职责单一，利于单测与录制回放。
2. **参考选型准确**：锁定 litellm `experimental_pass_through/responses_adapters` 而非通用网关双跳，避免两次有损转换，符合 YAGNI。
3. **测试策略务实**：fixtures 离线回归 + 真实 Codex 端到端联调，对协议转换类项目是必要的。
4. **部署方案可落地**：LaunchAgent per-user、API Key 不进 plist、配置文件权限 600，符合 macOS 本地单用户代理场景。
5. **非目标明确**：不支持 Chat Completions、不做多 provider、不做鉴权，有效控制范围蔓延。

---

## 问题与建议

### 严重（实现前必须补齐）

#### 1. SSE 事件映射不完整

文档中的响应映射表遗漏了 Codex / Responses API 流式消费所依赖的若干事件。对照 litellm `responses/litellm_completion_transformation/streaming_iterator.py` 与 `tests/llm_responses_api_testing/test_openai_responses_api.py`，**文本流**的典型序列为：

```
response.created
→ response.in_progress
→ response.output_item.added (message)
→ response.content_part.added (output_text)    ← 文档未列出
→ response.output_text.delta
→ response.output_text.done                    ← 文档未列出
→ response.output_item.done
→ response.completed
```

当前文档只写到 `output_item.added` 与 `output_text.delta`，缺少 `content_part.added` 和 `output_text.done`。litellm 测试明确断言：message 类型 item 在 `output_item.added` 之后必须紧跟 `content_part.added`（`test_litellm_completion_responses.py` 中有专门用例）。

**建议**：在 `stream.ts` 设计里显式维护状态机，至少跟踪 `response_id`、`item_id`、`output_index`、`content_index`、`sequence_number`，并按上述顺序发事件。`response.created` / `response.in_progress` 的 `response` 对象需携带完整骨架字段（`object`、`status`、`model`、`output:[]`、`parallel_tool_calls` 等），可参考 litellm `create_response_created_event()` 中的默认结构。

#### 2. reasoning / thinking 流式映射不全

文档仅映射 `thinking_delta → response.reasoning_summary_text.delta`，但缺少：

| Anthropic | Responses（缺失） |
|---|---|
| `content_block_start`(thinking) | `response.output_item.added`(type=`reasoning`) |
| `content_block_stop`(thinking) | `response.output_item.done` |
| （可选）reasoning 汇总 | `response.reasoning_summary_text.done` 等收尾事件 |

litellm 反向适配器（`streaming_iterator.py`）在 Responses→Anthropic 方向对 reasoning item 有完整处理；本项目取反时应一并覆盖，否则 Codex 若开启 reasoning 会在首段 thinking 块卡住。

#### 3. 参考实现方向描述有误

文档第 31 行写 `streaming_iterator.py` 为「Anthropic SSE → Responses SSE 的事件映射」，但该文件 `AnthropicResponsesStreamWrapper` 的实际职责是 **Responses SSE → Anthropic SSE**（文件头注释："re-emits events in Anthropic SSE format"）。

`transformation.py` 虽含双向逻辑，但流式部分需以 `streaming_iterator.py` **反向**推导，不能按文档字面理解。建议在实现计划中单独开一节「反向流式状态机」，列出与 litellm 逐行对照的逆映射表，避免开发时误读参考代码。

#### 4. 请求侧字段覆盖不足

对照 `transformation.py` 的 `translate_request()`，以下 Codex 可能发出的字段未出现在设计映射表中：

| Responses 字段 | 建议处理 |
|---|---|
| `temperature` / `top_p` | 透传至 Anthropic |
| `reasoning` | 映射为 Anthropic `thinking`（effort ↔ budget 或 adaptive） |
| `parallel_tool_calls` | 记录并在 `response.created` 骨架中回显 |
| `text.format`（含 json_schema） | 映射为 Anthropic `output_format` |
| `user` / `metadata` | 映射为 Anthropic `metadata.user_id` |
| `truncation` / `store` / `previous_response_id` | 明确忽略或记录日志（Codex 是否发送需在联调确认） |

若不做透传，应写入「非目标」或「已知限制」，否则实现阶段会出现「部分请求静默丢参」的隐性 bug。

#### 5. `tool_choice` 反向映射需细化

litellm 正向映射为：`any→required`、`tool→function`、`auto→auto`。反向实现时需覆盖 Responses 侧 `required`、`none`、`{type:"function",name}` 等形态。Anthropic 侧 `none` 与 Kimi 是否支持需在联调 runbook 中验证。

#### 6. 连续 `user` 消息合并

`function_call_output` 在 Responses 中是顶层 item，映射为 Anthropic `tool_result` 后常与普通 `user` 文本落在同一 role。若拆成两条连续 `user` message，部分 Anthropic 兼容端会拒绝。litellm `compact.py` 中有显式合并逻辑。

**建议**：在 `translate/request.ts` 增加后处理步骤，合并相邻 `role=user` 消息的 content blocks。

#### 7. 非流式响应转换未定义

文档详述了流式映射，但 `response.ts` 的非流式 Anthropic JSON → Responses JSON 规则缺失，包括：

- `stop_reason`（`end_turn` / `tool_use` / `max_tokens`）→ `status` / `incomplete_details`
- `content[]` 中 `text` / `tool_use` / `thinking` → `output[]` 的 `message` / `function_call` / `reasoning`
- `usage` 字段对齐（含 cache token 字段是否透传）

应补充与非流式对称的映射表，或明确 v1 仅保证流式、非流式 best-effort。

---

### 中等（建议在实现计划中处理）

#### 8. 安全：监听地址未约束

文档写 Codex 指向 `http://localhost:<port>`，但未要求服务 **仅绑定 `127.0.0.1`**。若默认 `0.0.0.0`，同网段其他机器可无鉴权调用代理，间接滥用 API Key。

**建议**：`config.ts` 默认 `host: "127.0.0.1"`，并在 README 中警告勿暴露到公网。

#### 9. 上游 HTTP 客户端行为未定义

缺少以下约定：

- 请求超时与 abort（Codex 断连时是否取消 Kimi 请求）
- 上游非 SSE 却返回 JSON 错误时的 Content-Type 判断
- `stream:true` 时向上游传 `stream: true` 及 Anthropic 要求的 `anthropic-version`（文档已列，但需在 `upstream.ts` 契约中写死）
- Anthropic `ping` 事件：应吞掉或原样转发，需明确策略

#### 10. 错误体格式未具体化

「返回 Responses 风格的 400 错误体」过于笼统。Codex 对错误 JSON 的 `type` / `message` / `code` 字段是否有固定预期，建议在联调 runbook 中抓一条真实错误响应作为 golden fixture。

流式 `response.failed` 与 `response.incomplete` 的触发条件（上游 4xx/5xx、JSON 解析失败、中途断流）应分列，避免一律映射为 `failed`。

#### 11. 部署细节缺口

`deploy/com.codex2kimi.proxy.plist` 描述缺少：

- `WorkingDirectory`（否则相对路径 `dist/server.js` 可能找不到）
- Node 可执行文件绝对路径（LaunchAgent 环境 PATH 极简，`node` 常不在 PATH 中）
- `KeepAlive=true` 遇配置错误（如缺 API Key）会无限重启 — 建议启动校验失败时 `exit 1` 且文档说明用 `launchctl print` 排错，或改用 `KeepAlive.SuccessfulExit=false` 等更精细策略
- 日志轮转：`~/Library/Logs/codex2kimi.log` 无上限会持续增长

#### 12. 默认值未指定

- `max_output_tokens` 缺省时的默认值（Anthropic 必填 `max_tokens`）
- 固定 claude 模型名的推荐默认值（联调 Kimi 时用哪个 model string）
- 默认端口

这些应进入 `config.ts` 规范，避免实现者各自假设。

#### 13. 测试策略可再具体

- fixtures 录制：建议约定目录结构（如 `fixtures/anthropic/{text,tools,image,stream}/`）及脱敏规则（API Key、user 内容）
- 集成测试：依赖真实 Codex + Kimi，建议标记 `vitest` 的 `test.integration.ts` + 环境变量门控，避免 CI 默认失败
- 建议增加 **Codex 真实 SSE 录制** 作为输入 fixture（不仅录 Anthropic 上游），验证「Codex 发出的 Responses 请求」能被正确翻译

---

### 轻微（可后续迭代）

| 项 | 说明 |
|---|---|
| 健康检查 | `GET /health` 便于 LaunchAgent / 手动探活，非必须 |
| Node 版本 | 建议写明 `engines.node`（如 `>=20`） |
| 优雅退出 | SIGTERM 时关闭进行中的 SSE 连接 |
| `web_search` 类 tools | litellm 对 `web_search_preview` 有特殊处理；若 Codex 不发可列入非目标 |
| 可观测性 | 结构化日志（request_id、耗时、token usage）对联调很有帮助 |

---

## 结构与术语

| 维度 | 评价 |
|---|---|
| 结构清晰度 | 良好，模块表与数据流足以指导分工 |
| 逻辑一致性 | 整体一致；流式映射表与参考实现方向存在上述偏差 |
| 术语准确性 | Responses / Anthropic 术语基本正确；`streaming_iterator.py` 方向描述需修正 |
| 需求完整性 | 主路径覆盖够；协议细节与边界条件不足 |
| 可行性 | 技术栈与人力规模匹配，2–4 天可出 MVP（若映射表补齐） |

---

## 可行性判断

**可以实现**，且当前架构不需要推翻重来。工作量主要集中在：

1. **`stream.ts` 反向状态机**（预计占实现 40%+）：比 `request.ts` / `response.ts` 复杂一个数量级。
2. **联调抓包对齐伪装头**：`anthropic-beta`、`x-app` 等需以真实 Claude Code 流量为准，文档已预留，做法正确。
3. **测试 fixtures**：有 litellm 可对照，能降低回归成本。

不建议在 v1 引入 Chat Completions 层或通用网关，现有取舍合理。

---

## 建议在实现计划中优先落地的条目

按优先级排序，供下一份 implementation plan 直接引用：

1. 补全 **SSE 事件全表**（含 `content_part.added`、`output_text.done`、`sequence_number`、reasoning item 起止）。
2. 补全 **请求字段透传表** 与 **非流式响应映射表**。
3. 明确 `translate/request.ts` 的 **相邻 user 消息合并** 规则。
4. `config` 增加 `host: 127.0.0.1` 及各项默认值。
5. 修正文档中对 `streaming_iterator.py` 方向的描述，并建立「litellm 正向 → 本项目反向」对照清单。
6. 部署 plist 补 `WorkingDirectory` 与 Node 绝对路径；文档补充崩溃循环排障步骤。
7. 联调 runbook：至少覆盖文本、单工具调用、工具回环、图片、流式中断五条路径。

---

## 评审摘要

| 级别 | 数量 | 代表项 |
|---|---|---|
| 严重 | 7 | SSE 事件不全、参考方向误读、请求字段缺失、非流式未定义 |
| 中等 | 6 | 绑定地址、上游超时、部署 plist、默认值、测试门控 |
| 轻微 | 5 | 健康检查、Node 版本、日志轮转等 |

**结论**：批准以此文档进入实现计划阶段，但实现计划必须先把本节「严重」项转化为具体任务与验收标准（建议以 litellm 测试用例 + Codex 实机流式抓包为验收依据）。否则 MVP 可能在「能起服务」但「Codex 流式卡住」的状态下浪费联调时间。
