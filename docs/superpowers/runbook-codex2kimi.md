# codex2kimi 联调 runbook

前置：`~/.config/codex2kimi/config.json` 配好 `anthropicApiKey` 与 `model`（确认 Kimi 接受的 claude 模型名）。

## 启动
- 开发：`npm run dev`
- 产物：`npm run build && npm start`

## 自动化集成测试（打真实 Kimi）
- `CODEX2KIMI_INTEGRATION=1 npm run test:integration`

## 手动六条路径
按顺序逐条 `curl http://127.0.0.1:8787/v1/responses`，每条记录命令与输出：

1. 纯文本（非流式）：`stream:false` + 一条 input_text，断言 `status:"completed"`。
2. 纯文本（流式）：`stream:true`，确认收到 `response.created`→`output_text.delta`→`response.completed`。
3. 单工具调用：带 `tools`，提示模型调用，确认 `response.output_item.added(function_call)` + `function_call_arguments.delta/done`。
4. 工具回环：把上一步的 `function_call` + 自造 `function_call_output` 一起回传，确认模型据结果续答。
5. 图片：input_image（先用 https URL，若 Kimi 拒绝再用 dataURI base64），确认能识图。
6. 流式中断：中途断开客户端，确认服务发 `response.incomplete` 并清理上游连接。

## 能力确认清单（联调后回填到设计文档已知限制）
- [ ] Kimi 接受的 claude 模型名：______
- [ ] image source 支持 url / 仅 base64：______
- [ ] thinking 参数是否被接受：______
- [ ] text.format 结构化输出支持度：______
- [ ] 需要补的伪装头（anthropic-beta / x-app 等）：______

## Codex 接入
把 Codex 的 provider base URL 指向 `http://127.0.0.1:8787`。
